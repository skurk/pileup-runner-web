import {
  DEFAULT_SETTINGS, COMPETITION, BAND_CENTER_HZ, TX_OFFSET_HZ, PILEUP_START_HZ,
  MIN_BW, MAX_BW, QSY_CLEAR_THRESHOLD_HZ,
} from './lib/config.js';
import { Radio } from './audio/radio.js';
import { Session } from './engine/session.js';
import { Waterfall } from './ui/waterfall.js';
import { toAdif, downloadText } from './lib/adif.js';

const $ = (id) => document.getElementById(id);

const el = {
  statDx: $('stat-dx'), statTime: $('stat-time'), statQsos: $('stat-qsos'), statScore: $('stat-score'),
  btnStart: $('btn-start'), btnPause: $('btn-pause'), btnStop: $('btn-stop'), btnRadio: $('btn-radio'),
  wfMain: $('wf-main'), wfSlow: $('wf-slow'), wfScale: $('wf-scale'), splitter: $('splitter'),
  btnPage: $('btn-page'),
  readoutFreq: $('readout-freq'), readoutBw: $('readout-bw'), readoutState: $('readout-state'),
  callInput: $('call-input'), msgGrid: $('msg-grid'), btnSave: $('btn-save'),
  logPanel: $('log-panel'), logBody: $('log-body'),
  dlgPileup: $('dlg-pileup'), formPileup: $('form-pileup'),
  dlgRadio: $('dlg-radio'), formRadio: $('form-radio'),
  dlgResults: $('dlg-results'), resultsBody: $('results-body'),
  btnAdif: $('btn-adif'), btnHistory: $('btn-history'), btnResultsClose: $('btn-results-close'),
};

const STORE_SETTINGS = 'pileup-runner-settings';
const STORE_HISTORY = 'pileup-runner-history';

let settings = loadSettings();
const radio = new Radio();
const waterfall = new Waterfall(el.wfMain, el.wfSlow, el.wfScale);

let session = null;
let wallStart = 0;
let rxFreq = PILEUP_START_HZ + 2000;
let lastSentCall = '';
let esmStage = 'qrz';
let lastLoggedEntry = null;

/* ---------- settings ---------- */

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_SETTINGS) || '{}');
    return { ...DEFAULT_SETTINGS, ...raw, messages: { ...DEFAULT_SETTINGS.messages, ...(raw.messages || {}) } };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(STORE_SETTINGS, JSON.stringify(settings));
}

/* ---------- radio / tuning ---------- */

function setRxFreq(hz, { fromUser = true } = {}) {
  const clamped = Math.max(-20000, Math.min(20000, hz));
  const moved = Math.abs(clamped - rxFreq);
  rxFreq = clamped;
  waterfall.rxFreq = rxFreq;
  if (session) session.rxFreq = rxFreq;
  radio.setRx(rxFreq, settings.bandwidth);
  if (fromUser && moved > QSY_CLEAR_THRESHOLD_HZ) clearCall();
  updateReadout();
}

function setBandwidth(hz) {
  settings.bandwidth = Math.max(MIN_BW, Math.min(MAX_BW, Math.round(hz / 10) * 10));
  waterfall.bandwidth = settings.bandwidth;
  radio.setRx(rxFreq, settings.bandwidth);
  saveSettings();
  updateReadout();
}

function updateReadout() {
  el.readoutFreq.textContent = ((BAND_CENTER_HZ + rxFreq) / 1000).toFixed(2);
  el.readoutBw.textContent = `${settings.bandwidth} Hz`;
}

/* ---------- messages ---------- */

function expand(text) {
  return text
    .replace(/<my_call>/gi, settings.dxCall.toUpperCase())
    .replace(/<his_call>/gi, currentCall());
}

function currentCall() {
  return el.callInput.value.trim().toUpperCase();
}

function tuMessage() {
  const n = Math.max(1, settings.autoDxCallEvery);
  const base = settings.messages.F3;
  if (session && session.qsoCount > 0 && session.qsoCount % n === 0) {
    return base.replace(/\bTU\b/, `TU ${settings.dxCall.toUpperCase()}`);
  }
  return expand(base);
}

