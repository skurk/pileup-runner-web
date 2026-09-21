import {
  PILEUP_START_HZ, PILEUP_SPREAD_HZ, DIFFICULT_ALWAYS, COMPETITION,
} from '../lib/config.js';
import { generateCallsigns, editDistance } from '../lib/callsigns.js';
import { morseDurations, totalDuration } from '../lib/morse.js';

const SKILL_BLIND = 0;
const SKILL_MONITOR = 1;
const SKILL_EXPERT = 2;

// How long a station waits for his report before he resumes calling.
const STANDBY_PATIENCE = 10;

// Pause between two messages keyed back to back, in dit lengths.
const MESSAGE_GAP_DITS = 7;

// Chance of miscopying his own call even with a clear shot at it.
const BASE_COPY_ERROR = 0.08;

// How long a caller listens between his own transmissions.
const CALL_GAP_MIN = 1.2;
const CALL_GAP_MAX = 4.5;

const CALL_RE = /^[A-Z0-9]{1,3}\d[A-Z]{1,4}$/;

function randn() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function pickOne(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

function extractCalls(text) {
  return text.toUpperCase().split(/[\s+]+/).filter((t) => CALL_RE.test(t));
}

export class Session {
  constructor(radio, settings) {
    this.radio = radio;
    this.settings = { ...settings };

    if (this.settings.mode === 'competition') {
      Object.assign(this.settings, COMPETITION);
    }

    this.callers = [];
    this.log = [];
    this.score = 0;
    this.startTime = 0;
    this.endTime = 0;
    this.running = false;
    this.paused = false;

    this.opTxEnd = 0;
    this.opTxId = null;
    this.pendingReactions = [];
    this.addressed = null;
    this.worked = null;
    this.finalSent = false;
    this.qsoCount = 0;
    this.rxFreq = PILEUP_START_HZ + 500;

    this.onLogChange = null;
    this.onEnd = null;
  }

  get difficultSet() {
    return new Set([...DIFFICULT_ALWAYS, this.settings.difficult]);
  }

  start(now) {
    const difficult = this.difficultSet;
    const list = generateCallsigns(this.settings.callers);
    this.callers = list.map(({ call, continent }) => {
      const hard = difficult.has(continent);
      const r = Math.random();
      const skill = r < 0.55 ? SKILL_BLIND : r < 0.85 ? SKILL_MONITOR : SKILL_EXPERT;
      return {
        call,
        continent,
        points: hard ? 3 : 1,
        freq: PILEUP_START_HZ + PILEUP_SPREAD_HZ * Math.random() ** 1.6,
        snrDb: Math.max(0, Math.min(40, this.settings.snrDb + randn() * 5 - (hard ? 4 : 0))),
        wpm: Math.round(rand(18, 38)),
        skill,
        state: 'calling',
        nextCallTime: now + rand(0.2, 4),
        callsSinceMove: 0,
        standbyUntil: 0,
        loggedAs: null,
        txId: null,
        txStart: 0,
        txEnd: 0,
        justMissed: false,
        polite: Math.random() > 0.1,
      };
    });

    this.log = [];
    this.score = 0;
    this.qsoCount = 0;
    this.worked = null;
    this.addressed = null;
    this.pendingReactions = [];
    this.opTxEnd = 0;
    this.startTime = now;
    this.endTime = now + this.settings.minutes * 60;
    this.running = true;
    this.paused = false;
  }

  stop() {
    this.running = false;
    for (const c of this.callers) if (c.txId) this.radio.cancel(c.txId);
    this.callers = [];
  }

  remaining(now) {
    return Math.max(0, this.endTime - now);
  }

  /* ---------- operator transmissions ---------- */

  /** Keys the operator's sidetone and queues the pileup's reaction. */
  sendText(text, now) {
    if (!this.running || this.paused || !text) return 0;
    const durations = morseDurations(text, this.settings.wpm);
    const dur = totalDuration(durations);
    const gap = MESSAGE_GAP_DITS * (1.2 / this.settings.wpm);
    const start = this.opTxEnd > now ? this.opTxEnd + gap : now + 0.05;
    this.radio.keyOperator({ start, durations });
    this.opTxEnd = start + dur;
    this.pendingReactions.push({ text: text.toUpperCase(), at: this.opTxEnd, from: start });
    // The correspondent only logs the QSO if he had finished his exchange
    // before the final TU was keyed.
    if (/\bTU\b/.test(text.toUpperCase()) && this.worked && this.worked.state === 'waiting_tu') {
      this.finalSent = true;
    }
    return this.opTxEnd - now;
  }

  abortTx() {
    this.radio.cancelOperator();
    this.opTxEnd = 0;
    this.pendingReactions.length = 0;
  }

  get transmitting() {
    return this.radio.time < this.opTxEnd;
  }

  /** Applies the pileup's reaction once an operator transmission has finished. */
  applyReaction(text, now, opStart, opEnd) {
    const calls = extractCalls(text).filter((c) => c !== this.settings.dxCall.toUpperCase());
    const sentCall = calls.length ? calls[calls.length - 1] : null;
    const hasReport = /\b599\b|\b5NN\b/.test(text);
    const isFinal = /\bTU\b/.test(text);

    if (sentCall) this.addressCall(sentCall, now, opStart, opEnd);

    if (hasReport) {
      // He only comes back once he has actually been given a report.
      if (this.worked && this.worked.state === 'standby') this.sendExchange(this.worked, now);

      // Experienced callers deduce the QSX frequency from the exchange.
      for (const c of this.callers) {
        if (c.state === 'calling' && c.skill === SKILL_EXPERT && Math.random() < 0.5) {
          c.freq = Math.max(PILEUP_START_HZ, this.rxFreq + rand(-150, 150));
        }
      }
    }

    if (isFinal && this.worked && this.worked.state === 'waiting_tu') {
      this.finalSent = true;
    }

    // Polite callers hold off briefly after the DX addresses someone. Anyone who
    // was transmitting over it heard nothing and keeps calling.
    if (sentCall) {
      for (const c of this.callers) {
        if (c.justMissed) {
          c.justMissed = false;
          continue;
        }
        if (c.state === 'calling' && c.polite) c.nextCallTime = Math.max(c.nextCallTime, now + rand(0.5, 3));
      }
    }
  }

  /**
   * A caller is deaf while his own key is down, so an operator message that
   * overlaps his transmission is copied only in part, if at all.
   */
  missedTransmission(caller, opStart, opEnd) {
    const overlap = Math.min(caller.txEnd, opEnd) - Math.max(caller.txStart, opStart);
    if (overlap <= 0) return false;
    return Math.random() < Math.min(1, overlap / Math.max(0.1, opEnd - opStart));
  }

  keepCalling(caller, now) {
    caller.justMissed = true;
    caller.nextCallTime = Math.max(caller.txEnd, now) + rand(0.1, 0.9);
  }

  /** The operator has sent a callsign: that station stops calling and stands by. */
  addressCall(sentCall, now, opStart, opEnd) {
    this.addressed = sentCall;

    let target = this.callers.find((c) => c.call === sentCall && c.state === 'calling');

    if (target) {
      if (this.missedTransmission(target, opStart, opEnd) || Math.random() < BASE_COPY_ERROR) {
        this.keepCalling(target, now);
        return;
      }
    } else {
      // A near-miss may be accepted by the station it resembles.
      const near = this.callers.filter(
        (c) => c.state === 'calling'
          && editDistance(c.call, sentCall) === 1
          && !this.missedTransmission(c, opStart, opEnd),
      );
      if (!near.length || Math.random() >= 0.55) return;
      target = pickOne(near);
    }

    target.loggedAs = sentCall;
    target.state = 'standby';
    target.standbyUntil = now + STANDBY_PATIENCE;
    if (target.txId) this.radio.cancel(target.txId);

    this.worked = target;
    this.finalSent = false;
  }

  /** He has copied the report and comes back with his own. */
  sendExchange(caller, now) {
    const start = now + rand(0.25, 0.9);
    const text = this.exchangeText(caller);
    const durations = morseDurations(text, caller.wpm, 0.06);
    caller.txId = this.radio.transmit({
      start, freq: caller.freq, snrDb: caller.snrDb, durations,
    });
    caller.exchangeEnd = start + totalDuration(durations);
    caller.state = 'answering';
  }

  exchangeText(caller) {
    // Cut numbers are the norm on CW; the full report still turns up now and then.
    const rst = Math.random() < 0.9 ? '5NN' : '599';
    const styles = [
      rst,
      `TU ${rst}`,
      `${rst} TU`,
      `${caller.call} ${rst}`,
      `R ${rst} TU DE ${caller.call}`,
      `BK DE ${caller.call} TU ${rst} GL 73 DE ${caller.call} TU E E`,
    ];
    const w = [0.42, 0.18, 0.15, 0.12, 0.08, 0.05];
    let r = Math.random();
    for (let i = 0; i < styles.length; i++) {
      r -= w[i];
      if (r <= 0) return styles[i];
    }
    return styles[0];
  }

  /* ---------- logging ---------- */

  /** Writes the QSO in the callsign box to the log. Returns the entry. */
  logQso(callInBox, now) {
    if (!this.running || !callInBox) return null;
    const call = callInBox.toUpperCase();

    const last = this.log[this.log.length - 1];
    if (last && last.call === call && now - last.at < 5) return null; // no duplicate on double "."

    const worked = this.worked;
    let status = ' ';
    let points = 0;
    let correct = null;

    if (worked && worked.loggedAs === call) {
      if (worked.call !== call) {
        status = '-';
        correct = worked.call;
      } else if (worked.state === 'waiting_tu' && this.finalSent) {
        status = worked.points === 3 ? '*' : '+';
        points = worked.points;
      }
    }

    const entry = {
      at: now,
      time: this.clockString(now),
      call,
      freq: worked ? worked.freq : this.rxFreq,
      continent: worked ? worked.continent : '',
      snr: worked ? Math.round(worked.snrDb) : 0,
      status,
      correct,
      points,
    };

    this.score += points;
    this.qsoCount++;
    this.log.push(entry);

    if (worked && status !== ' ') {
      worked.state = 'done';
      if (worked.txId) this.radio.cancel(worked.txId);
      this.callers = this.callers.filter((c) => c !== worked);
    } else if (worked) {
      worked.state = 'calling';
      worked.loggedAs = null;
      worked.nextCallTime = now + rand(0.3, 1.5);
    }

    this.worked = null;
    this.finalSent = false;
    if (this.onLogChange) this.onLogChange();
    return entry;
  }

  clockString(now) {
    const elapsed = Math.max(0, now - this.startTime);
    const m = Math.floor(elapsed / 60);
    const s = Math.floor(elapsed % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /* ---------- simulation tick ---------- */

  tick(now) {
    if (!this.running || this.paused) return;

    // Each message reacts in turn, so a queued one cannot discard the previous.
    while (this.pendingReactions.length && now >= this.pendingReactions[0].at) {
      const r = this.pendingReactions.shift();
      this.applyReaction(r.text, now, r.from, r.at);
    }

    const opBusy = now < this.opTxEnd;

    for (const c of this.callers) {
      if (c.state === 'standby') {
        // Gives up waiting for a report and starts calling again.
        if (now > c.standbyUntil) {
          c.state = 'calling';
          c.loggedAs = null;
          c.nextCallTime = now + rand(0.2, 1.5);
          if (this.worked === c) this.worked = null;
        }
        continue;
      }
      if (c.state === 'answering') {
        if (now >= c.exchangeEnd) c.state = 'waiting_tu';
        continue;
      }
      if (c.state === 'waiting_tu') {
        // Gives up waiting and resumes calling if the DX never comes back.
        if (now > c.exchangeEnd + 12) {
          c.state = 'calling';
          c.loggedAs = null;
          c.nextCallTime = now + rand(0.2, 2);
          if (this.worked === c) this.worked = null;
        }
        continue;
      }
      if (c.state !== 'calling') continue;
      if (now < c.nextCallTime) continue;
      if (opBusy && c.polite) {
        c.nextCallTime = this.opTxEnd + rand(0.05, 1.2);
        continue;
      }

      if (c.skill === SKILL_MONITOR && ++c.callsSinceMove >= 3 && Math.random() < 0.35) {
        c.callsSinceMove = 0;
        c.freq = Math.min(
          PILEUP_START_HZ + PILEUP_SPREAD_HZ,
          Math.max(PILEUP_START_HZ, c.freq + rand(-1500, 1500)),
        );
      }

      const text = Math.random() < 0.45 ? `${c.call} ${c.call}` : c.call;
      const durations = morseDurations(text, c.wpm, 0.05);
      c.txStart = now + 0.05;
      c.txEnd = c.txStart + totalDuration(durations);
      c.txId = this.radio.transmit({
        start: c.txStart, freq: c.freq, snrDb: c.snrDb, durations,
      });
      c.nextCallTime = c.txEnd + rand(CALL_GAP_MIN, CALL_GAP_MAX);
    }

    if (now >= this.endTime && this.onEnd) {
      this.running = false;
      this.onEnd();
    }
  }
}
