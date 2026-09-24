// Broker feeds whose symbol lists are only known at runtime: they decide which of their rows are listed.
const FEEDS = {
  oanda: require('./providers/oanda'),
  ctrader: require('./providers/ctrader'),
};

// Spot FX, metals, energy and index CFDs, from whichever broker feed is configured: cTrader (e.g. an IC Markets demo,
// = TradingView's ICMARKETS:XAUUSD) or OANDA (= OANDA:XAUUSD). `ctrader` lists broker spellings to try in order, since
// cTrader brokers name CFDs differently; `pricePrecision` is the fallback until the feed reports its own digits.
const FX_ROWS = [
  { symbol: 'XAUUSD', name: 'Gold Spot / U.S. Dollar', oanda: 'XAU_USD', ctrader: 'XAUUSD|GOLD', pricePrecision: 3, aliases: ['gold', 'xau'], smtPeer: 'XAGUSD' },
  { symbol: 'XAGUSD', name: 'Silver Spot / U.S. Dollar', oanda: 'XAG_USD', ctrader: 'XAGUSD|SILVER', pricePrecision: 5, aliases: ['silver', 'xag'], smtPeer: 'XAUUSD' },
  { symbol: 'XPTUSD', name: 'Platinum Spot / U.S. Dollar', oanda: 'XPT_USD', ctrader: 'XPTUSD|PLATINUM', pricePrecision: 3, aliases: ['platinum', 'xpt'] },
  { symbol: 'COPPER', name: 'Copper', oanda: 'XCU_USD', ctrader: 'XCUUSD|COPPER|HG', pricePrecision: 5, aliases: ['xcuusd', 'hg'] },
  { symbol: 'USOIL', name: 'WTI Crude Oil', oanda: 'WTICO_USD', ctrader: 'XTIUSD|USOIL|WTI|SPOTCRUDE', pricePrecision: 3, aliases: ['oil', 'wti', 'crude', 'xtiusd', 'wticousd', 'cl'], smtPeer: 'UKOIL' },
  { symbol: 'UKOIL', name: 'Brent Crude Oil', oanda: 'BCO_USD', ctrader: 'XBRUSD|UKOIL|BRENT|SPOTBRENT', pricePrecision: 3, aliases: ['oil', 'brent', 'crude', 'xbrusd', 'bcousd'], smtPeer: 'USOIL' },
  { symbol: 'NATGAS', name: 'Natural Gas', oanda: 'NATGAS_USD', ctrader: 'XNGUSD|NATGAS|NGAS', pricePrecision: 3, aliases: ['gas', 'xngusd', 'natgasusd', 'ng'] },

  { symbol: 'US500', name: 'US S&P 500', oanda: 'SPX500_USD', ctrader: 'US500|SPX500|US500CASH', pricePrecision: 1, aliases: ['s&p', 'sp500', 'spx', 'spx500usd', 'es'], smtPeer: 'NAS100' },
  { symbol: 'NAS100', name: 'US Nas 100', oanda: 'NAS100_USD', ctrader: 'USTEC|NAS100|US100|US100CASH', pricePrecision: 1, aliases: ['nasdaq', 'ndx', 'ustec', 'nas100usd', 'nq', 'us100'], smtPeer: 'US500' },
  { symbol: 'US30', name: 'US Wall St 30', oanda: 'US30_USD', ctrader: 'US30|DJ30|WS30|US30CASH', pricePrecision: 1, aliases: ['dow', 'djia', 'us30usd', 'ym'] },
  { symbol: 'GER40', name: 'Germany 40', oanda: 'DE30_EUR', ctrader: 'DE40|GER40|DE30|GER30', pricePrecision: 1, aliases: ['dax', 'de40', 'de30eur', 'ger30'] },

  { symbol: 'EURUSD', name: 'Euro / U.S. Dollar', oanda: 'EUR_USD', ctrader: 'EURUSD', pricePrecision: 5, aliases: ['euro', 'fiber'], smtPeer: 'GBPUSD' },
  { symbol: 'GBPUSD', name: 'British Pound / U.S. Dollar', oanda: 'GBP_USD', ctrader: 'GBPUSD', pricePrecision: 5, aliases: ['pound', 'cable'], smtPeer: 'EURUSD' },
  { symbol: 'USDJPY', name: 'U.S. Dollar / Japanese Yen', oanda: 'USD_JPY', ctrader: 'USDJPY', pricePrecision: 3, aliases: ['yen'] },
  { symbol: 'AUDUSD', name: 'Australian Dollar / U.S. Dollar', oanda: 'AUD_USD', ctrader: 'AUDUSD', pricePrecision: 5, aliases: ['aussie'] },
  { symbol: 'USDCAD', name: 'U.S. Dollar / Canadian Dollar', oanda: 'USD_CAD', ctrader: 'USDCAD', pricePrecision: 5, aliases: ['loonie'] },
  { symbol: 'USDCHF', name: 'U.S. Dollar / Swiss Franc', oanda: 'USD_CHF', ctrader: 'USDCHF', pricePrecision: 5, aliases: ['swissy'] },
  { symbol: 'NZDUSD', name: 'New Zealand Dollar / U.S. Dollar', oanda: 'NZD_USD', ctrader: 'NZDUSD', pricePrecision: 5, aliases: ['kiwi'] },
  { symbol: 'EURJPY', name: 'Euro / Japanese Yen', oanda: 'EUR_JPY', ctrader: 'EURJPY', pricePrecision: 3 },
  { symbol: 'GBPJPY', name: 'British Pound / Japanese Yen', oanda: 'GBP_JPY', ctrader: 'GBPJPY', pricePrecision: 3, aliases: ['guppy'] },
];

