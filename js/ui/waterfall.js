import { FFT_SIZE, BIN_HZ, SPAN_HZ, SLOW_DECIM } from '../lib/config.js';

const COLS = 1400;
const PX_PER_BIN = 3;
const SLOW_COLS = 200;

// Marker written where the operator transmitted and the waterfall held.
const GAP_COLUMNS = 4;
const GAP_RGB = [58, 18, 20];

// Blue -> cyan -> yellow -> white, the usual waterfall ramp.
function buildPalette() {
  const pal = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let r;
    let g;
    let b;
    if (v < 0.35) {
      const t = v / 0.35;
      r = 0; g = 8 + 40 * t; b = 24 + 90 * t;
    } else if (v < 0.6) {
      const t = (v - 0.35) / 0.25;
      r = 0; g = 48 + 160 * t; b = 114 + 60 * t;
    } else if (v < 0.82) {
      const t = (v - 0.6) / 0.22;
      r = 255 * t; g = 208 + 40 * t; b = 174 - 150 * t;
    } else {
      const t = (v - 0.82) / 0.18;
      r = 255; g = 248; b = 24 + 230 * t;
    }
    pal[i * 3] = r; pal[i * 3 + 1] = g; pal[i * 3 + 2] = b;
  }
  return pal;
}

const PALETTE = buildPalette();

export function hzToBin(offsetHz) {
  return Math.round((offsetHz + SPAN_HZ / 2) / BIN_HZ);
}

export function binToHz(bin) {
  return bin * BIN_HZ - SPAN_HZ / 2;
}

export class Waterfall {
  constructor(mainCanvas, slowCanvas, scaleCanvas) {
    this.main = mainCanvas;
    this.slow = slowCanvas;
    this.scale = scaleCanvas;
    this.mainCtx = mainCanvas.getContext('2d');
    this.slowCtx = slowCanvas.getContext('2d');
    this.scaleCtx = scaleCanvas.getContext('2d');

    this.history = new Uint8Array(COLS * FFT_SIZE);
    this.head = 0;
    this.filled = 0;
    this.gapFlags = new Uint8Array(COLS);

    this.slowHistory = new Uint8Array(SLOW_COLS * FFT_SIZE);
    this.slowHead = 0;
    this.slowGapFlags = new Uint8Array(SLOW_COLS);
    this.slowAccum = new Float32Array(FFT_SIZE);
    this.slowCount = 0;

    this.topBin = hzToBin(6000);
    this.rxFreq = 2500;
    this.bandwidth = 500;
    this.txFreq = 1000;
    this.timeOffset = 0; // columns scrolled back into history

    this.buffer = document.createElement('canvas');
    this.bufferCtx = this.buffer.getContext('2d');
    this.slowBuffer = document.createElement('canvas');
    this.slowBufferCtx = this.slowBuffer.getContext('2d');

    this.resize();
  }

  get visibleBins() {
    return Math.max(8, Math.floor(this.main.height / PX_PER_BIN));
  }

  get pageHz() {
    return this.visibleBins * BIN_HZ;
  }

