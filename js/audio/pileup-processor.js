// AudioWorklet processor: synthesises the pileup as a complex I/Q stream, then
// receives it through a real DSP chain (tune -> decimate -> filter -> AGC).
// Self-contained: AudioWorklet global scope has no module imports.

const SAMPLE_RATE = 48000;
const FFT_SIZE = 2048;
const HOP = 480;
const DECIM = 4;
const NOISE_SIGMA = 0.01;
const REF_BW = 500; // SNR reference bandwidth
const MAX_ACTIVE_TX = 256;
const ENV_TAU = 0.0015; // key envelope time constant (click shaping)
const TX_BURST_GAP = 0.8; // messages closer than this stay one transmission

/* ---------- FFT ---------- */

class FFT {
  constructor(n) {
    this.n = n;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    this.rev = new Uint16Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  transform(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cos[k];
          const s = sin[k];
          const tr = re[j + half] * c - im[j + half] * s;
          const ti = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tr;
          im[j + half] = im[j] - ti;
          re[j] += tr;
          im[j] += ti;
        }
      }
    }
  }
}

/* ---------- FIR design ---------- */

function designLowpass(numTaps, cutoffNorm) {
  const h = new Float32Array(numTaps);
  const m = (numTaps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < numTaps; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * cutoffNorm : Math.sin(2 * Math.PI * cutoffNorm * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (numTaps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < numTaps; i++) h[i] /= sum;
  return h;
}

class ComplexFir {
  constructor(taps) {
    this.setTaps(taps);
  }

  setTaps(taps) {
    this.h = taps;
    const n = taps.length;
    if (!this.bufI || this.bufI.length !== n) {
      this.bufI = new Float32Array(n);
      this.bufQ = new Float32Array(n);
      this.pos = 0;
    }
  }

  push(i, q) {
    this.bufI[this.pos] = i;
    this.bufQ[this.pos] = q;
    this.pos = this.pos + 1 === this.h.length ? 0 : this.pos + 1;
  }

  // Valid only right after push(); evaluates the FIR at the current instant.
  outI() {
    const { h, bufI, pos } = this;
    const n = h.length;
    let acc = 0;
    let k = pos;
    for (let t = n - 1; t >= 0; t--) {
      acc += h[t] * bufI[k];
      k = k + 1 === n ? 0 : k + 1;
    }
    return acc;
  }

  outQ() {
    const { h, bufQ, pos } = this;
    const n = h.length;
    let acc = 0;
    let k = pos;
    for (let t = n - 1; t >= 0; t--) {
      acc += h[t] * bufQ[k];
      k = k + 1 === n ? 0 : k + 1;
    }
    return acc;
  }
}

/* ---------- Processor ---------- */

class PileupProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.running = false;
    this.renormCount = 0;
    this.slots = new Map();

    this.rxFreq = 2000;
    this.bandwidth = 500;
    this.pitch = 600;
    this.afGain = 0.7;
    this.sidetoneGain = 0.35;

    this.loPhaseR = 1;
    this.loPhaseI = 0;
    this.pitchPhaseR = 1;
    this.pitchPhaseI = 0;

    this.decFir = new ComplexFir(designLowpass(63, 2600 / SAMPLE_RATE));
    this.decCount = 0;
    this.chanFir = new ComplexFir(designLowpass(255, 250 / (SAMPLE_RATE / DECIM)));
    this.updateChannelFilter();

    this.prevI = 0;
    this.prevQ = 0;
    this.curI = 0;
    this.curQ = 0;

    this.agcEnv = 1e-4;
    this.agcGain = 1;
    this.rxDuck = 1;

    // Transmit window. The receiver stays blanked for the whole of it,
    // including the key-up gaps between characters.
    this.txStart = 0;
    this.txEnd = 0;
    this.txWasOn = false;

    this.fft = new FFT(FFT_SIZE);
    this.fftRe = new Float32Array(FFT_SIZE);
    this.fftIm = new Float32Array(FFT_SIZE);
    this.ringI = new Float32Array(FFT_SIZE);
    this.ringQ = new Float32Array(FFT_SIZE);
    this.ringPos = 0;
    this.sinceHop = 0;
    this.window = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    }
    this.noiseFloorDb = -60;

    this.gaussSpare = null;

    this.port.onmessage = (e) => this.handle(e.data);
  }

  handle(msg) {
    switch (msg.type) {
      case 'run':
        this.running = msg.value;
        if (!msg.value) {
          this.slots.clear();
          this.txStart = 0;
          this.txEnd = 0;
          this.txWasOn = false;
        }
        break;
      case 'rx':
        if (msg.freq !== undefined) this.rxFreq = msg.freq;
        if (msg.bandwidth !== undefined && msg.bandwidth !== this.bandwidth) {
          this.bandwidth = msg.bandwidth;
          this.updateChannelFilter();
        }
        break;
      case 'audio':
        if (msg.pitch !== undefined) this.pitch = msg.pitch;
        if (msg.afGain !== undefined) this.afGain = msg.afGain;
        if (msg.sidetoneGain !== undefined) this.sidetoneGain = msg.sidetoneGain;
        break;
      case 'tx':
        if (this.slots.size < MAX_ACTIVE_TX || msg.sidetone) {
          if (msg.sidetone) {
            let dur = 0;
            for (let i = 0; i < msg.durations.length; i++) dur += msg.durations[i];
            // A message queued back-to-back extends the current transmit window.
            if (msg.start > this.txEnd + TX_BURST_GAP) this.txStart = msg.start;
            this.txEnd = Math.max(this.txEnd, msg.start + dur);
          }
          this.slots.set(msg.id, {
            start: msg.start,
            freq: msg.freq,
            amp: msg.sidetone ? 1 : Math.sqrt((NOISE_SIGMA ** 2 * (REF_BW / SAMPLE_RATE)) * 10 ** (msg.snrDb / 10)),
            durations: msg.durations,
            sidetone: !!msg.sidetone,
            idx: 0,
            boundary: msg.durations.length ? msg.durations[0] : 0,
            elapsed: 0,
            env: 0,
            pr: 1,
            pi: 0,
          });
        }
        break;
      case 'cancel':
        this.slots.delete(msg.id);
        break;
      case 'cancelAll':
        for (const [id, s] of this.slots) if (s.sidetone === !!msg.sidetone) this.slots.delete(id);
        if (msg.sidetone) {
          this.txStart = 0;
          this.txEnd = 0;
        }
        break;
    }
  }

  updateChannelFilter() {
    const cutoff = Math.max(40, this.bandwidth / 2) / (SAMPLE_RATE / DECIM);
    this.chanFir.setTaps(designLowpass(255, Math.min(cutoff, 0.45)));
  }

  gauss() {
    if (this.gaussSpare !== null) {
      const v = this.gaussSpare;
      this.gaussSpare = null;
      return v;
    }
    let u;
    let v;
    let s;
    do {
      u = Math.random() * 2 - 1;
      v = Math.random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.gaussSpare = v * mul;
    return u * mul;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;

    if (!this.running) {
      out.fill(0);
      return true;
    }

    const t0 = currentFrame / sampleRate;
    const noiseScale = NOISE_SIGMA * Math.SQRT1_2;
    const dt = 1 / SAMPLE_RATE;

    // Local oscillator and pitch oscillator increments.
    const loW = (-2 * Math.PI * this.rxFreq) / SAMPLE_RATE;
    const loC = Math.cos(loW);
    const loS = Math.sin(loW);
    const pW = (2 * Math.PI * this.pitch) / SAMPLE_RATE;
    const pC = Math.cos(pW);
    const pS = Math.sin(pW);

    const envK = 1 - Math.exp(-1 / (ENV_TAU * SAMPLE_RATE));

    for (let s = 0; s < n; s++) {
      const now = t0 + s * dt;
      const txOn = now >= this.txStart && now < this.txEnd;
      if (this.txWasOn && !txOn) this.port.postMessage({ type: 'txgap' });
      this.txWasOn = txOn;

      // --- synthesise the band ---
      let bandI = this.gauss() * noiseScale;
      let bandQ = this.gauss() * noiseScale;
      let sidetoneSample = 0;

      for (const [id, slot] of this.slots) {
        if (now < slot.start) continue;

        if (slot.idx >= slot.durations.length) {
          if (slot.env < 1e-5) {
            this.slots.delete(id);
            continue;
          }
        } else {
          slot.elapsed = now - slot.start;
          while (slot.idx < slot.durations.length && slot.elapsed >= slot.boundary) {
            slot.idx++;
            if (slot.idx < slot.durations.length) slot.boundary += slot.durations[slot.idx];
          }
        }

        const keyDown = slot.idx < slot.durations.length && (slot.idx & 1) === 0;
        const target = keyDown ? 1 : 0;
        slot.env += (target - slot.env) * envK;

        if (slot.env < 1e-5 && !target) {
          slot.pr = 1;
          slot.pi = 0;
          continue;
        }

        if (slot.sidetone) {
          const w = (2 * Math.PI * this.pitch) / SAMPLE_RATE;
          const c = Math.cos(w);
          const sn = Math.sin(w);
          const nr = slot.pr * c - slot.pi * sn;
          slot.pi = slot.pr * sn + slot.pi * c;
          slot.pr = nr;
          sidetoneSample += slot.env * slot.pr;
        } else {
          if (slot.c === undefined || slot.wCached !== slot.freq) {
            const w = (2 * Math.PI * slot.freq) / SAMPLE_RATE;
            slot.c = Math.cos(w);
            slot.s = Math.sin(w);
            slot.wCached = slot.freq;
          }
          const nr = slot.pr * slot.c - slot.pi * slot.s;
          slot.pi = slot.pr * slot.s + slot.pi * slot.c;
          slot.pr = nr;
          const a = slot.amp * slot.env;
          bandI += a * slot.pr;
          bandQ += a * slot.pi;
        }
      }

      // --- waterfall tap (pre-tuning, full band) ---
      this.ringI[this.ringPos] = bandI;
      this.ringQ[this.ringPos] = bandQ;
      this.ringPos = this.ringPos + 1 === FFT_SIZE ? 0 : this.ringPos + 1;
      if (++this.sinceHop >= HOP) {
        this.sinceHop = 0;
        this.emitSpectrum(now, txOn);
      }

      // --- tune to RX frequency ---
      const nlr = this.loPhaseR * loC - this.loPhaseI * loS;
      this.loPhaseI = this.loPhaseR * loS + this.loPhaseI * loC;
      this.loPhaseR = nlr;
      const mixI = bandI * this.loPhaseR - bandQ * this.loPhaseI;
      const mixQ = bandI * this.loPhaseI + bandQ * this.loPhaseR;

      // --- decimating anti-alias FIR ---
      this.decFir.push(mixI, mixQ);
      if (++this.decCount >= DECIM) {
        this.decCount = 0;
        this.chanFir.push(this.decFir.outI(), this.decFir.outQ());
        this.prevI = this.curI;
        this.prevQ = this.curQ;
        this.curI = this.chanFir.outI();
        this.curQ = this.chanFir.outQ();
      }

      // --- linear interpolation back to 48 kHz ---
      const frac = (this.decCount + 1) / DECIM;
      const zi = this.prevI + (this.curI - this.prevI) * frac;
      const zq = this.prevQ + (this.curQ - this.prevQ) * frac;

      // --- shift to CW pitch, take the real part ---
      const npr = this.pitchPhaseR * pC - this.pitchPhaseI * pS;
      this.pitchPhaseI = this.pitchPhaseR * pS + this.pitchPhaseI * pC;
      this.pitchPhaseR = npr;
      let audio = zi * this.pitchPhaseR - zq * this.pitchPhaseI;

      // --- AGC ---
      const mag = Math.abs(audio);
      if (mag > this.agcEnv) this.agcEnv += (mag - this.agcEnv) * 0.01;
      else this.agcEnv += (mag - this.agcEnv) * 0.0002;
      const wanted = 0.25 / (this.agcEnv + 1e-7);
      this.agcGain += (Math.min(wanted, 4000) - this.agcGain) * 0.002;
      audio *= this.agcGain;

      // The receiver is deaf while the operator transmits.
      this.rxDuck += ((txOn ? 0 : 1) - this.rxDuck) * (txOn ? 0.02 : 0.004);

      out[s] = Math.max(-1, Math.min(1,
        audio * this.afGain * this.rxDuck + sidetoneSample * this.sidetoneGain));
    }

    // Keep the incremental rotators on the unit circle.
    if ((this.renormCount += n) >= SAMPLE_RATE) {
      this.renormCount = 0;
      let m = Math.hypot(this.loPhaseR, this.loPhaseI) || 1;
      this.loPhaseR /= m; this.loPhaseI /= m;
      m = Math.hypot(this.pitchPhaseR, this.pitchPhaseI) || 1;
      this.pitchPhaseR /= m; this.pitchPhaseI /= m;
      for (const slot of this.slots.values()) {
        m = Math.hypot(slot.pr, slot.pi) || 1;
        slot.pr /= m; slot.pi /= m;
      }
    }

    return true;
  }

  emitSpectrum(now, txOn) {
    // Deaf while transmitting: no columns at all, so the waterfall holds instead of scrolling.
    if (txOn) return;

    const { fftRe, fftIm, ringI, ringQ, ringPos, window } = this;
    for (let i = 0; i < FFT_SIZE; i++) {
      const k = (ringPos + i) % FFT_SIZE;
      const w = window[i];
      fftRe[i] = ringI[k] * w;
      fftIm[i] = ringQ[k] * w;
    }
    this.fft.transform(fftRe, fftIm);

    // fftshift into ascending frequency order, scale to 8-bit dB.
    const bins = new Uint8Array(FFT_SIZE);
    const half = FFT_SIZE / 2;
    const db = new Float32Array(FFT_SIZE);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < FFT_SIZE; i++) {
      const src = i < half ? i + half : i - half;
      const p = fftRe[src] * fftRe[src] + fftIm[src] * fftIm[src];
      const d = 10 * Math.log10(p + 1e-20);
      db[i] = d;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }

    // The noise floor is the 15th percentile: a crowded band must not pull it up.
    const nb = 64;
    const hist = this.hist || (this.hist = new Uint16Array(nb));
    hist.fill(0);
    const span = Math.max(1e-6, hi - lo);
    for (let i = 0; i < FFT_SIZE; i++) {
      let k = ((db[i] - lo) / span) * (nb - 1);
      hist[k < 0 ? 0 : k > nb - 1 ? nb - 1 : k | 0]++;
    }
    const want = FFT_SIZE * 0.15;
    let acc = 0;
    let pct = 0;
    for (let k = 0; k < nb; k++) {
      acc += hist[k];
      if (acc >= want) { pct = k; break; }
    }
    const floorEstimate = lo + (pct / (nb - 1)) * span;
    this.noiseFloorDb += (floorEstimate - this.noiseFloorDb) * 0.05;

    const floor = this.noiseFloorDb - 3;
    const range = 40;
    for (let i = 0; i < FFT_SIZE; i++) {
      const v = ((db[i] - floor) / range) * 255;
      bins[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
    this.port.postMessage({ type: 'spectrum', t: now, bins }, [bins.buffer]);
  }
}

registerProcessor('pileup-processor', PileupProcessor);
