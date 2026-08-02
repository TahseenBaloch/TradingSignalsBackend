// Backtest reports and the measured-probability store, on disk.
//
// Disk rather than Redis: reports are large, append-mostly, and must survive a
// restart whether or not REDIS_URL is set. cache.js degrades silently to memory
// when Redis is absent, which is right for chart payloads and wrong for the
// stats the live UI quotes probabilities from — those disappearing on restart
// would silently turn every signal into "insufficient data".
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = process.env.REPORT_DIR || path.join(__dirname, '..', 'data');
const REPORTS = path.join(ROOT, 'reports');
const STATS_FILE = path.join(ROOT, 'stats.json');

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value));
  await fs.rename(temp, file); // atomic, so a crash cannot leave half a report
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const saveReport = (id, report) => writeJson(path.join(REPORTS, `${id}.json`), report);
const loadReport = (id) => readJson(path.join(REPORTS, `${id}.json`));

async function listReports() {
  try {
    const files = await fs.readdir(REPORTS);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

const saveStats = (store) => writeJson(STATS_FILE, store);
const loadStats = () => readJson(STATS_FILE);

module.exports = { saveReport, loadReport, listReports, saveStats, loadStats, ROOT, REPORTS, STATS_FILE };
