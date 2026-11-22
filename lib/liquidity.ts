// What an order of a given size would cost against the order book as it stands:
// the price it would average, how far that is from the mid, and whether the
// visible book can absorb it at all. Pure, so the ticket, the server-side
// check and the tests share it.

export interface BookLevel { px: number; sz: number }
/** Bids best (highest) first, asks best (lowest) first. */
export interface Book { bids: BookLevel[]; asks: BookLevel[] }

export interface FillEstimate {
  mid: number; bestBid: number; bestAsk: number;
  /** Bid-ask spread in basis points of the mid. */
  spreadBps: number;
  /** Average price the order would fill at, walking the book. Null if nothing would fill. */
  avgPx: number | null;
  /** How much worse than the mid that average is, in basis points. Half the spread is the floor. */
  slippageBps: number | null;
  /** Share of the order the visible book can fill, 0-1. */
  filledFraction: number;
  /** Total size resting on the side the order would take from, in USD. */
  depthUsd: number;
}

export function estimateFill(book: Book, side: 'buy' | 'sell', sizeUsd: number): FillEstimate | null {
  const bestBid = book.bids[0]?.px, bestAsk = book.asks[0]?.px;
  if (!(bestBid > 0) || !(bestAsk > 0)) return null;
  const mid = (bestBid + bestAsk) / 2;
  const levels = side === 'buy' ? book.asks : book.bids;
  const wanted = sizeUsd / mid; // coins
  let left = wanted, cost = 0;
  for (const l of levels) {
    const take = Math.min(left, l.sz);
    cost += take * l.px; left -= take;
    if (left <= 1e-12) break;
  }
  const filled = wanted - Math.max(0, left);
  const avgPx = filled > 0 ? cost / filled : null;
  return {
    mid, bestBid, bestAsk, spreadBps: ((bestAsk - bestBid) / mid) * 1e4,
    avgPx, slippageBps: avgPx == null ? null : ((side === 'buy' ? avgPx - mid : mid - avgPx) / mid) * 1e4,
    filledFraction: wanted > 0 ? Math.min(1, filled / wanted) : 0,
    depthUsd: levels.reduce((a, l) => a + l.px * l.sz, 0),
  };
}

/** Slippage worth pointing out, in basis points. A liquid market fills a small order for 1-3. */
export const WARN_SLIPPAGE_BPS = 10;

export interface LiquidityVerdict { level: 'ok' | 'warn' | 'block'; message: string | null }

/**
 * `maxSlippagePct` is the user's slippage setting: the worst price the market
 * order is allowed to fill at. An order expected to do worse than that would
 * be cut off part-filled, so it is refused before it is sent.
 */
export function liquidityVerdict(est: FillEstimate | null, maxSlippagePct: number): LiquidityVerdict {
  if (!est) return { level: 'block', message: 'The order book is empty on one side, so there is no price to trade at right now.' };
  if (est.filledFraction < 0.999) {
    return { level: 'block', message: `The visible order book holds about $${est.depthUsd.toFixed(0)} on this side, less than the order. Split it into slices, or rest a limit order instead.` };
  }
  const bps = est.slippageBps ?? 0;
  if (bps > maxSlippagePct * 100) {
    return { level: 'block', message: `Expected slippage is ${(bps / 100).toFixed(2)}%, beyond your ${maxSlippagePct}% limit: the order would be cut off part-filled. Split it into slices, or rest a limit order instead.` };
  }
  if (bps > WARN_SLIPPAGE_BPS) {
    return { level: 'warn', message: `Thin book: expect to pay about ${(bps / 100).toFixed(2)}% more than the mid price (spread ${(est.spreadBps / 100).toFixed(2)}%). A chase or limit entry would be cheaper.` };
  }
  return { level: 'ok', message: null };
}
