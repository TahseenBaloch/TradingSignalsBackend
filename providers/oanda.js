// OANDA v20 candles: spot FX, metals, energy and index CFDs, the same feed TradingView charts as OANDA:XAUUSD etc.
// A free practice (demo) account's token is enough; nothing here places orders.
const { INTERVALS, nextBarCloseAt: utcGridClose } = require('../intervals');
const { httpError } = require('../http-error');
const time = require('../market-time');

const LIVE = (process.env.OANDA_ENV || 'practice').toLowerCase() === 'live';
const BASE = process.env.OANDA_BASE_URL || (LIVE ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com');
const TOKEN = process.env.OANDA_API_TOKEN || '';
const TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 8000;
// TradingView draws FX/CFD charts from the bid, so bid candles are what make prices match it. M (mid) or A (ask) also work.
const PRICE = ['B', 'M', 'A'].includes(process.env.OANDA_PRICE) ? process.env.OANDA_PRICE : 'B';
const PRICE_FIELD = { B: 'bid', M: 'mid', A: 'ask' }[PRICE];
const MAX_LIMIT = 1000; // OANDA allows 5000; /chart serves 1000, so more would only cost bandwidth

let circuitOpenUntil = 0;

// Filled by loadInstruments(): what this account can trade, with OANDA's own display precision. Null until loaded,
// in which case every symbol is assumed available rather than hiding the whole asset class over a slow startup call.
let instruments = null;

function configured() {
  return Boolean(TOKEN);
}

async function request(path, params) {
  if (!configured()) {
    throw httpError(503, 'provider_unconfigured', 'OANDA is not configured: set OANDA_API_TOKEN');
  }
  if (Date.now() < circuitOpenUntil) {
    throw httpError(429, 'rate_limited', 'Market data provider rate limit hit, backing off');
  }

  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'Accept-Datetime-Format': 'UNIX' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw httpError(504, 'upstream_timeout', 'Market data provider timed out');
    }
    throw httpError(502, 'upstream_unreachable', 'Market data provider unreachable');
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 10;
    circuitOpenUntil = Date.now() + retryAfter * 1000;
    throw httpError(429, 'rate_limited', 'Market data provider rate limit hit');
  }

  const body = await res.json().catch(() => null);

  // A rejected token is our configuration, not the client's request, hence 502 like any other upstream refusal.
  if (res.status === 401 || res.status === 403) {
    throw httpError(502, 'upstream_auth', 'OANDA rejected the API token (check OANDA_API_TOKEN and OANDA_ENV)');
  }
  if (!res.ok) {
    const detail = body && body.errorMessage ? `: ${body.errorMessage}` : '';
    throw httpError(502, 'upstream_error', `Market data provider rejected the request${detail}`);
  }
  if (!body) {
    throw httpError(502, 'upstream_bad_payload', 'Unexpected response from market data provider');
  }
  return body;
}

// Daily and weekly candles open at 17:00 New York the evening before the day they trade; relabel them to the
// trading day (see market-time.js) so they line up with TradingView and sit one UTC day apart.
function labelFor(interval, openSec) {
  if (interval === '1D') return time.dailyLabel(openSec);
  if (interval === '1W') return time.weeklyLabel(openSec);
  return openSec;
}

function normalize(raw, interval) {
  const bars = [];

  for (const c of raw) {
    const quote = c && c[PRICE_FIELD];
    if (!quote) continue;

    const bar = {
      time: labelFor(interval, Math.floor(Number(c.time))),
      open: Number(quote.o),
      high: Number(quote.h),
      low: Number(quote.l),
      close: Number(quote.c),
      volume: Number(c.volume), // tick volume: OANDA has no traded volume, and neither does TradingView's OANDA feed
      // OANDA says outright whether a candle is final. Its clock, not ours, decides - a candle a second past its
      // close can still be incomplete.
      closed: c.complete === true,
    };

    const usable =
      Number.isFinite(bar.time) &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close);
    if (!usable) continue;

    if (!Number.isFinite(bar.volume)) bar.volume = 0;
    bars.push(bar);
  }

  bars.sort((a, b) => a.time - b.time);
  return bars.filter((b, i) => i === bars.length - 1 || b.time !== bars[i + 1].time);
}

async function fetchCandles({ providerSymbol, interval, limit = MAX_LIMIT }) {
  const body = await request(`/v3/instruments/${encodeURIComponent(providerSymbol)}/candles`, {
    price: PRICE,
    granularity: INTERVALS[interval].oanda,
    count: Math.min(limit, MAX_LIMIT),
    // These are OANDA's defaults, pinned so the labels in market-time.js can never drift from the candles.
    dailyAlignment: 17,
    alignmentTimezone: 'America/New_York',
    weeklyAlignment: 'Friday',
  });

  if (!Array.isArray(body.candles)) {
    throw httpError(502, 'upstream_bad_payload', 'Unexpected response from market data provider');
  }

  return { bars: normalize(body.candles, interval), fetchedAt: Math.floor(Date.now() / 1000) };
}

/** When the bar containing `nowSec` closes, on OANDA's New-York-aligned grid. Minute and hour bars match UTC. */
function nextBarCloseAt(interval, nowSec) {
  if (interval === '4h') return time.sessionGridClose(nowSec, INTERVALS['4h'].seconds);
  if (interval === '1D') return time.sessionEnd(nowSec);
  if (interval === '1W') return time.weekEnd(nowSec);
  return utcGridClose(interval, nowSec);
}

/** Learn which instruments this account can chart, and their display precision. Safe to call without a token. */
async function loadInstruments() {
  if (!configured()) return null;

  let accountId = process.env.OANDA_ACCOUNT_ID;
  if (!accountId) {
    const { accounts } = await request('/v3/accounts');
    accountId = accounts && accounts[0] && accounts[0].id;
    if (!accountId) throw new Error('this token has no OANDA accounts');
  }

  const body = await request(`/v3/accounts/${encodeURIComponent(accountId)}/instruments`);
  instruments = new Map(
    (body.instruments || []).map((i) => [i.name, { displayPrecision: Number(i.displayPrecision) }])
  );
  return instruments;
}

function isAvailable(instrument) {
  if (!configured()) return false;
  return instruments ? instruments.has(instrument) : true;
}

function displayPrecision(instrument) {
  const meta = instruments && instruments.get(instrument);
  return meta && Number.isInteger(meta.displayPrecision) ? meta.displayPrecision : null;
}

module.exports = {
  name: 'oanda',
  maxLimit: MAX_LIMIT,
  fetchCandles,
  nextBarCloseAt,
  configured,
  loadInstruments,
  isAvailable,
  displayPrecision,
};
