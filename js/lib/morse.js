const TABLE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
  H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
  O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
  V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '/': '-..-.', '?': '..--..', '=': '-...-', '+': '.-.-.', '.': '.-.-.-',
  ',': '--..--', "'": '.----.',
};

export function isSendable(ch) {
  return ch === ' ' || Object.prototype.hasOwnProperty.call(TABLE, ch.toUpperCase());
}

/**
 * Expands text into an alternating key-down/key-up duration list (seconds),
 * always starting with a key-down element.
 * `jitter` adds per-element human timing sloppiness (0 = perfect machine keying).
 */
export function morseDurations(text, wpm, jitter = 0) {
  const dit = 1.2 / wpm;
  const seq = [];

  for (const raw of text.toUpperCase()) {
    if (raw === ' ') {
      seq.push({ on: false, dur: 7 * dit });
      continue;
    }
    const code = TABLE[raw];
    if (!code) continue;
    for (const el of code) {
      seq.push({ on: true, dur: (el === '-' ? 3 : 1) * dit });
      seq.push({ on: false, dur: dit });
    }
    seq[seq.length - 1].dur = 3 * dit;
  }
  if (!seq.length) return new Float32Array(0);

  const merged = [];
  for (const s of seq) {
    const last = merged[merged.length - 1];
    if (last && last.on === s.on) last.dur += s.dur;
    else merged.push({ on: s.on, dur: s.dur });
  }
  while (merged.length && !merged[merged.length - 1].on) merged.pop();

  const durations = [];
  let expectOn = true;
  for (const s of merged) {
    if (s.on !== expectOn) {
      durations.push(0);
      expectOn = !expectOn;
    }
    const f = jitter ? 1 + (Math.random() * 2 - 1) * jitter : 1;
    durations.push(s.dur * f);
    expectOn = !expectOn;
  }
  return Float32Array.from(durations);
}

export function totalDuration(durations) {
  let t = 0;
  for (let i = 0; i < durations.length; i++) t += durations[i];
  return t;
}
