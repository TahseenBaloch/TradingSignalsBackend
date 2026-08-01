// Two-tier cache. L1 is an in-process Map (fast, dies with the process); L2 is
// Redis (survives restarts, optional). Redis is never on the critical path: if
// it is missing, slow or broken we silently fall back to L1.
const { createClient } = require('redis');

const STALE_TTL_SECONDS = 7 * 24 * 60 * 60;

// Backstop for a connection that is up but stalled. It has to comfortably
// exceed the time to move a full candle payload: a ~150ms RTT link still needs
// seconds for ~100KB, and a timeout below that silently disables the L2 cache.
// A genuinely down Redis is caught by the `ready` flag instead, with no wait.
const REDIS_COMMAND_TIMEOUT_MS = Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 5000;

const memory = new Map(); // key -> { value, expiresAt }

let client = null;
let ready = false;
let warned = false;

if (process.env.REDIS_URL) {
  client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
    },
  });

  // Not optional: node-redis emits 'error' as an EventEmitter event, and an
  // unhandled 'error' event takes the whole process down. A flaky connection
  // must degrade to memory, not crash the server.
  client.on('error', (err) => {
    ready = false;
    if (!warned) {
      warned = true;
      console.warn('[cache] redis error, serving from memory:', err.message);
    }
  });
  client.on('ready', () => {
    ready = true;
    warned = false;
    console.log('[cache] redis connected');
  });

  // Deliberately not awaited - the server must boot with or without Redis.
  client.connect().catch((err) => {
    console.warn('[cache] redis unavailable, using memory cache:', err.message);
  });
} else {
  console.log('[cache] REDIS_URL not set, using in-memory cache');
}

// Runs a Redis command with a hard timeout, swallowing every failure. Returns
// null on any problem so callers can treat it as a cache miss.
async function withRedis(op) {
  if (!client || !ready) return null;
  try {
    return await Promise.race([
      op(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('redis command timeout')), REDIS_COMMAND_TIMEOUT_MS)
      ),
    ]);
  } catch {
    return null;
  }
}

function memoryGet(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

function memorySet(key, value, ttlSeconds) {
  // Sweep on write. The universe is small (symbols x intervals), but this keeps
  // the map bounded if it ever grows.
  const now = Date.now();
  for (const [k, v] of memory) {
    if (v.expiresAt <= now) memory.delete(k);
  }
  memory.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
}

// Stored values carry their own expiry so a read needs one round trip rather
// than a GET followed by a TTL.
function envelope(value, ttlSeconds) {
  return JSON.stringify({ exp: Date.now() + ttlSeconds * 1000, data: value });
}

async function get(key) {
  const local = memoryGet(key);
  if (local) return local;

  const raw = await withRedis(() => client.get(key));
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || parsed.data === undefined) return null;

  const remaining = Math.floor((parsed.exp - Date.now()) / 1000);
  if (remaining <= 0) return null;

  // Hydrate L1 so later hits skip the network entirely.
  memorySet(key, parsed.data, remaining);
  return parsed.data;
}

async function set(key, value, ttlSeconds) {
  memorySet(key, value, ttlSeconds);
  await withRedis(() => client.set(key, envelope(value, ttlSeconds), { EX: ttlSeconds }));
}

// Long-lived copy used only when the provider is down and there is no fresh
// entry. Redis-only: an in-memory stale copy would not survive the restart that
// usually accompanies this situation.
async function getStale(key) {
  const raw = await withRedis(() => client.get(`${key}:stale`));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.data !== undefined ? parsed.data : null;
  } catch {
    return null;
  }
}

async function setStale(key, value) {
  await withRedis(() =>
    client.set(`${key}:stale`, envelope(value, STALE_TTL_SECONDS), { EX: STALE_TTL_SECONDS })
  );
}

function backend() {
  return client && ready ? 'redis' : 'memory';
}

module.exports = { get, set, getStale, setStale, backend };
