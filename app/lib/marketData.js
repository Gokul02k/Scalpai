const SYMBOL_MAP = {
  'NIFTY': '^NSEI',
  'SENSEX': '^BSESN',
  'BANK NIFTY': '^NSEBANK',
  'FINNIFTY': '^NSEFI',
  'MIDCAP NIFTY': '^NSMIDCP',
};

export async function fetchRealMarketData(instrument) {
  try {
    const symbol = SYMBOL_MAP[instrument] || '^NSEI';
    const res = await fetch(`/api/market?symbol=${symbol}`);
    const data = await res.json();
    
    return {
      cur: data.current,
      open: data.open,
      high: data.high,
      low: data.low,
      prev: data.previousClose,
      source: data.source,
    };
  } catch (error) {
    console.log('Market data fetch failed, using simulated data');
    return null;
  }
}