  resize() {
    for (const c of [this.main, this.slow, this.scale]) {
      const rect = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(rect.width));
      c.height = Math.max(1, Math.round(rect.height));
    }
    this.buffer.width = COLS;
    this.buffer.height = this.visibleBins * PX_PER_BIN;
    this.slowBuffer.width = SLOW_COLS;
    this.slowBuffer.height = this.buffer.height;
    this.redrawAll();
  }

  /** Frequency offset (Hz) at a vertical pixel position of the display. */
  yToHz(y) {
    const bin = this.topBin - Math.floor(y / PX_PER_BIN);
    return binToHz(bin);
  }

  hzToY(hz) {
    return (this.topBin - hzToBin(hz)) * PX_PER_BIN;
  }

  scrollPages(n) {
    this.setTopBin(this.topBin + n * this.visibleBins);
  }

  scrollBins(n) {
    this.setTopBin(this.topBin + n);
  }

  setTopBin(bin) {
    const max = hzToBin(SPAN_HZ / 2 - 500);
    const min = hzToBin(-SPAN_HZ / 2) + this.visibleBins;
    this.topBin = Math.max(min, Math.min(max, Math.round(bin)));
    this.redrawAll();
  }

  centerOn(hz) {
    this.setTopBin(hzToBin(hz) + Math.floor(this.visibleBins / 2));
  }

  push(bins) {
    this.history.set(bins, this.head * FFT_SIZE);
    this.gapFlags[this.head] = 0;
    this.drawColumn(this.bufferCtx, bins, this.head);
    this.head = (this.head + 1) % COLS;
    if (this.filled < COLS) this.filled++;

    for (let i = 0; i < FFT_SIZE; i++) this.slowAccum[i] += bins[i];
    if (++this.slowCount >= SLOW_DECIM) {
      const avg = new Uint8Array(FFT_SIZE);
      for (let i = 0; i < FFT_SIZE; i++) avg[i] = this.slowAccum[i] / this.slowCount;
      this.slowHistory.set(avg, this.slowHead * FFT_SIZE);
      this.slowGapFlags[this.slowHead] = 0;
      this.drawColumn(this.slowBufferCtx, avg, this.slowHead);
      this.slowHead = (this.slowHead + 1) % SLOW_COLS;
      this.slowAccum.fill(0);
      this.slowCount = 0;
    }
  }

  /** Discards all history, for the start of a new session. */
  clear() {
    this.history.fill(0);
    this.gapFlags.fill(0);
    this.head = 0;
    this.filled = 0;

    this.slowHistory.fill(0);
    this.slowGapFlags.fill(0);
    this.slowHead = 0;
    this.slowAccum.fill(0);
    this.slowCount = 0;

    this.timeOffset = 0;
    this.redrawAll();
  }

  /** Marks the break left by an operator transmission. */
  pushGap() {    for (let i = 0; i < GAP_COLUMNS; i++) {
      this.gapFlags[this.head] = 1;
      this.history.fill(0, this.head * FFT_SIZE, (this.head + 1) * FFT_SIZE);
      this.drawGapColumn(this.bufferCtx, this.head);
      this.head = (this.head + 1) % COLS;
      if (this.filled < COLS) this.filled++;
    }

    this.slowGapFlags[this.slowHead] = 1;
    this.slowHistory.fill(0, this.slowHead * FFT_SIZE, (this.slowHead + 1) * FFT_SIZE);
    this.drawGapColumn(this.slowBufferCtx, this.slowHead);
    this.slowHead = (this.slowHead + 1) % SLOW_COLS;
    this.slowAccum.fill(0);
    this.slowCount = 0;
  }

  drawGapColumn(ctx, col) {
    const h = this.buffer.height;
    const img = ctx.createImageData(1, h);
    const d = img.data;
    for (let p = 0; p < d.length; p += 4) {
      d[p] = GAP_RGB[0]; d[p + 1] = GAP_RGB[1]; d[p + 2] = GAP_RGB[2]; d[p + 3] = 255;
    }
    ctx.putImageData(img, col, 0);
  }

  drawColumn(ctx, bins, col) {
    const h = this.buffer.height;
    const img = ctx.createImageData(1, h);
    const d = img.data;
    const nBins = this.visibleBins;
    let p = 0;
    for (let i = 0; i < nBins; i++) {
      const bin = this.topBin - i;
      const v = bin >= 0 && bin < FFT_SIZE ? bins[bin] : 0;
      const r = PALETTE[v * 3];
      const g = PALETTE[v * 3 + 1];
      const b = PALETTE[v * 3 + 2];
      for (let k = 0; k < PX_PER_BIN; k++) {
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
        p += 4;
      }
    }
    ctx.putImageData(img, col, 0);
  }

  redrawAll() {
    this.redrawBuffer(this.bufferCtx, this.buffer, this.history, COLS, this.gapFlags);
    this.redrawBuffer(this.slowBufferCtx, this.slowBuffer, this.slowHistory, SLOW_COLS, this.slowGapFlags);
  }

  redrawBuffer(ctx, canvas, history, cols, gapFlags) {
    const h = canvas.height;
    if (!h) return;
    const img = ctx.createImageData(cols, h);
    const d = img.data;
    const nBins = this.visibleBins;
    for (let i = 0; i < nBins; i++) {
      const bin = this.topBin - i;
      const inRange = bin >= 0 && bin < FFT_SIZE;
      for (let k = 0; k < PX_PER_BIN; k++) {
        const row = i * PX_PER_BIN + k;
        let p = row * cols * 4;
        for (let c = 0; c < cols; c++) {
          if (gapFlags[c]) {
            d[p] = GAP_RGB[0];
            d[p + 1] = GAP_RGB[1];
            d[p + 2] = GAP_RGB[2];
          } else {
            const v = inRange ? history[c * FFT_SIZE + bin] : 0;
            d[p] = PALETTE[v * 3];
            d[p + 1] = PALETTE[v * 3 + 1];
            d[p + 2] = PALETTE[v * 3 + 2];
          }
          d[p + 3] = 255;
          p += 4;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  render() {
    this.blit(this.mainCtx, this.main, this.buffer, COLS, this.head, this.timeOffset);
    this.blit(this.slowCtx, this.slow, this.slowBuffer, SLOW_COLS, this.slowHead, 0);
    this.drawScale();
  }

  blit(ctx, canvas, buffer, cols, head, offset) {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Newest column sits at the right edge; `offset` scrolls back in time.
    const end = (head - offset + cols * 2) % cols;
    const start = (end - w + cols * 2) % cols;
    if (start + w <= cols) {
      ctx.drawImage(buffer, start, 0, w, buffer.height, 0, 0, w, h);
    } else {
      const first = cols - start;
      ctx.drawImage(buffer, start, 0, first, buffer.height, 0, 0, first, h);
      ctx.drawImage(buffer, 0, 0, w - first, buffer.height, first, 0, w - first, h);
    }
  }

  drawScale() {
    const ctx = this.scaleCtx;
    const w = this.scale.width;
    const h = this.scale.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#12161c';
    ctx.fillRect(0, 0, w, h);

    const topHz = binToHz(this.topBin);
    const botHz = topHz - this.pageHz;

    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    const stepHz = 500;
    const first = Math.ceil(botHz / stepHz) * stepHz;
    for (let f = first; f <= topHz; f += stepHz) {
      const y = this.hzToY(f);
      const major = f % 1000 === 0;
      ctx.strokeStyle = major ? '#5a6a7a' : '#2b3440';
      ctx.beginPath();
      ctx.moveTo(w - (major ? 10 : 5), y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = '#8fa3b5';
        ctx.fillText(((14024000 + f) / 1000).toFixed(1), 4, y);
      }
    }

    // Receiver passband and centre.
    const yTop = this.hzToY(this.rxFreq + this.bandwidth / 2);
    const yBot = this.hzToY(this.rxFreq - this.bandwidth / 2);
    ctx.fillStyle = 'rgba(60, 220, 120, 0.22)';
    ctx.fillRect(0, yTop, w, Math.max(2, yBot - yTop));
    ctx.strokeStyle = 'rgba(60, 220, 120, 0.8)';
    ctx.strokeRect(0.5, yTop + 0.5, w - 1, Math.max(2, yBot - yTop) - 1);

    const yc = this.hzToY(this.rxFreq);
    ctx.fillStyle = '#7dffb0';
    ctx.beginPath();
    ctx.moveTo(0, yc);
    ctx.lineTo(9, yc - 5);
    ctx.lineTo(9, yc + 5);
    ctx.closePath();
    ctx.fill();

    // Transmit frequency.
    const yt = this.hzToY(this.txFreq);
    if (yt >= -6 && yt <= h + 6) {
      ctx.fillStyle = '#ff5a52';
      ctx.beginPath();
      ctx.moveTo(w, yt);
      ctx.lineTo(w - 9, yt - 5);
      ctx.lineTo(w - 9, yt + 5);
      ctx.closePath();
      ctx.fill();
    }
  }
}

export { PX_PER_BIN, COLS };
