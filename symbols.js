// One row per symbol we serve. `aliases` are search-only and never resolve a symbol; `smtPeer` pairs must be mutual.
const SYMBOLS = [
  { symbol: 'BTCUSD', name: 'Bitcoin / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'BTCUSDT', smtPeer: 'ETHUSD' },
  { symbol: 'ETHUSD', name: 'Ethereum / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'ETHUSDT', smtPeer: 'BTCUSD' },
  { symbol: 'SOLUSD', name: 'Solana / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'SOLUSDT' },
  { symbol: 'XRPUSD', name: 'XRP / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'XRPUSDT' },
  { symbol: 'BNBUSD', name: 'BNB / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'BNBUSDT' },
  { symbol: 'ADAUSD', name: 'Cardano / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'ADAUSDT' },
  { symbol: 'DOGEUSD', name: 'Dogecoin / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'DOGEUSDT' },

  // PAX Gold tracks spot XAU/USD within a few dollars but is not spot gold: own premium, token volume, and no weekend gap.
  {
    symbol: 'PAXGUSD',
    name: 'PAX Gold / U.S. Dollar',
    exchange: 'BINANCE',
    provider: 'binance',
    providerSymbol: 'PAXGUSDT',
    aliases: ['gold', 'xau', 'xauusd'],
    smtPeer: 'XAUTUSD',
  },

  // Tether Gold, carried as PAXG's SMT peer: same metal, but a fifth of the trade count, so PAXG stays primary.
  {
    symbol: 'XAUTUSD',
    name: 'Tether Gold / U.S. Dollar',
    exchange: 'BINANCE',
    provider: 'binance',
    providerSymbol: 'XAUTUSDT',
    aliases: ['gold', 'xaut'],
    smtPeer: 'PAXGUSD',
  },
];

const BY_SYMBOL = new Map(SYMBOLS.map((s) => [s.symbol, s]));

// Public projection for GET /tickers; provider details stay server-side so the registry can grow without changing the API.
const tickers = SYMBOLS.map(({ symbol, name, exchange, smtPeer }) => ({
  symbol,
  name,
  exchange,
  smtPeer: smtPeer || null,
}));

function getSymbol(input) {
  const key = String(input ?? '').trim().toUpperCase();
  return BY_SYMBOL.get(key) || null;
}

function searchTickers(query) {
  if (!query) return tickers;
  const q = String(query).trim().toLowerCase();
  return SYMBOLS.filter(
    (s) =>
      s.symbol.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      (s.aliases || []).some((alias) => alias.includes(q))
  ).map(({ symbol, name, exchange, smtPeer }) => ({
    symbol,
    name,
    exchange,
    smtPeer: smtPeer || null,
  }));
}

module.exports = { SYMBOLS, tickers, getSymbol, searchTickers };
