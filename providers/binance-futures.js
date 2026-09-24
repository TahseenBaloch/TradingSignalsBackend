const { createKlineProvider } = require('./binance');

// USDⓈ-M futures klines, which carry Binance's TradFi perpetuals (gold, oil, indices). Geo-blocked in more regions than spot: a 451 surfaces as upstream_error.
module.exports = createKlineProvider({
  name: 'binance-futures',
  baseUrl: process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com',
  path: '/fapi/v1/klines',
});
