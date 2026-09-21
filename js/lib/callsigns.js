// Generates synthetic but structurally valid amateur callsigns.
// Format: <prefix><digit><suffix>, prefix being 1-2 letters or digit+letter,
// suffix 1-3 letters. Prefix blocks are real ITU allocations so that the
// prefix -> continent mapping behaves the way an operator would expect, but
// every generated call is made up.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// [prefix, continent, weight, digits]
const BLOCKS = [
  // Europe
  ['G', 'EU', 9, '01234568'], ['M', 'EU', 6, '0136'], ['2E', 'EU', 2, '0'],
  ['DL', 'EU', 10, '123456789'], ['DJ', 'EU', 4, '123456789'], ['DK', 'EU', 4, '123456789'],
  ['F', 'EU', 8, '1458'], ['I', 'EU', 8, '0123456789'], ['IK', 'EU', 4, '0123456789'],
  ['EA', 'EU', 6, '1234567'], ['ON', 'EU', 4, '4567'], ['PA', 'EU', 5, '0359'],
  ['OK', 'EU', 5, '12'], ['OM', 'EU', 3, '0348'], ['SP', 'EU', 6, '123456789'],
  ['S5', 'EU', 3, '013579'], ['HA', 'EU', 4, '01234567'], ['YO', 'EU', 4, '23456789'],
  ['LZ', 'EU', 3, '123'], ['SM', 'EU', 4, '0123567'], ['LA', 'EU', 4, '123456789'],
  ['OH', 'EU', 4, '123568'], ['OZ', 'EU', 3, '1478'], ['ES', 'EU', 2, '12567'],
  ['YL', 'EU', 2, '23'], ['LY', 'EU', 3, '2345'], ['UR', 'EU', 4, '3456789'],
  ['UT', 'EU', 3, '0123457'], ['EW', 'EU', 2, '1234678'], ['RA', 'EU', 6, '134567'],
  ['UA', 'EU', 5, '13467'], ['9A', 'EU', 3, '23456'], ['SV', 'EU', 3, '12345789'],
  ['HB', 'EU', 3, '9'], ['OE', 'EU', 3, '123568'], ['EI', 'EU', 2, '23456789'],
  ['CT', 'EU', 2, '12457'], ['Z3', 'EU', 1, '25'], ['E7', 'EU', 1, '1256'],
  ['LX', 'EU', 1, '12'], ['OK', 'EU', 2, '2'],

  // North America
  ['K', 'NA', 10, '0123456789'], ['W', 'NA', 9, '0123456789'], ['N', 'NA', 8, '0123456789'],
  ['AA', 'NA', 3, '0123456789'], ['KB', 'NA', 4, '0123456789'], ['KC', 'NA', 4, '0123456789'],
  ['WA', 'NA', 3, '0123456789'], ['NW', 'NA', 2, '0123456789'], ['AB', 'NA', 2, '0123456789'],
  ['VE', 'NA', 5, '1234567890'], ['VA', 'NA', 2, '234567'], ['XE', 'NA', 2, '123'],
  ['KP', 'NA', 1, '4'], ['TI', 'NA', 1, '258'], ['HI', 'NA', 1, '38'],

  // Asia
  ['JA', 'AS', 8, '0123456789'], ['JH', 'AS', 4, '0123456789'], ['JE', 'AS', 3, '0123456789'],
  ['JF', 'AS', 2, '0123456789'], ['BG', 'AS', 5, '1234567890'], ['BH', 'AS', 4, '1234567'],
  ['BD', 'AS', 4, '1234567'], ['BY', 'AS', 2, '1234567'], ['BV', 'AS', 1, '0123'],
  ['HL', 'AS', 3, '12345'], ['DS', 'AS', 2, '12345'], ['VU', 'AS', 3, '2345678'],
  ['HS', 'AS', 2, '0123456789'], ['9V', 'AS', 1, '1'], ['4X', 'AS', 2, '146'],
  ['A7', 'AS', 1, '1'], ['A6', 'AS', 1, '1'], ['EX', 'AS', 1, '28'],
  ['UN', 'AS', 2, '6789'], ['RA', 'AS', 3, '09'], ['UA', 'AS', 2, '09'],
  ['JT', 'AS', 1, '1'], ['XV', 'AS', 1, '19'], ['YC', 'AS', 1, '0123'],

  // South America
  ['PY', 'SA', 5, '1234567'], ['PP', 'SA', 2, '125'], ['PU', 'SA', 2, '1234567'],
  ['LU', 'SA', 4, '1234567890'], ['CE', 'SA', 3, '1234567'], ['CX', 'SA', 2, '1234789'],
  ['HK', 'SA', 2, '1345'], ['YV', 'SA', 2, '1456'], ['OA', 'SA', 1, '148'],
  ['CP', 'SA', 1, '146'], ['HC', 'SA', 1, '128'], ['ZP', 'SA', 1, '569'],

  // Africa
  ['ZS', 'AF', 3, '12456'], ['5Z', 'AF', 1, '4'], ['9J', 'AF', 1, '2'],
  ['TR', 'AF', 1, '8'], ['TU', 'AF', 1, '2'], ['5N', 'AF', 1, '0'],
  ['SU', 'AF', 1, '1'], ['CN', 'AF', 1, '28'], ['7X', 'AF', 1, '2'],
  ['ST', 'AF', 1, '2'], ['3B', 'AF', 1, '8'], ['FR', 'AF', 1, '5'],
  ['V5', 'AF', 1, '1'], ['Z2', 'AF', 1, '1'], ['5H', 'AF', 1, '3'],

  // Oceania
  ['VK', 'OC', 4, '12345678'], ['ZL', 'OC', 3, '1234'], ['KH', 'OC', 1, '6'],
  ['YB', 'OC', 3, '0123456789'], ['YD', 'OC', 2, '0123456'], ['DU', 'OC', 2, '1234567'],
  ['3D', 'OC', 1, '2'], ['FK', 'OC', 1, '8'], ['FO', 'OC', 1, '5'],
  ['P2', 'OC', 1, '9'], ['E5', 'OC', 1, '1'], ['5W', 'OC', 1, '1'],
];

const TOTAL_WEIGHT = BLOCKS.reduce((s, b) => s + b[2], 0);

function pick(str) {
  return str[(Math.random() * str.length) | 0];
}

function randomSuffix() {
  const r = Math.random();
  const len = r < 0.12 ? 1 : r < 0.55 ? 2 : 3;
  let s = '';
  for (let i = 0; i < len; i++) s += pick(LETTERS);
  return s;
}

function pickBlock() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const b of BLOCKS) {
    r -= b[2];
    if (r <= 0) return b;
  }
  return BLOCKS[0];
}

/** Generates `count` unique callsigns as `{ call, continent }`. */
export function generateCallsigns(count) {
  const seen = new Set();
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 200) {
    const [prefix, continent, , digits] = pickBlock();
    const call = `${prefix}${pick(digits)}${randomSuffix()}`;
    if (seen.has(call)) continue;
    seen.add(call);
    out.push({ call, continent });
  }
  return out;
}

/** Levenshtein distance, used to detect "nearly right" callsigns. */
export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