function send(text) {
  if (!session || !session.running) return;
  const out = expand(text).replace(/\s+/g, ' ').trim();
  if (!out) return;
  session.sendText(out, radio.time);
  if (out.includes(currentCall()) && currentCall()) lastSentCall = currentCall();
  flashTx();
}

function sendFKey(key) {
  if (key === 'F3') send(tuMessage());
  else send(settings.messages[key]);
}

function macroQrz() {
  send(settings.messages.F1);
  esmStage = 'qrz';
  updateEsmHint();
}

function macroReport() {
  const call = currentCall();
  if (!call) return;
  send(`${call} ${settings.messages.F2}`);
  esmStage = 'report';
  updateEsmHint();
}

function macroFinish() {
  const call = currentCall();
  if (!call) return;
  let text = '';
  if (call !== lastSentCall) text += `${call} `;
  text += tuMessage();
  send(text);
  writeLog(call);
}

function writeLog(call) {
  if (!session || !session.running) return;
  const entry = session.logQso(call || currentCall(), radio.time);
  if (!entry) return;
  lastLoggedEntry = entry;
  clearCall();
  esmStage = 'qrz';
  updateEsmHint();
  renderLog();
  updateStats();
}

function clearCall() {
  el.callInput.value = '';
  lastSentCall = '';
  esmStage = 'qrz';
  updateEsmHint();
}

function updateEsmHint() {
  for (const b of el.msgGrid.querySelectorAll('button')) b.classList.remove('esm-next');
  if (!settings.esm) return;
  const map = { qrz: 'F1', report: 'F2', final: 'F3' };
  const key = map[esmStage];
  const btn = el.msgGrid.querySelector(`[data-key="${key}"]`);
  if (btn) btn.classList.add('esm-next');
}

function flashTx() {
  el.readoutState.textContent = 'TX';
  el.readoutState.className = 'state-tx';
}

/* ---------- log rendering ---------- */

function renderLog() {
  if (!session) {
    el.logBody.innerHTML = '';
    return;
  }
  const rows = session.log.slice(-5).reverse();
  el.logBody.innerHTML = rows.map((q) => {
    const cls = q.status === '+' ? 'st-good' : q.status === '*' ? 'st-mult' : q.status === '-' ? 'st-bad' : '';
    const mark = q.status.trim() || '·';
    const correct = q.correct ? ` <span class="correct">{${q.correct}}</span>` : '';
    return `<tr>
      <td>${q.time}</td>
      <td>${q.call}${correct}</td>
      <td>${((BAND_CENTER_HZ + q.freq) / 1000).toFixed(2)}</td>
      <td>${q.continent}</td>
      <td>${q.snr}</td>
      <td class="${cls}">${mark}</td>
    </tr>`;
  }).join('');
}

function updateStats() {
  if (!session) return;
  el.statQsos.textContent = session.log.filter((q) => q.points > 0).length;
  el.statScore.textContent = session.score;
}

/* ---------- session lifecycle ---------- */

function fillPileupForm() {
  const f = el.formPileup;
  f.dxCall.value = settings.dxCall;
  f.opCall.value = settings.opCall;
  f.callers.value = settings.callers;
  f.snrDb.value = settings.snrDb;
  f.difficult.value = settings.difficult;
  f.minutes.value = settings.minutes;
  f.querySelector(`input[name="mode"][value="${settings.mode}"]`).checked = true;
  applyModeLock();
}

function applyModeLock() {
  const f = el.formPileup;
  const comp = f.mode.value === 'competition';
  if (comp) {
    f.callers.value = COMPETITION.callers;
    f.snrDb.value = COMPETITION.snrDb;
    f.minutes.value = COMPETITION.minutes;
  }
  for (const name of ['callers', 'snrDb', 'minutes']) f[name].disabled = comp;
}

