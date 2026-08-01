// The tradable universe. One row per symbol we serve, mapping our public
// symbol to the upstream provider that actually has the data.
const SYMBOLS = [
  { symbol: 'BTCUSD', name: 'Bitcoin / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'BTCUSDT' },
  { symbol: 'ETHUSD', name: 'Ethereum / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'ETHUSDT' },
  { symbol: 'SOLUSD', name: 'Solana / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'SOLUSDT' },
  { symbol: 'XRPUSD', name: 'XRP / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'XRPUSDT' },
  { symbol: 'BNBUSD', name: 'BNB / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'BNBUSDT' },
  { symbol: 'ADAUSD', name: 'Cardano / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'ADAUSDT' },
  { symbol: 'DOGEUSD', name: 'Dogecoin / U.S. Dollar', exchange: 'BINANCE', provider: 'binance', providerSymbol: 'DOGEUSDT' },
];

const BY_SYMBOL = new Map(SYMBOLS.map((s) => [s.symbol, s]));

// Public projection for GET /tickers. Provider details stay server-side so the
// registry can grow new fields (or a second provider) without changing the API.
const tickers = SYMBOLS.map(({ symbol, name, exchange }) => ({ symbol, name, exchange }));

function getSymbol(input) {
  const key = String(input ?? '').trim().toUpperCase();
  return BY_SYMBOL.get(key) || null;
}

function searchTickers(query) {
  if (!query) return tickers;
  const q = String(query).trim().toLowerCase();
  return tickers.filter(
    (t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)
  );
}

module.exports = { SYMBOLS, tickers, getSymbol, searchTickers };
