// Supported chart intervals, keyed by TradingView-style tokens (which is also
// what the frontend already uses). `seconds` is the bar duration, used to align
// cache TTLs to the next bar close.
const INTERVALS = {
  '1m': { binance: '1m', seconds: 60 },
  '5m': { binance: '5m', seconds: 300 },
  '15m': { binance: '15m', seconds: 900 },
  '1h': { binance: '1h', seconds: 3600 },
  '4h': { binance: '4h', seconds: 14400 },
  '1D': { binance: '1d', seconds: 86400 },
  '1W': { binance: '1w', seconds: 604800 },
};

const DEFAULT_INTERVAL = '1D';

// Convenience spellings a client might send. Deliberately does not include a
// blanket lowercase fallback: '1m' (minute) and '1M' (month) are different
// intervals, so case-folding the whole token would silently collide once
// monthly bars get added.
const ALIASES = {
  '1d': '1D',
  d: '1D',
  day: '1D',
  '1w': '1W',
  w: '1W',
  week: '1W',
  60: '1h',
  240: '4h',
};

const SUPPORTED = Object.keys(INTERVALS);

// Returns a canonical interval token, or null if the input is unsupported.
function resolveInterval(token) {
  if (token === undefined || token === null || token === '') return DEFAULT_INTERVAL;
  const raw = String(token).trim();
  if (INTERVALS[raw]) return raw; // exact match wins before any folding
  return ALIASES[raw.toLowerCase()] || null;
}

// Unix seconds at which the bar covering `nowSec` closes.
function nextBarCloseAt(token, nowSec) {
  const { seconds } = INTERVALS[token];
  // Epoch 0 was a Thursday, but weekly bars open Monday 00:00 UTC, so weekly
  // buckets need shifting by 4 days before flooring.
  const offset = token === '1W' ? 345600 : 0;
  return Math.floor((nowSec - offset) / seconds) * seconds + seconds + offset;
}

module.exports = { INTERVALS, SUPPORTED, DEFAULT_INTERVAL, resolveInterval, nextBarCloseAt };