async function startSession() {
  await radio.init();
  await radio.resume();

  session = new Session(radio, settings);
  session.onEnd = endSession;
  session.rxFreq = rxFreq;

  wallStart = Date.now();
  session.start(radio.time);
  radio.setRunning(true);
  radio.setRx(rxFreq, settings.bandwidth);
  radio.setAudio({
    pitch: settings.pitch, afGain: settings.afGain, sidetoneGain: settings.sidetoneGain,
  });

  waterfall.clear();
  waterfall.txFreq = TX_OFFSET_HZ;
  waterfall.centerOn(PILEUP_START_HZ + 2000);

  el.statDx.textContent = settings.dxCall.toUpperCase();
  el.logPanel.classList.toggle('competition', session.settings.mode === 'competition');
  el.btnStart.disabled = true;
  el.btnPause.disabled = false;
  el.btnStop.disabled = false;
  clearCall();
  renderLog();
  updateStats();
  el.callInput.focus();
}

function endSession() {
  if (!session) return;
  const s = session;
  s.running = false;
  s.stop();
  radio.setRunning(false);

  const valid = s.log.filter((q) => q.points > 0);
  const line = [
    new Date(wallStart).toISOString().slice(0, 16).replace('T', ' '),
    `Op=${s.settings.opCall || '?'}`,
    `DX=${s.settings.dxCall}`,
    `Mode=${s.settings.mode === 'competition' ? 'Competition' : 'Practice'}`,
    `Callers=${s.settings.callers}`,
    `SNR=${s.settings.snrDb}`,
    `Min=${s.settings.minutes}`,
    `QSO=${valid.length}`,
    `Score=${s.score}`,
  ].join('  ');
  const history = JSON.parse(localStorage.getItem(STORE_HISTORY) || '[]');
  history.push(line);
  localStorage.setItem(STORE_HISTORY, JSON.stringify(history));

  el.resultsBody.innerHTML = `
    <div class="big">${s.score} points</div>
    <div>${valid.length} valid QSO · ${s.log.length} log entries</div>
    <div>3-pointers: ${valid.filter((q) => q.points === 3).length}</div>
    <div>Busted / not in his log: ${s.log.length - valid.length}</div>
    <p class="note">${s.settings.mode === 'competition'
    ? 'Competition result stored locally. It is not verifiable and cannot be submitted to the original high-score table.'
    : 'Practice result — for your own information only.'}</p>`;
  el.dlgResults.showModal();

  el.btnStart.disabled = false;
  el.btnPause.disabled = true;
  el.btnStop.disabled = true;
  el.btnPause.textContent = 'Pause';
}

/* ---------- waterfall input ---------- */

function tuneFromEvent(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  setRxFreq(waterfall.yToHz(e.clientY - rect.top));
}

