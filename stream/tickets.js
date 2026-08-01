// Short-lived, single-use credentials for the WebSocket handshake.
//
// The browser cannot send an Authorization header on a WebSocket, and cannot
// read the httpOnly cookie holding the real JWT. So the page exchanges its
// cookie for a ticket over ordinary same-origin HTTP, then puts the ticket in
// the socket URL.
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { JWT_SECRET } = require('../auth');

const TTL_SECONDS = Number(process.env.STREAM_TICKET_TTL_SECONDS) || 30;

// Tickets are single-use: a URL can be replayed from a log or from browser
// history, so a consumed id is refused even while the signature is still valid.
const consumed = new Map(); // jti -> expiry epoch ms

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [jti, expiresAt] of consumed) {
    if (expiresAt <= now) consumed.delete(jti);
  }
}, 60_000);
sweeper.unref(); // never hold the process open

function issue(user) {
  const ticket = jwt.sign(
    { sub: user.sub, email: user.email, typ: 'ws', jti: randomUUID() },
    JWT_SECRET,
    { expiresIn: TTL_SECONDS }
  );
  return { ticket, expiresIn: TTL_SECONDS };
}

// Returns the payload, or null if the ticket is invalid, expired, of the wrong
// type, or already used.
function consume(ticket) {
  if (!ticket) return null;

  let payload;
  try {
    payload = jwt.verify(ticket, JWT_SECRET);
  } catch {
    return null;
  }

  // A stolen 7-day REST token must not work here either.
  if (payload.typ !== 'ws' || !payload.jti) return null;
  if (consumed.has(payload.jti)) return null;

  consumed.set(payload.jti, payload.exp * 1000);
  return payload;
}

module.exports = { issue, consume, TTL_SECONDS };
