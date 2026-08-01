# Backend

Express server for TradingSignals. Serves auth, the ticker universe, and OHLCV
chart data sourced live from Binance.

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

## Adding a symbol

Add a row to `symbols.js` with its `providerSymbol`. A new data source means a
module in `providers/` plus one entry in the `PROVIDERS` map in
`chart-service.js`.
