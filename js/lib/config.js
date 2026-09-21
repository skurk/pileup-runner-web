// Shared constants. Frequencies are expressed as signed Hz offsets from BAND_CENTER_HZ.

export const SAMPLE_RATE = 48000;
export const SPAN_HZ = SAMPLE_RATE; // complex I/Q -> 48 kHz of spectrum
export const BAND_CENTER_HZ = 14024000;

export const FFT_SIZE = 2048;
export const BIN_HZ = SPAN_HZ / FFT_SIZE; // 23.4375 Hz
export const HOP = 480; // 10 ms -> 100 waterfall columns/s
export const SLOW_DECIM = 25; // 4 columns/s on the slow waterfall

export const DECIM = 4;
export const RATE2 = SAMPLE_RATE / DECIM;

export const TX_OFFSET_HZ = 1000; // operator transmit frequency
export const PILEUP_START_HZ = TX_OFFSET_HZ + 1000; // pileup starts 1 kHz above TX
export const PILEUP_SPREAD_HZ = 9000;

export const QSY_CLEAR_THRESHOLD_HZ = 300; // >300 Hz QSY clears the callsign box

export const MIN_BW = 100;
export const MAX_BW = 3000;

export const DIFFICULT_ALWAYS = ['SA', 'AF', 'OC'];

export const COMPETITION = Object.freeze({
  callers: 100,
  snrDb: 15,
  minutes: 15,
});

export const DEFAULT_SETTINGS = Object.freeze({
  dxCall: 'LA2T',
  opCall: '',
  callers: 100,
  snrDb: 15,
  difficult: 'EU',
  minutes: 15,
  mode: 'practice',
  pitch: 600,
  bandwidth: 500,
  afGain: 0.7,
  sidetoneGain: 0.35,
  wpm: 30,
  esm: false,
  autoDxCallEvery: 4,
  messages: {
    F1: 'QRZ DE <my_call> UP',
    F2: '5NN',
    F3: 'TU UP',
    F4: '<my_call>',
    F5: '<his_call>',
    F6: 'NIL',
    F7: 'AGN',
  },
});
