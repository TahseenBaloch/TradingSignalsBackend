// Diagnose cTrader Open API credentials step by step, without printing any secret:
//   npm run check:ctrader
// 1) app auth (client id/secret; fails until Spotware activates the app), 2) access token -> accounts,
// 3) account auth, 4) the symbols this site needs, 5) one gold candle and one live tick.
require('dotenv').config({ quiet: true });
const WebSocket = require('ws');

const LIVE = (process.env.CTRADER_ENV || 'demo').toLowerCase() === 'live';
const URL_ = process.env.CTRADER_WS_URL || `wss://${LIVE ? 'live' : 'demo'}.ctraderapi.com:5036`;
const { CTRADER_CLIENT_ID: id, CTRADER_CLIENT_SECRET: secret, CTRADER_ACCESS_TOKEN: token } = process.env;
const WANTED = ['XAUUSD', 'XAGUSD', 'XTIUSD|USOIL|WTI', 'XBRUSD|UKOIL|BRENT', 'US500|SPX500', 'USTEC|NAS100|US100', 'US30', 'DE40|GER40', 'EURUSD', 'GBPUSD', 'USDJPY'];

const mask = (v) => (v ? `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)` : '(not set)');
console.log(`endpoint      ${URL_}`);
console.log(`client id     ${mask(id)}`);
console.log(`client secret ${secret ? `set (${secret.length} chars)` : '(not set)'}`);
console.log(`access token  ${token ? `set (${token.length} chars)` : '(not set)'}\n`);
if (!id || !secret) {
  console.log('Set CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const ws = new WebSocket(URL_);
let n = 0;
const pending = new Map();
function call(payloadType, payload) {
  return new Promise((resolve, reject) => {
    const clientMsgId = `c${++n}`;
    pending.set(clientMsgId, { resolve, reject });
    ws.send(JSON.stringify({ clientMsgId, payloadType, payload }));
    setTimeout(() => pending.has(clientMsgId) && (pending.delete(clientMsgId), reject(new Error('timed out'))), 10_000);
  });
}
let onTick = null;
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.payloadType === 2131 && onTick) return onTick(m.payload);
  const job = m.clientMsgId && pending.get(m.clientMsgId);
  if (!job) return;
  pending.delete(m.clientMsgId);
  if (m.payloadType === 2142 || m.payloadType === 50) job.reject(new Error(`${m.payload.errorCode}${m.payload.description ? `: ${m.payload.description}` : ''}`));
  else job.resolve(m.payload);
});
ws.on('error', (err) => {
  console.log(`FAIL  cannot reach ${URL_}: ${err.message}`);
  process.exit(1);
});

const step = async (label, fn, hint) => {
  try {
    const out = await fn();
    console.log(`OK    ${label}${out ? ` - ${out}` : ''}`);
  } catch (err) {
    console.log(`FAIL  ${label} - ${err.message}${hint ? `\n      ${hint}` : ''}`);
    process.exit(1);
  }
};

ws.on('open', async () => {
  const heartbeat = setInterval(() => ws.send(JSON.stringify({ payloadType: 51, payload: {} })), 10_000);
  await step('1. application auth (client id + secret)', () => call(2100, { clientId: id, clientSecret: secret }).then(() => ''),
    'CH_CLIENT_AUTH_FAILURE usually means the app is not activated yet (status still "Submitted") or the id/secret were copied wrong.');

  if (!token) {
    console.log('\nApp credentials work. Next: generate tokens in the Playground and set CTRADER_ACCESS_TOKEN / CTRADER_REFRESH_TOKEN.');
    clearInterval(heartbeat);
    return process.exit(0);
  }

  let account;
  await step('2. access token -> accounts', async () => {
    const res = await call(2149, { accessToken: token });
    const list = res.ctidTraderAccount || [];
    const wantId = process.env.CTRADER_ACCOUNT_ID && Number(process.env.CTRADER_ACCOUNT_ID);
    account = list.find((a) => (wantId ? Number(a.ctidTraderAccountId) === wantId : Boolean(a.isLive) === LIVE));
    const summary = list.map((a) => `${a.brokerTitleShort || '?'} ${a.isLive ? 'live' : 'demo'} #${a.traderLogin}`).join(', ');
    if (!account) throw new Error(`no ${LIVE ? 'live' : 'demo'} account on this token (found: ${summary || 'none'})`);
    return `using ${account.brokerTitleShort || 'broker'} ${account.isLive ? 'live' : 'demo'} #${account.traderLogin} (id ${account.ctidTraderAccountId}); all: ${summary}`;
  }, 'Regenerate the token in the Playground with the "accounts" scope, logged in with the cTrader ID that owns the demo account.');
  const acc = Number(account.ctidTraderAccountId);

  await step('3. account auth', () => call(2102, { ctidTraderAccountId: acc, accessToken: token }).then(() => ''));

  let byName;
  await step('4. symbols this site needs', async () => {
    const res = await call(2114, { ctidTraderAccountId: acc });
    byName = new Map((res.symbol || []).map((s) => [String(s.symbolName).toUpperCase().replace(/[^A-Z0-9]/g, ''), s]));
    const found = [];
    const missing = [];
    for (const w of WANTED) {
      const hit = w.split('|').map((x) => byName.get(x)).find(Boolean);
      (hit ? found : missing).push(hit ? hit.symbolName : w);
    }
    return `${byName.size} symbols; found ${found.join(', ')}${missing.length ? `; MISSING ${missing.join(', ')}` : ''}`;
  });

  const gold = byName.get('XAUUSD');
  if (gold) {
    await step('5. latest XAUUSD 1m candles', async () => {
      // The per-request window cap is undocumented; report which one the server accepts.
      const now = Date.now();
      for (const days of [4, 2, 1, 0.5]) {
        try {
          const res = await call(2137, { ctidTraderAccountId: acc, symbolId: gold.symbolId, period: 1, fromTimestamp: now - days * 86400000, toTimestamp: now, count: 3 });
          const bars = (res.trendbar || []).map((t) => `${new Date(t.utcTimestampInMinutes * 60000).toISOString().slice(0, 16)}Z C=${(t.low + t.deltaClose) / 1e5}`);
          return `${bars.join(' | ') || 'no bars returned'} (${days}-day M1 window accepted)`;
        } catch (err) {
          if (!String(err.message).startsWith('INCORRECT_BOUNDARIES')) throw err;
        }
      }
      throw new Error('every window was rejected with INCORRECT_BOUNDARIES');
    });
    await step('6. live XAUUSD tick (waits up to 15s; none while the market is closed)', async () => {
      await call(2127, { ctidTraderAccountId: acc, symbolId: [gold.symbolId], subscribeToSpotTimestamp: true });
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve('no tick in 15s (normal at weekends)'), 15_000);
        onTick = (p) => {
          if (p.bid === undefined) return;
          clearTimeout(timer);
          resolve(`bid ${p.bid / 1e5} at ${new Date(Number(p.timestamp) || Date.now()).toISOString()}`);
        };
      });
    });
  }
  console.log('\nAll good: start the backend and the cTrader symbols will appear.');
  clearInterval(heartbeat);
  process.exit(0);
});
