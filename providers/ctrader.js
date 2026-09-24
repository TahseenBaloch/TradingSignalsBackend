// cTrader Open API candles ("trendbars") from a broker's cTrader account - e.g. an IC Markets demo, whose prices are
// TradingView's ICMARKETS:XAUUSD. Bars are bid-based and carry tick volume. Registry providerSymbols may list several
// broker spellings ('XTIUSD|USOIL'); the first the account carries wins.
const { INTERVALS, nextBarCloseAt: utcGridClose } = require('../intervals');
const { httpError } = require('../http-error');
const client = require('./ctrader-client');

const MAX_LIMIT = 1000;
const DAY = 86400;
const MONDAY = 1;

// ProtoOATrendbarPeriod enum values.
const PERIOD = { '1m': 1, '5m': 5, '15m': 7, '1h': 9, '4h': 10, '1D': 12, '1W': 13 };

// cTrader caps the from/to distance of one trendbar request per period (answering INCORRECT_BOUNDARIES beyond it)
// without publishing the caps, so these start conservative and halve on rejection.
const MAX_WINDOW_SECONDS = {
  '1m': 3 * DAY,
  '5m': 14 * DAY,
  '15m': 30 * DAY,
  '1h': 90 * DAY,
  '4h': 365 * DAY,
  '1D': 5 * 365 * DAY,
  '1W': 20 * 365 * DAY,
};
const MIN_WINDOW_SECONDS = 4 * DAY;
// Enough back-to-back windows to cover 1000 bars across weekends and holidays.
const MAX_CHUNKS = 6;

/** cTrader prices are integers in 1/100000 of a unit; rounding to the symbol's digits removes float noise. */
function price(raw, digits) {
  return Number((Number(raw) / 100000).toFixed(digits));
}

// Daily and weekly bars get TradingView's dating. If the broker opens its day at 17:00 New York (21:00/22:00 UTC)
// the bar belongs to the next UTC day; a bar already opening at midnight UTC is left alone. Weeks go to their Monday.
function labelFor(interval, openSec) {
  if (interval === '1D') {
    return openSec % DAY === 0 ? openSec : Math.floor(openSec / DAY) * DAY + DAY;
  }
  if (interval === '1W') {
    const midnight = Math.floor(openSec / DAY) * DAY;
    const weekday = new Date(midnight * 1000).getUTCDay();
    if (weekday === MONDAY && openSec === midnight) return openSec;
    return midnight + (((MONDAY - weekday + 7) % 7) || 7) * DAY;
  }
  return openSec;
}

/** One cTrader trendbar as a chart bar, or null if malformed. Shared by history and the live stream so both date and price bars identically. A live trendbar may omit deltaClose (its close is the current bid), which `hasClose` reports. */
function decodeTrendbar(t, interval, digits, nowSec) {
  const open = Number(t.utcTimestampInMinutes) * 60;
  const low = Number(t.low);
  if (!Number.isFinite(open) || !Number.isFinite(low)) return null;
  const bar = {
    time: labelFor(interval, open),
    open: price(low + Number(t.deltaOpen || 0), digits),
    high: price(low + Number(t.deltaHigh || 0), digits),
    low: price(low, digits),
    close: price(low + Number(t.deltaClose || 0), digits),
    hasClose: t.deltaClose !== undefined && t.deltaClose !== null,
    volume: Number(t.volume) || 0, // tick volume, as on TradingView's broker feeds
    // cTrader does not flag the forming bar, so a bar is closed once its nominal period has elapsed.
    closeTime: open + INTERVALS[interval].seconds,
  };
  bar.closed = bar.closeTime <= nowSec;
  return bar;
}

function decode(trendbars, interval, digits, nowSec) {
  const bars = [];
  for (const t of trendbars || []) {
    const bar = decodeTrendbar(t, interval, digits, nowSec);
    if (!bar) continue;
    delete bar.hasClose;
    bars.push(bar);
  }
  bars.sort((a, b) => a.time - b.time);
  return bars.filter((b, i) => i === bars.length - 1 || b.time !== bars[i + 1].time);
}

async function fetchWindow(symbolId, interval, fromSec, toSec, count) {
  return client.request(client.PT.GET_TRENDBARS_REQ, {
    symbolId,
    period: PERIOD[interval],
    fromTimestamp: fromSec * 1000,
    toTimestamp: toSec * 1000,
    count,
  });
}

async function fetchCandles({ providerSymbol, interval, limit = MAX_LIMIT }) {
  if (!PERIOD[interval]) throw httpError(400, 'invalid_interval', `Unsupported interval: ${interval}`);
  const want = Math.min(limit, MAX_LIMIT);
  const info = await client.symbolInfo(providerSymbol);
  const nowSec = Math.floor(Date.now() / 1000);
  const step = INTERVALS[interval].seconds;

  // Never narrower than a long weekend, or a request for the last few bars made on a Saturday finds none.
  let windowSec = Math.min(MAX_WINDOW_SECONDS[interval], Math.max(want * step * 2, MIN_WINDOW_SECONDS));
  let toSec = nowSec + step; // include the forming bar
  const raw = [];

  for (let chunk = 0; chunk < MAX_CHUNKS && raw.length < want; chunk++) {
    const fromSec = Math.max(0, toSec - windowSec);
    const requested = want - raw.length;
    let res;
    try {
      res = await fetchWindow(info.symbolId, interval, fromSec, toSec, requested);
    } catch (err) {
      if (err.providerCode === 'INCORRECT_BOUNDARIES' && windowSec > step * 10) {
        windowSec = Math.floor(windowSec / 2);
        MAX_WINDOW_SECONDS[interval] = Math.min(MAX_WINDOW_SECONDS[interval], windowSec);
        chunk -= 1;
        continue;
      }
      if (raw.length) break; // keep what we already have rather than failing the whole chart
      throw err;
    }
    const got = res.trendbar || [];
    raw.push(...got);
    if (fromSec === 0) break;
    // A window cut short by `count` still has older bars in it, so resume just before its oldest bar;
    // otherwise the whole window was consumed and the next one starts where it began.
    const oldest = got.reduce((m, t) => Math.min(m, Number(t.utcTimestampInMinutes) * 60), Infinity);
    toSec = got.length >= requested && Number.isFinite(oldest) ? oldest - 1 : fromSec - 1;
  }

  const bars = decode(raw, interval, info.digits, nowSec);
  return { bars: bars.slice(-want), fetchedAt: nowSec, digits: info.digits };
}

/** Close of the bar containing `nowSec`. Minute/hour bars are on the UTC grid; the chart service prefers the forming bar's own close when it has one. */
function nextBarCloseAt(interval, nowSec) {
  return utcGridClose(interval, nowSec);
}

module.exports = {
  name: 'ctrader',
  PERIOD,
  labelFor,
  decodeTrendbar,
  maxLimit: MAX_LIMIT,
  ttlFromFormingBar: true,
  fetchCandles,
  nextBarCloseAt,
  configured: client.configured,
  isAvailable: (providerSymbol) => client.configured() && client.isListed(providerSymbol),
  displayPrecision: (providerSymbol) => client.digitsFor(providerSymbol),
};
