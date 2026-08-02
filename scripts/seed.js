#!/usr/bin/env node
// Seed script: pulls deep history, runs the full backtest suite, and prints the
// cadence and out-of-sample tables the Signal Frequency Requirement and Rule 7
// are judged on.
//
//   node scripts/seed.js                      full run, all symbols and presets
//   node scripts/seed.js --symbols BTCUSD     limit symbols
//   node scripts/seed.js --presets Balanced   limit presets
//   node scripts/seed.js --fetch-only         populate the candle cache and stop
//   node scripts/seed.js --skip-fetch         use whatever is already cached
//
// Candles are cached on disk, so only the first run pays for the ~1,200
// paginated Binance requests.
require('dotenv').config({ quiet: true });

const { SYMBOLS } = require('../symbols');
const binance = require('../providers/binance');
const candleStore = require('../store/candles');
const reportStore = require('../store/reports');
const backtest = require('../engine/backtest');
const config = require('../engine/config');

// Deeper history on the higher timeframes, where bars are cheap; 1m is capped
// at 60 days because that alone is ~87 paginated requests per symbol.
const HISTORY = {
  '1m': 60,
  '5m': 180,
  '15m': 180,
  '1h': 730,
  '4h': 730,
};

// Two runs per symbol. 1m has to be scoped to its own 60-day window, and mixing
// it with the 180-day 5m/15m run would silently truncate the latter.
const RUNS = [
  {
    id: 'scalp-1m',
    entry: ['1m'],
    timeframes: ['1m', '5m', '15m', '1h', '4h'],
    days: 60,
    // Windows are scaled to available history. The config's 180/60 default
    // yields ZERO windows against 60 days of 1m, which would look like a clean
    // run while measuring nothing.
    walkForward: { trainDays: 20, testDays: 10, stepDays: 10 },
  },
  {
    id: 'scalp-5m-15m',
    entry: ['5m', '15m'],
    timeframes: ['5m', '15m', '1h', '4h'],
    days: 180,
    walkForward: { trainDays: 90, testDays: 30, stepDays: 30 },
  },
];

function parseArgs(argv) {
  const args = { symbols: null, presets: null, fetchOnly: false, skipFetch: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fetch-only') args.fetchOnly = true;
    else if (arg === '--skip-fetch') args.skipFetch = true;
    else if (arg === '--symbols') args.symbols = argv[++i].split(',');
    else if (arg === '--presets') args.presets = argv[++i].split(',');
  }
  return args;
}