function attachWaterfallInput() {
  let drag = null;

  el.wfMain.addEventListener('pointerdown', (e) => {
    el.wfMain.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, moved: false, offset: waterfall.timeOffset };
  });

  el.wfMain.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) {
      drag.moved = true;
      // Dragging the waterfall to the right scrolls back in time and pauses.
      waterfall.timeOffset = Math.max(0, Math.min(1000, drag.offset + dx));
      if (waterfall.timeOffset > 0 && session && !session.paused) setPaused(true);
    }
  });

  el.wfMain.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) tuneFromEvent(el.wfMain, e);
    drag = null;
  });

  el.wfSlow.addEventListener('click', (e) => tuneFromEvent(el.wfSlow, e));

  let scaleDrag = null;
  el.wfScale.addEventListener('pointerdown', (e) => {
    const rect = el.wfScale.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const yTop = waterfall.hzToY(rxFreq + settings.bandwidth / 2);
    const yBot = waterfall.hzToY(rxFreq - settings.bandwidth / 2);
    const onPassband = y >= yTop - 3 && y <= yBot + 3;
    el.wfScale.setPointerCapture(e.pointerId);
    scaleDrag = {
      y, moved: false, mode: onPassband ? 'bw' : 'scroll',
      bw: settings.bandwidth, topBin: waterfall.topBin,
    };
  });

  el.wfScale.addEventListener('pointermove', (e) => {
    if (!scaleDrag) return;
    const rect = el.wfScale.getBoundingClientRect();
    const dy = (e.clientY - rect.top) - scaleDrag.y;
    if (Math.abs(dy) > 2) scaleDrag.moved = true;
    if (!scaleDrag.moved) return;
    if (scaleDrag.mode === 'bw') setBandwidth(scaleDrag.bw + Math.abs(dy) * 6 * Math.sign(dy));
    else waterfall.setTopBin(scaleDrag.topBin + dy / 3);
  });

  el.wfScale.addEventListener('pointerup', (e) => {
    if (scaleDrag && !scaleDrag.moved) tuneFromEvent(el.wfScale, e);
    scaleDrag = null;
  });

  el.btnPage.addEventListener('click', () => waterfall.scrollPages(1));
  el.btnPage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    waterfall.scrollPages(-1);
  });

  // Splitter resizes the slow waterfall.
  let splitDrag = null;
  el.splitter.addEventListener('pointerdown', (e) => {
    el.splitter.setPointerCapture(e.pointerId);
    splitDrag = { x: e.clientX, w: el.wfSlow.getBoundingClientRect().width };
  });
  el.splitter.addEventListener('pointermove', (e) => {
    if (!splitDrag) return;
    const w = Math.max(0, Math.min(400, splitDrag.w + (e.clientX - splitDrag.x)));
    el.wfSlow.style.width = `${w}px`;
    waterfall.resize();
  });
  el.splitter.addEventListener('pointerup', () => { splitDrag = null; });
}

function setPaused(value) {
  if (!session) return;
  session.paused = value;
  el.btnPause.textContent = value ? 'Resume' : 'Pause';
  if (!value) waterfall.timeOffset = 0;
}

/* ---------- keyboard ---------- */

const MACRO_QRZ = '\\';
const MACRO_REPORT = ';';
const MACRO_FINISH = '.';

function onKeyDown(e) {
  if (document.querySelector('dialog[open]')) return;

  if (/^F[1-7]$/.test(e.key)) {
    e.preventDefault();
    sendFKey(e.key);
    return;
  }

  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      if (session) session.abortTx();
      return;
    case 'PageUp':
      e.preventDefault();
      waterfall.scrollPages(1);
      return;
    case 'PageDown':
      e.preventDefault();
      waterfall.scrollPages(-1);
      return;
    case 'ArrowUp':
      e.preventDefault();
      setBandwidth(settings.bandwidth + 50);
      return;
    case 'ArrowDown':
      e.preventDefault();
      setBandwidth(settings.bandwidth - 50);
      return;
    case 'F11':
      e.preventDefault();
      clearCall();
      return;
    case MACRO_QRZ:
      e.preventDefault();
      macroQrz();
      return;
    case MACRO_REPORT:
      e.preventDefault();
      macroReport();
      return;
    case MACRO_FINISH:
    case 'Insert':
      e.preventDefault();
      macroFinish();
      return;
    default:
      break;
  }

  if ((e.ctrlKey || e.altKey) && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    clearCall();
    return;
  }

  if (e.key === ' ' && settings.esm) {
    e.preventDefault();
    if (currentCall()) {
      esmStage = 'final';
      updateEsmHint();
    }
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    if (!settings.esm) {
      writeLog(currentCall());
      return;
    }
    if (esmStage === 'qrz' && !currentCall()) macroQrz();
    else if (esmStage === 'final') macroFinish();
    else macroReport();
    return;
  }

  // Everything else that is a callsign character goes to the input box.
  if (e.key.length === 1 && /[a-zA-Z0-9/]/.test(e.key) && document.activeElement !== el.callInput) {
    el.callInput.focus();
  }
}

/* ---------- main loop ---------- */

