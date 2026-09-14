// The tradable universe. One row per symbol we serve, mapping our public
// symbol to the upstream provider that actually has the data.
//
// `aliases` are extra search terms only — they never resolve a symbol, so no
// alias can shadow a real ticker.
//
// `smtPeer` names the instrument this one is compared against for SMT
// divergence: two markets that should move together, where one making a new
// extreme and the other failing to exposes a move without real participation.
// Pairs must be mutual.
const SYMBOLS = [
  { symbol: 'BTCUSD', name: 'Bitcoin / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'BTCUSDT', smtPeer: 'ETHUSD' },
  { symbol: 'ETHUSD', name: 'Ethereum / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'ETHUSDT', smtPeer: 'BTCUSD' },
  { symbol: 'SOLUSD', name: 'Solana / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'SOLUSDT' },
  { symbol: 'XRPUSD', name: 'XRP / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'XRPUSDT' },
  { symbol: 'BNBUSD', name: 'BNB / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'BNBUSDT' },
  { symbol: 'ADAUSD', name: 'Cardano / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'ADAUSDT' },
  { symbol: 'DOGEUSD', name: 'Dogecoin / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'DOGEUSDT' },

  // Gold. PAX Gold is redeemable one-for-one for a troy ounce of LBMA gold, so
  // it prints within a few dollars of spot XAU/USD and on the same scale, which
  // is what the chart's indicators are calibrated against. It is NOT spot gold:
  // it carries its own premium, its volume is the token's rather than the
  // metal's, and it trades through the weekend where XAU/USD gaps. Swap this
  // row's provider for a real metals feed when one is available and the tools
  // downstream need no changes.
  {
    symbol: 'PAXGUSD',
    name: 'PAX Gold / U.S. Dollar',
    exchange: 'BINANCE',
    provider: 'binance',
    providerSymbol: 'PAXGUSDT',
    aliases: ['gold', 'xau', 'xauusd'],
    smtPeer: 'XAUTUSD',
  },

  // Tether Gold. Carried specifically as PAX Gold's SMT peer: both are redeemable
  // for the same metal, so they track each other closely and a divergence
  // between them is a participation signal rather than a correlation artifact.
  // It is the thinner of the two (a fifth of PAXG's trade count), which is why
  // PAXG stays the primary gold symbol.
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

// Public projection for GET /tickers. Provider details stay server-side so the
// registry can grow new fields (or a second provider) without changing the API.
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