const log = (msg) => console.log(msg);
const pct = (x) => (x === null || x === undefined ? '   n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x, digits = 2) => (x === null || x === undefined ? 'n/a' : x.toFixed(digits));

async function fetchAll(symbols) {
  log('\n=== Fetching history ===');
  const failures = [];

  for (const symbol of symbols) {
    log(`${symbol.symbol}:`);
    for (const [interval, days] of Object.entries(HISTORY)) {
      try {
        await candleStore.ensure({
          symbol: symbol.symbol,
          providerSymbol: symbol.providerSymbol,
          interval,
          days,
          provider: binance,
          log,
        });
      } catch (err) {
        // One symbol failing must not discard everything already downloaded.
        // The run continues and the gaps are reported at the end, so a rerun
        // picks up only what is actually missing.
        log(`  ${symbol.symbol} ${interval}: FAILED - ${err.message}`);
        failures.push(`${symbol.symbol} ${interval}: ${err.message}`);
      }
    }
  }

  if (failures.length > 0) {
    log(`\n${failures.length} fetch failure(s); rerun to fill the gaps:`);
    for (const f of failures) log(`  ${f}`);
  }
  return failures;
}

async function loadSeries(symbol, timeframes, days) {
  const nowSec = Math.floor(Date.now() / 1000);
  const from = nowSec - days * 86_400;
  const series = {};

  for (const tf of timeframes) {
    const cached = await candleStore.load(symbol, tf);
    if (!cached) throw new Error(`No cached candles for ${symbol} ${tf} — run without --skip-fetch`);
    series[tf] = candleStore.within(cached.bars, from, nowSec);
  }
  return series;
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = SYMBOLS.filter((s) => !args.symbols || args.symbols.includes(s.symbol));
  const presets = args.presets || ['Conservative', 'Balanced', 'Aggressive'];

  if (!args.skipFetch) await fetchAll(symbols);
  if (args.fetchOnly) {
    log('\nFetch complete.');
    return;
  }

  const results = [];

  for (const preset of presets) {
    const resolved = config.resolve(preset);

    for (const run of RUNS) {
      for (const symbol of symbols) {
        const started = Date.now();
        const series = await loadSeries(symbol.symbol, run.timeframes, run.days);
        const barCount = Object.values(series).reduce((sum, b) => sum + b.length, 0);
        if (barCount === 0) {
          log(`  skip ${symbol.symbol} ${run.id} ${preset}: no bars`);
          continue;
        }

        const input = {
          symbol: symbol.symbol,
          series,
          entryTimeframes: run.entry,
          config: resolved,
        };

        const both = backtest.runBothVariants(input);
        const wf = backtest.walkForward({ ...input, windows: run.walkForward, warmupBars: 250 });

        const record = {
          id: `${symbol.symbol}-${run.id}-${preset}`,
          symbol: symbol.symbol,
          run: run.id,
          preset,
          entryTimeframes: run.entry,
          walkForwardWindows: run.walkForward,
          ladder: backtest.summaryOf(both.ladder),
          simple: backtest.summaryOf(both.simple),
          walkForward: wf,
          patternStats: both.ladder.patternStats,
          trades: both.ladder.trades.length,
          elapsedMs: Date.now() - started,
        };

        await reportStore.saveReport(record.id, {
          ...record,
          tradeList: both.ladder.trades.slice(0, 2000),
        });
        results.push({ ...record, _full: both.ladder });

        log(
          `  ${symbol.symbol.padEnd(8)} ${run.id.padEnd(14)} ${preset.padEnd(13)} ` +
            `signals ${String(both.ladder.signals).padStart(5)}  trades ${String(both.ladder.overall.trades).padStart(5)}  ` +
            `netR ${num(both.ladder.overall.totalR, 1).padStart(8)}  ${((Date.now() - started) / 1000).toFixed(1)}s`
        );
      }
    }
  }

  // The probability store the live UI quotes from is built only from these runs.
  const store = backtest.buildStore(
    results.filter((r) => r.preset === config.DEFAULT_PRESET).map((r) => r._full),
    config.BACKTEST.probabilityMinSample
  );
  await reportStore.saveStats(store);

  printCadence(results);
  printPerformance(results);
  printStrategies(results);
  printVariants(results);
  printQualification(results);

  log(`\nReports written to ${reportStore.REPORTS}`);
  log(`Probability store written to ${reportStore.STATS_FILE}`);
}

// --------------------------------------------------------------------------
// tables
// --------------------------------------------------------------------------

function printCadence(results) {
  log('\n\n=== CADENCE (signals per hour, per symbol per timeframe) ===');
  log('Target: multiple/hour across watched symbols; ~1/hour or better per active symbol on Balanced.\n');

  const presets = [...new Set(results.map((r) => r.preset))];
  const timeframes = ['1m', '5m', '15m'];

  log(`${'preset'.padEnd(14)}${timeframes.map((t) => `${t} sig/h`.padStart(12)).join('')}${'combined/h'.padStart(13)}${'trades/day'.padStart(13)}`);
  log('-'.repeat(14 + 12 * 3 + 13 + 13));

  for (const preset of presets) {
    const cells = [];
    let combined = 0;
    let tradesPerDay = 0;

    for (const tf of timeframes) {
      const rows = results.filter((r) => r.preset === preset && r.entryTimeframes.includes(tf));
      const perHour = mean(rows.map((r) => (r.ladder.byTimeframe[tf] || {}).signalsPerDay).filter(isNum)) / 24;
      const tpd = mean(rows.map((r) => (r.ladder.byTimeframe[tf] || {}).tradesPerDay).filter(isNum));
      cells.push(num(perHour, 2).padStart(12));
      if (isNum(perHour)) combined += perHour;
      if (isNum(tpd)) tradesPerDay += tpd;
    }

    log(`${preset.padEnd(14)}${cells.join('')}${num(combined, 2).padStart(13)}${num(tradesPerDay, 1).padStart(13)}`);
  }

  log('\nPer-symbol detail (Balanced):');
  const balanced = results.filter((r) => r.preset === 'Balanced');
  log(`${'symbol'.padEnd(10)}${timeframes.map((t) => t.padStart(11)).join('')}${'total/h'.padStart(11)}`);
  for (const symbol of [...new Set(balanced.map((r) => r.symbol))]) {
    const cells = [];
    let total = 0;
    for (const tf of timeframes) {
      const row = balanced.find((r) => r.symbol === symbol && r.entryTimeframes.includes(tf));
      const perHour = row && row.ladder.byTimeframe[tf] ? row.ladder.byTimeframe[tf].signalsPerDay / 24 : null;
      cells.push(num(perHour, 2).padStart(11));
      if (isNum(perHour)) total += perHour;
    }
    log(`${symbol.padEnd(10)}${cells.join('')}${num(total, 2).padStart(11)}`);
  }
}

function printPerformance(results) {
  log('\n\n=== OUT-OF-SAMPLE PERFORMANCE (walk-forward, net of costs) ===');
  log('Rule 7 gate: profit factor >= 1.2 with >= 50 trades, OUT OF SAMPLE.\n');

  log(
    `${'symbol'.padEnd(9)}${'run'.padEnd(15)}${'preset'.padEnd(13)}` +
      `${'trades'.padStart(8)}${'win%'.padStart(8)}${'PF'.padStart(7)}${'expR'.padStart(8)}` +
      `${'maxDD'.padStart(8)}${'costR/t'.padStart(9)}${'drag%'.padStart(8)}${'  Rule7'}`
  );
  log('-'.repeat(105));

  for (const r of results) {
    const m = r.walkForward.pooled.outOfSample;
    const q = r.walkForward.qualification;
    log(
      `${r.symbol.padEnd(9)}${r.run.padEnd(15)}${r.preset.padEnd(13)}` +
        `${String(m.trades).padStart(8)}${pct(m.winRate).padStart(8)}${num(m.profitFactor).padStart(7)}` +
        `${num(m.expectancyR).padStart(8)}${num(m.maxDrawdownR, 1).padStart(8)}` +
        `${num(m.costPerTradeR).padStart(9)}${num(m.costDragPercent, 0).padStart(8)}` +
        `  ${q.ok ? 'PASS' : 'fail'}`
    );
  }
}

function printStrategies(results) {
  log('\n\n=== PER-STRATEGY (Balanced, in-sample pooled across symbols) ===\n');
  const balanced = results.filter((r) => r.preset === 'Balanced');
  const byStrategy = new Map();

  for (const r of balanced) {
    for (const trade of r._full.trades) {
      if (!byStrategy.has(trade.strategyId)) byStrategy.set(trade.strategyId, []);
      byStrategy.get(trade.strategyId).push(trade);
    }
  }

  log(`${'strategy'.padEnd(26)}${'trades'.padStart(8)}${'win%'.padStart(8)}${'PF'.padStart(7)}${'expR'.padStart(8)}${'costR/t'.padStart(9)}${'grossExpR'.padStart(11)}`);
  log('-'.repeat(77));

  for (const [id, trades] of [...byStrategy].sort((a, b) => b[1].length - a[1].length)) {
    const m = backtest.metrics.summarise(trades);
    log(
      `${id.padEnd(26)}${String(m.trades).padStart(8)}${pct(m.winRate).padStart(8)}` +
        `${num(m.profitFactor).padStart(7)}${num(m.expectancyR).padStart(8)}` +
        `${num(m.costPerTradeR).padStart(9)}${num(m.grossExpectancyR).padStart(11)}`
    );
  }
}

function printVariants(results) {
  log('\n\n=== LADDER vs SIMPLE EXIT (identical entries, net of costs) ===\n');
  log(`${'preset'.padEnd(14)}${'ladder expR'.padStart(14)}${'simple expR'.padStart(14)}${'ladder PF'.padStart(12)}${'simple PF'.padStart(12)}${'  winner'}`);
  log('-'.repeat(72));

  for (const preset of [...new Set(results.map((r) => r.preset))]) {
    const rows = results.filter((r) => r.preset === preset);
    const ladderExp = mean(rows.map((r) => r.ladder.metrics.expectancyR).filter(isNum));
    const simpleExp = mean(rows.map((r) => r.simple.metrics.expectancyR).filter(isNum));
    const ladderPf = mean(rows.map((r) => r.ladder.metrics.profitFactor).filter(isNum));
    const simplePf = mean(rows.map((r) => r.simple.metrics.profitFactor).filter(isNum));

    log(
      `${preset.padEnd(14)}${num(ladderExp, 3).padStart(14)}${num(simpleExp, 3).padStart(14)}` +
        `${num(ladderPf).padStart(12)}${num(simplePf).padStart(12)}` +
        `  ${ladderExp > simpleExp ? 'ladder' : 'simple'}`
    );
  }
}

function printQualification(results) {
  log('\n\n=== RULE 7 SUMMARY — what ships enabled ===\n');
  const passing = results.filter((r) => r.walkForward.qualification.ok);
  const failing = results.filter((r) => !r.walkForward.qualification.ok);

  log(`Qualified (out-of-sample PF >= 1.2, >= 50 trades): ${passing.length} of ${results.length}`);
  for (const r of passing) {
    log(`  PASS  ${r.symbol} ${r.run} ${r.preset}`);
  }

  if (failing.length > 0) {
    log('\nFailing — these ship DISABLED by default, with their stats visible:');
    const reasons = new Map();
    for (const r of failing) {
      const key = r.walkForward.qualification.reasons.join('; ');
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      log(`  ${String(count).padStart(3)}x  ${reason}`);
    }
  }
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

main().catch((err) => {
  console.error('\nSeed failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