function frame() {
  if (session && session.running) {
    const now = radio.time;
    session.tick(now);
    const left = session.remaining(now);
    el.statTime.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    const tx = session.transmitting;
    el.readoutState.textContent = tx ? 'TX' : 'RX';
    el.readoutState.className = tx ? 'state-tx' : 'state-rx';
    updateStats();
  }
  waterfall.render();
  requestAnimationFrame(frame);
}

/* ---------- wiring ---------- */

function init() {
  waterfall.rxFreq = rxFreq;
  waterfall.bandwidth = settings.bandwidth;
  waterfall.txFreq = TX_OFFSET_HZ;
  waterfall.centerOn(PILEUP_START_HZ + 2000);
  updateReadout();
  updateEsmHint();

  radio.onSpectrum = ({ bins }) => {
    if (session && session.running && !session.paused) waterfall.push(bins);
  };

  radio.onTxGap = () => {
    if (session && session.running && !session.paused) waterfall.pushGap();
  };

  el.btnStart.addEventListener('click', () => {
    fillPileupForm();
    el.dlgPileup.showModal();
  });

  el.formPileup.addEventListener('change', (e) => {
    if (e.target.name === 'mode') applyModeLock();
  });

  el.dlgPileup.addEventListener('close', () => {
    if (el.dlgPileup.returnValue !== 'ok') return;
    const f = el.formPileup;
    Object.assign(settings, {
      dxCall: f.dxCall.value.trim().toUpperCase(),
      opCall: f.opCall.value.trim().toUpperCase(),
      callers: Number(f.callers.value),
      snrDb: Number(f.snrDb.value),
      difficult: f.difficult.value,
      minutes: Number(f.minutes.value),
      mode: f.mode.value,
    });
    saveSettings();
    startSession();
  });

  el.btnPause.addEventListener('click', () => setPaused(!session?.paused));
  el.btnStop.addEventListener('click', endSession);

  el.btnRadio.addEventListener('click', () => {
    const f = el.formRadio;
    for (const name of ['pitch', 'bandwidth', 'afGain', 'sidetoneGain', 'wpm', 'autoDxCallEvery']) {
      f[name].value = settings[name];
    }
    f.esm.checked = settings.esm;
    syncRadioOutputs();
    el.dlgRadio.showModal();
  });

  el.formRadio.addEventListener('input', () => {
    const f = el.formRadio;
    settings.pitch = Number(f.pitch.value);
    settings.afGain = Number(f.afGain.value);
    settings.sidetoneGain = Number(f.sidetoneGain.value);
    settings.wpm = Number(f.wpm.value);
    settings.autoDxCallEvery = Number(f.autoDxCallEvery.value);
    settings.esm = f.esm.checked;
    if (session) session.settings.wpm = settings.wpm;
    setBandwidth(Number(f.bandwidth.value));
    radio.setAudio({
      pitch: settings.pitch, afGain: settings.afGain, sidetoneGain: settings.sidetoneGain,
    });
    saveSettings();
    syncRadioOutputs();
    updateEsmHint();
  });

  el.msgGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'btn-save') writeLog(currentCall());
    else sendFKey(btn.dataset.key);
    el.callInput.focus();
  });

  el.btnResultsClose.addEventListener('click', () => el.dlgResults.close());
  el.btnAdif.addEventListener('click', () => {
    if (session) downloadText(`pileup-${new Date(wallStart).toISOString().slice(0, 10)}.adi`, toAdif(session, wallStart));
  });
  el.btnHistory.addEventListener('click', () => {
    const history = JSON.parse(localStorage.getItem(STORE_HISTORY) || '[]');
    downloadText('pileup-runner-history.txt', history.join('\n'));
  });

  el.callInput.addEventListener('input', () => {
    el.callInput.value = el.callInput.value.toUpperCase().replace(/[^A-Z0-9/]/g, '');
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => waterfall.resize());
  attachWaterfallInput();

  requestAnimationFrame(frame);
}

function syncRadioOutputs() {
  for (const label of el.formRadio.querySelectorAll('label')) {
    const input = label.querySelector('input[type="range"]');
    const out = label.querySelector('output');
    if (input && out) out.value = input.value;
  }
}

init();
