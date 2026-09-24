# Backend

Express server for TradingSignals. Serves auth, the ticker universe, and OHLCV
chart data from three sources:

| Source | Symbols | Notes |
|---|---|---|
| Binance spot | `BTCUSD`, `ETHUSD`, `PAXGUSD` ... | crypto |
| cTrader broker **or** OANDA | `XAUUSD`, `XAGUSD`, `USOIL`, `UKOIL`, `US500`, `NAS100`, `EURUSD`, `USDJPY` ... | one broker feed, picked by `FX_PROVIDER`: a cTrader account (e.g. IC Markets = TradingView's `ICMARKETS:` symbols) or OANDA (= `OANDA:`) |
| Binance USDⓈ-M futures | `XAUUSDT.P`, `CLUSDT.P`, `SPYUSDT.P`, `NVDAUSDT.P` ... | TradFi perpetuals; real traded volume, so order flow works |

## Setup

```bash
npm install
cp .env.example .env   # then edit
npm run dev
```

Everything in `.env` has a working default except `JWT_SECRET`. `REDIS_URL` may
be left empty — the cache falls back to an in-process map.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | — |
| POST | `/auth/login` | — |
| GET | `/auth/me` | Bearer |
| GET | `/tickers?q=` | Bearer |
| GET | `/chart?symbol=&interval=&limit=` | Bearer |

### `GET /chart`

| param | required | default | notes |
|---|---|---|---|
| `symbol` | yes | — | case-insensitive, must be in the registry |
| `interval` | no | `1D` | see tokens below |
| `limit` | no | `1000` | clamped to 10–1000, returns the most recent bars |

Intervals: `1m`, `5m`, `15m`, `1h`, `4h`, `1D`, `1W`. Tokens are case-sensitive
(`1m` is a minute, `1M` would be a month); `1d`, `1w`, `60` and `240` are
accepted as aliases.

```json
{
  "symbol": "BTCUSD",
  "interval": "1D",
  "candles": [
    { "time": 1785456000, "open": 64780.03, "high": 65409.56, "low": 62466, "close": 62887.88, "volume": 20475.6 }
  ],
  "meta": {
    "provider": "binance", "count": 999, "lastBarClosed": true,
    "nextBarAvailableAt": 1785628800, "cached": true,
    "cacheBackend": "redis", "stale": false
  }
}
```

`time` is Unix **seconds**, UTC, strictly ascending and unique — the format
lightweight-charts expects.

Errors are `{ error, code }`. Unknown symbols and bad intervals return `400`;
provider problems return `502`/`504`.

## Behaviour worth knowing

**The bar currently forming is never returned.** Binance's newest kline is a
partial bar; caching it would freeze an in-progress close and present it as
final. Only closed bars are cached and served, so a `1D` request mid-session
ends at yesterday's bar. The live bar becomes a WebSocket concern.

**Cache TTLs are aligned to the next bar close**, so an entry expires exactly
when new data exists. Redis is optional and never on the critical path: a
missing, slow or failing Redis degrades to the in-process cache. `meta.stale`
signals that the provider failed and a long-lived backup copy was served.

**cTrader feed.** One WebSocket connection (JSON, port 5036) carries everything:
app + account auth, a heartbeat every 10s, reconnects, and token refresh (the
rotated refresh token is saved to `.ctrader-tokens.json`). Candles are the
broker's bid trendbars; history is fetched in windows, which shrink on
`INCORRECT_BOUNDARIES`, and history requests are spaced 250ms apart because
cTrader allows 5/second per connection. Live bars move with every bid tick
(sent at most 4x/second) and are replaced by cTrader's own trendbar at every
bar close and every 30s, so a closed live bar is identical to `/chart`'s.
Daily/weekly bars get TradingView's trading-day dating. Registry rows list the
broker spellings to try (`XTIUSD|USOIL|WTI`), since cTrader brokers name CFDs
differently; `/tickers` hides what the account lacks and reports its digits.

**OANDA symbols match TradingView's OANDA charts.** Candles are OANDA's own,
bid-priced (TradingView draws FX/CFDs from the bid), on New York sessions:
the trading day rolls at 17:00 New York, 4h bars start at 17:00/21:00/01:00...
New York, and daily/weekly bars are dated by the day they trade (the session
opening Sunday evening is Monday's bar), as TradingView dates them. Volume is
tick volume. There is no trade tape, so `/flow` answers `400 flow_unsupported`.
Markets close at weekends and some have a daily break, so bars have gaps; live
bars carry `prevTime` (the previous bar's time) so a client can tell a gap
from missed data. `/tickers` hides OANDA symbols without a token, and hides
any instrument the account cannot trade; `pricePrecision` is OANDA's own.
Live bars come from polling the candles endpoint once a second (every 15s
while the market is shut), so they are exactly the candles `/chart` serves.

**`.P` symbols are perpetuals, not the underlying.** `XAUUSDT.P`, `CLUSDT.P`,
`SPYUSDT.P` and the rest are Binance perps, named as TradingView names them:
close to spot, but with their own basis, and they trade 24/7, so bars keep
printing (near-flat) while the real market is closed. History starts at each
contract's listing (Dec 2025 for gold, Apr 2026 for most others).
`SPYUSDT.P`/`QQQUSDT.P` are priced like the ETFs, not the index. Order flow
works on them, from the futures tape.

**Futures are geo-blocked more widely than spot.** From a restricted region
(the US included) `fapi.binance.com` answers 451, which surfaces as a `502
upstream_error`. Check where the backend is deployed.

## Adding a symbol

Add a row to `symbols.js` with its `provider` (`binance` for spot,
`binance-futures` for perps) and `providerSymbol`. Broker-feed symbols go in
`FX_ROWS` with both an `oanda` instrument (`XAU_USD`) and `ctrader` names
(`XAUUSD|GOLD`). A new data source means a
module in `providers/` plus one entry in the `PROVIDERS` map in
`chart-service.js`, and in `STREAMS_BY_PROVIDER` / `TRADES_BY_PROVIDER` if it
supports live bars or order flow.
