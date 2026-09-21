import { BAND_CENTER_HZ } from './config.js';

function field(name, value) {
  const v = value == null ? '' : String(value);
  return `<${name}:${v.length}>${v}`;
}

function stamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return {
    date: `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`,
    time: `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`,
  };
}

export function toAdif(session, wallStart) {
  const lines = [
    'Pileup Runner Web session log',
    field('ADIF_VER', '3.1.4'),
    field('PROGRAMID', 'PileupRunnerWeb'),
    '<EOH>',
    '',
  ];

  for (const q of session.log) {
    const when = new Date(wallStart + (q.at - session.startTime) * 1000);
    const { date, time } = stamp(when);
    const mhz = ((BAND_CENTER_HZ + q.freq) / 1e6).toFixed(6);
    lines.push([
      field('CALL', q.correct || q.call),
      field('QSO_DATE', date),
      field('TIME_ON', time),
      field('BAND', '20m'),
      field('FREQ', mhz),
      field('MODE', 'CW'),
      field('RST_SENT', '599'),
      field('RST_RCVD', '599'),
      field('CONT', q.continent),
      field('STATION_CALLSIGN', session.settings.dxCall),
      field('OPERATOR', session.settings.opCall),
      field('COMMENT', `status=${q.status.trim() || 'none'} pts=${q.points} snr=${q.snr}dB`),
      '<EOR>',
    ].join(' '));
  }

  return lines.join('\n');
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
