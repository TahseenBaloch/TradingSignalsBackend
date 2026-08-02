// On-disk raw candle cache for the backtest seed.
//
// Deliberately NOT Redis. The seed set is roughly 1.9M bars across 7 symbols and
// 4 timeframes; the existing two-tier cache is sized for ~1000-bar chart
// payloads and an Upstash tier would not hold this. Reruns must also be free,
// or every backtest iteration re-pays ~1,900 paginated Binance requests.
//
// Bars are stored as positional tuples for the same reason cache.js uses them:
// repeating six key names across a million rows more than doubles the file.
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = process.env.CANDLE_CACHE_DIR || path.join(__dirname, '..', 'data', 'candles');

const encode = (bars) => bars.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume]);

const decode = (rows) =>
  rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

function fileFor(symbol, interval) {
  // Interval tokens are case-sensitive ('1m' minute vs '1M' month), and Windows
  // filesystems are not, so the token is encoded rather than used raw.
  const safe = interval.replace(/[^0-9a-zA-Z]/g, '') + (interval === interval.toLowerCase() ? '-l' : '-u');
  return path.join(ROOT, `${symbol}-${safe}.json`);
}

async function load(symbol, interval) {
  try {
    const raw = await fs.readFile(fileFor(symbol, interval), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.bars)) return null;
    return { bars: decode(parsed.bars), from: parsed.from, to: parsed.to, symbol, interval };
  } catch {
    return null; // absent or unreadable is simply a miss
  }
}

async function save(symbol, interval, bars) {
  await fs.mkdir(ROOT, { recursive: true });
  const payload = {
    symbol,
    interval,
    from: bars.length ? bars[0].time : null,
    to: bars.length ? bars[bars.length - 1].time : null,
    count: bars.length,
    bars: encode(bars),
  };
  // Write-then-rename, so an interrupted seed cannot leave a half-written file
  // that later parses as a short history and silently truncates a backtest.
  const target = fileFor(symbol, interval);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, JSON.stringify(payload));
  await fs.rename(temp, target);
  return payload.count;
}

/**
 * Returns at least `days` of history for a symbol/interval, fetching only what
 * is missing.
 *
 * @param {Object} spec
 * @param {string} spec.symbol          Public symbol, e.g. BTCUSD.
 * @param {string} spec.providerSymbol  Upstream symbol, e.g. BTCUSDT.
 * @param {string} spec.interval
 * @param {number} spec.days
 * @param {object} spec.provider        providers/binance.
 * @param {(msg: string) => void} [spec.log]
 */
async function ensure({ symbol, providerSymbol, interval, days, provider, log = () => {} }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const wantFrom = nowSec - days * 86_400;

  const cached = await load(symbol, interval);
  if (cached && cached.bars.length > 0 && cached.from <= wantFrom) {
    log(`  ${symbol} ${interval}: ${cached.bars.length} bars cached`);
    return cached.bars;
  }

  // Extend rather than refetch: only the gap between what we hold and what we
  // want is requested.
  const fetchFrom = cached && cached.bars.length > 0 ? Math.min(wantFrom, cached.from) : wantFrom;
  log(`  ${symbol} ${interval}: fetching from ${new Date(fetchFrom * 1000).toISOString().slice(0, 10)}`);

  const { bars } = await provider.fetchRange({
    providerSymbol,
    interval,
    startTime: fetchFrom,
    endTime: nowSec,
    onProgress: ({ fetched }) => {
      if (fetched % 10_000 === 0) log(`    ...${fetched} bars`);
    },
  });

  const merged = mergeBars(cached ? cached.bars : [], bars);
  await save(symbol, interval, merged);
  log(`  ${symbol} ${interval}: ${merged.length} bars stored`);
  return merged;
}

/** Union of two bar arrays by open time, newest definition winning. */
function mergeBars(a, b) {
  const byTime = new Map();
  for (const bar of a) byTime.set(bar.time, bar);
  for (const bar of b) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((x, y) => x.time - y.time);
}

/** Bars within a window, for slicing a seed set down to a backtest range. */
function within(bars, fromTime, toTime) {
  return bars.filter((b) => b.time >= fromTime && b.time < toTime);
}

module.exports = { load, save, ensure, mergeBars, within, ROOT };