// FX_PROVIDER picks the feed; by default whichever has credentials, cTrader first.
const FX_PROVIDER = (() => {
  const chosen = (process.env.FX_PROVIDER || '').toLowerCase();
  if (FEEDS[chosen]) return chosen;
  if (FEEDS.ctrader.configured()) return 'ctrader';
  if (FEEDS.oanda.configured()) return 'oanda';
  return 'ctrader';
})();

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
    aliases: ['gold', 'paxg'],
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

  // Binance USDⓈ-M "TradFi perpetuals", named as TradingView names them (BINANCE:XAUUSDT.P). Perps on the underlying,
  // not spot or CME futures: 24/7, so bars keep printing (near-flat) while the real market is shut. Unlike OANDA they
  // carry real traded volume, which is what order flow needs.
  { symbol: 'XAUUSDT.P', name: 'Gold / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'XAUUSDT', aliases: ['gold', 'xau'], smtPeer: 'XAGUSDT.P' },
  { symbol: 'XAGUSDT.P', name: 'Silver / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'XAGUSDT', aliases: ['silver', 'xag'], smtPeer: 'XAUUSDT.P' },
  { symbol: 'XPTUSDT.P', name: 'Platinum / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'XPTUSDT', aliases: ['platinum', 'xpt'] },
  { symbol: 'COPPERUSDT.P', name: 'Copper / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'COPPERUSDT', aliases: ['hg'] },
  { symbol: 'CLUSDT.P', name: 'WTI Crude Oil / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'CLUSDT', aliases: ['oil', 'wti', 'crude', 'usoil'], smtPeer: 'BZUSDT.P' },
  { symbol: 'BZUSDT.P', name: 'Brent Crude Oil / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'BZUSDT', aliases: ['oil', 'brent', 'crude', 'ukoil'], smtPeer: 'CLUSDT.P' },
  { symbol: 'NATGASUSDT.P', name: 'Natural Gas / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'NATGASUSDT', aliases: ['gas', 'ng'] },

  // ETF-priced, not index-priced: SPY is ~1/10 of the S&P 500 level, so levels will not match US500.
  { symbol: 'SPYUSDT.P', name: 'SPDR S&P 500 ETF / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'SPYUSDT', aliases: ['s&p', 'sp500', 'spy'], smtPeer: 'QQQUSDT.P' },
  { symbol: 'QQQUSDT.P', name: 'Invesco QQQ ETF / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'QQQUSDT', aliases: ['nasdaq', 'qqq'], smtPeer: 'SPYUSDT.P' },

  { symbol: 'NVDAUSDT.P', name: 'NVIDIA / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'NVDAUSDT', aliases: ['nvidia', 'nvda'] },
  { symbol: 'TSLAUSDT.P', name: 'Tesla / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'TSLAUSDT', aliases: ['tesla', 'tsla'] },
  { symbol: 'AAPLUSDT.P', name: 'Apple / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'AAPLUSDT', aliases: ['apple', 'aapl'] },
  { symbol: 'MSFTUSDT.P', name: 'Microsoft / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'MSFTUSDT', aliases: ['microsoft', 'msft'] },
  { symbol: 'AMZNUSDT.P', name: 'Amazon / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'AMZNUSDT', aliases: ['amazon', 'amzn'] },
  { symbol: 'GOOGLUSDT.P', name: 'Alphabet / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'GOOGLUSDT', aliases: ['google', 'alphabet', 'googl'] },
  { symbol: 'METAUSDT.P', name: 'Meta Platforms / Tether Perpetual', exchange: 'BINANCE', provider: 'binance-futures', providerSymbol: 'METAUSDT', aliases: ['facebook', 'meta'] },
];

// Spot rows sit ahead of the perps, so a search for "gold" lists XAUUSD before XAUUSDT.P.
SYMBOLS.splice(
  SYMBOLS.findIndex((s) => s.provider === 'binance-futures'),
  0,
  ...FX_ROWS.map(({ oanda, ctrader, ...row }) => ({
    ...row,
    provider: FX_PROVIDER,
    providerSymbol: FX_PROVIDER === 'oanda' ? oanda : ctrader,
    exchange: null,
  }))
);

const BY_SYMBOL = new Map(SYMBOLS.map((s) => [s.symbol, s]));

// What the chart legend shows as the exchange for broker-feed rows: OANDA, or the cTrader broker (e.g. ICMARKETS).
function exchangeOf(s) {
  if (s.exchange) return s.exchange;
  if (s.provider === 'oanda') return 'OANDA';
  const broker = require('./providers/ctrader-client').broker();
  return broker ? broker.toUpperCase().replace(/[^A-Z0-9]/g, '') : 'CTRADER';
}

// A symbol is listed when its provider can serve it: broker-feed rows need credentials and an account that carries the instrument.
function isListed(s) {
  const feed = FEEDS[s.provider];
  return !feed || feed.isAvailable(s.providerSymbol);
}

// Public projection for GET /tickers; provider details stay server-side so the registry can grow without changing the API.
function toTicker(s) {
  const feed = FEEDS[s.provider];
  const precision = feed ? feed.displayPrecision(s.providerSymbol) : null;
  return {
    symbol: s.symbol,
    name: s.name,
    exchange: exchangeOf(s),
    smtPeer: s.smtPeer || null,
    // Decimal places to display, when the source defines them; null lets the client infer from price.
    pricePrecision: precision ?? s.pricePrecision ?? null,
  };
}

function getSymbol(input) {
  const key = String(input ?? '').trim().toUpperCase();
  return BY_SYMBOL.get(key) || null;
}

function searchTickers(query) {
  const listed = SYMBOLS.filter(isListed);
  if (!query) return listed.map(toTicker);
  const q = String(query).trim().toLowerCase();
  return listed
    .filter(
      (s) =>
        s.symbol.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.aliases || []).some((alias) => alias.includes(q))
    )
    .map(toTicker);
}

module.exports = { SYMBOLS, FX_ROWS, FX_PROVIDER, getSymbol, searchTickers };
