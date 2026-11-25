import type { HyperliquidClient } from '@/lib/hyperliquid/client';

export const PAPER_COST = .00065;

export function openPaperPnl(row: {side: string; size: number; entry_price: number; notional_usd: number; funding_paid?: number | null}, price: number) {
  return (row.side === 'long' ? 1 : -1) * row.size * (price - row.entry_price)
    - row.notional_usd * 2 * PAPER_COST - Number(row.funding_paid ?? 0);
}

/** Price the requested cash amount (or the exact closing quantity) against a fresh book. */
export async function paperFill(hl: HyperliquidClient, symbol: string, side: 'buy' | 'sell',
  amount: { usd: number } | { quantity: number }, maxSlippage: number, clock: () => number) {
  const book = await hl.getBookSnapshot(symbol);
  const now = clock();
  if (!Number.isFinite(book.time) || !book.time || book.time < now - 15_000 || book.time > now + 2_000)
    throw new Error('Waiting for a fresh paper execution quote');
  const bid = book.bids[0]?.px, ask = book.asks[0]?.px;
  if (!(bid > 0 && ask >= bid && Number.isFinite(ask))) throw new Error('Waiting for a two-sided paper execution quote');
  const mid = (bid + ask) / 2;
  const cash = 'usd' in amount;
  const wanted = cash ? amount.usd : amount.quantity;
  if (!(wanted > 0 && Number.isFinite(wanted) && Number.isFinite(maxSlippage) && maxSlippage >= 0))
    throw new Error('Invalid paper order size or slippage');
  const limit = mid * (1 + (side === 'buy' ? 1 : -1) * maxSlippage / 100);
  let remaining = wanted, units = 0, value = 0;
  for (const { px, sz } of side === 'buy' ? book.asks : book.bids) {
    if (!(px > 0 && sz > 0 && Number.isFinite(px) && Number.isFinite(sz))) throw new Error('Invalid paper order book');
    if (side === 'buy' ? px > limit : px < limit) break;
    const take = Math.min(sz, cash ? remaining / px : remaining);
    units += take;
    value += take * px;
    remaining -= cash ? take * px : take;
    if (remaining <= wanted * 1e-12) return { price: value / units, at: now };
  }
  throw new Error('Insufficient visible depth within the paper order slippage limit');
}
