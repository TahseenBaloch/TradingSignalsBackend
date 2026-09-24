// New York session clock for FX/CFD markets. OANDA (and TradingView's OANDA charts) roll the trading day at 17:00
// New York time, which is 21:00 or 22:00 UTC depending on US daylight saving, so none of this can be a fixed UTC offset.

const SESSION_HOUR = 17;
const DAY = 86400;
const FRIDAY = 5;
const MONDAY = 1;

const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** New York wall-clock fields for a Unix second. */
function nyParts(sec) {
  const parts = {};
  for (const { type, value } of nyFormat.formatToParts(new Date(sec * 1000))) parts[type] = Number(value);
  return parts;
}

/** Seconds New York is ahead of UTC at this instant (negative: -14400 in summer, -18000 in winter). */
function nyOffset(sec) {
  const p = nyParts(sec);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - sec;
}

/** Unix second of a New York wall-clock time. Month/day may overflow (day 32, day 0); Date.UTC normalizes them. */
function nyToUnix(year, month, day, hour) {
  const wall = Date.UTC(year, month - 1, day, hour) / 1000;
  // Two passes settle the offset even when the first guess lands on the other side of a DST switch.
  let sec = wall - nyOffset(wall);
  sec = wall - nyOffset(sec);
  return sec;
}

/** Start of the trading session containing `sec`: the latest 17:00 New York at or before it. */
function sessionStart(sec) {
  const p = nyParts(sec);
  const dayOffset = p.hour >= SESSION_HOUR ? 0 : -1;
  return nyToUnix(p.year, p.month, p.day + dayOffset, SESSION_HOUR);
}

/** End of the trading session containing `sec`: the next 17:00 New York after it. */
function sessionEnd(sec) {
  const start = sessionStart(sec);
  const p = nyParts(start);
  return nyToUnix(p.year, p.month, p.day + 1, SESSION_HOUR);
}

/** The next Friday 17:00 New York after `sec`, when the FX week (and OANDA's weekly candle) closes. */
function weekEnd(sec) {
  const p = nyParts(sec);
  for (let add = 0; add <= 7; add++) {
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day + add)).getUTCDay();
    if (weekday !== FRIDAY) continue;
    const close = nyToUnix(p.year, p.month, p.day + add, SESSION_HOUR);
    if (close > sec) return close;
  }
  throw new Error('unreachable: a Friday always falls within 8 days');
}

/** Close of the bar containing `sec` on a session-aligned grid (4h bars start at 17:00, 21:00, 01:00 ... New York). */
function sessionGridClose(sec, step) {
  const start = sessionStart(sec);
  const close = start + (Math.floor((sec - start) / step) + 1) * step;
  // A DST day is 23 or 25 hours long, so the last bar of the session ends at the session, not on the grid.
  return Math.min(close, sessionEnd(sec));
}

// TradingView dates a session bar by the day it trades, not the evening it opens: the session opening Sunday 17:00
// New York is "Monday". The same labels keep daily bars one UTC day apart, which is what the chart's time axis expects.

/** Daily label for a session opening at `openSec` (17:00 NY, i.e. 21:00/22:00 UTC): the following UTC midnight. */
function dailyLabel(openSec) {
  return Math.floor(openSec / DAY) * DAY + DAY;
}

/** Weekly label: the first Monday 00:00 UTC after the week opens, matching the Monday-anchored crypto weeks. */
function weeklyLabel(openSec) {
  const midnight = Math.floor(openSec / DAY) * DAY;
  const weekday = new Date(midnight * 1000).getUTCDay();
  const days = (MONDAY - weekday + 7) % 7 || 7;
  return midnight + days * DAY;
}

module.exports = { nyOffset, sessionStart, sessionEnd, weekEnd, sessionGridClose, dailyLabel, weeklyLabel };
