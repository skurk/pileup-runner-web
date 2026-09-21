import { SAMPLE_RATE } from '../lib/config.js';

let nextTxId = 1;

/** Main-thread facade over the AudioWorklet DSP core. */
export class Radio {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.onSpectrum = null;
    this.onTxGap = null;
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    if (this.ctx.sampleRate !== SAMPLE_RATE) {
      console.warn(`Audio device runs at ${this.ctx.sampleRate} Hz; timing assumes ${SAMPLE_RATE} Hz.`);
    }
    await this.ctx.audioWorklet.addModule('js/audio/pileup-processor.js');
    this.node = new AudioWorkletNode(this.ctx, 'pileup-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'spectrum' && this.onSpectrum) this.onSpectrum(e.data);
      else if (e.data.type === 'txgap' && this.onTxGap) this.onTxGap();
    };
    this.node.connect(this.ctx.destination);
    this.ready = true;
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }

  get time() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  post(msg, transfer) {
    if (this.node) this.node.port.postMessage(msg, transfer || []);
  }

  setRunning(value) {
    this.post({ type: 'run', value });
  }

  setRx(freq, bandwidth) {
    this.post({ type: 'rx', freq, bandwidth });
  }

  setAudio(opts) {
    this.post({ type: 'audio', ...opts });
  }

  /** Schedules a caller's transmission. Returns the slot id. */
  transmit({ start, freq, snrDb, durations }) {
    const id = nextTxId++;
    const d = durations.slice();
    this.post({ type: 'tx', id, start, freq, snrDb, durations: d, sidetone: false }, [d.buffer]);
    return id;
  }

  /** Schedules the operator's own keying (sidetone only). */
  keyOperator({ start, durations }) {
    const id = nextTxId++;
    const d = durations.slice();
    this.post({ type: 'tx', id, start, freq: 0, snrDb: 0, durations: d, sidetone: true }, [d.buffer]);
    return id;
  }

  cancel(id) {
    this.post({ type: 'cancel', id });
  }

  cancelOperator() {
    this.post({ type: 'cancelAll', sidetone: true });
  }
}
