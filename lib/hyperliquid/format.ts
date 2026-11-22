// Hyperliquid wire formatting for perp prices and sizes.
// Prices: at most 5 significant figures and at most (6 - szDecimals) decimals;
// integer prices are always allowed. Sizes: at most szDecimals decimals.
// Numbers are sent as plain decimal strings with no trailing zeros.

const MAX_PERP_PRICE_DECIMALS = 6;

function plain(value: number, decimals: number): string {
  const s = value.toFixed(decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function formatPrice(price: number, szDecimals: number): string {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error(`Invalid price: ${price}`);
  const maxDecimals = Math.max(0, MAX_PERP_PRICE_DECIMALS - szDecimals);
  const magnitude = Math.floor(Math.log10(price)) + 1; // digits before the decimal point (<=0 for sub-1 prices)
  const sigDecimals = Math.max(0, 5 - magnitude);
  return plain(price, Math.min(maxDecimals, sigDecimals));
}

/** Rounds toward zero so an order never exceeds the intended size or the position being closed. */
export function formatSize(size: number, szDecimals: number): string {
  if (!(size >= 0) || !Number.isFinite(size)) throw new Error(`Invalid size: ${size}`);
  const factor = 10 ** szDecimals;
  return plain(Math.floor(size * factor + 1e-9) / factor, szDecimals);
}
