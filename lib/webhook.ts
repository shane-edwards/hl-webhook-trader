// Pure parsing and decision logic for incoming webhook signals, kept apart
// from the route so it can be unit tested without a database or exchange.

export type SignalDirection = 'long' | 'short' | 'flat';

export interface ParsedSignal {
  secret: string;
  symbol: string;
  /** What the alert asks for. `flat` means close. */
  direction: SignalDirection;
  /** True when the alert states the strategy's resulting position (TradingView {{strategy.market_position}}). */
  isTargetPosition: boolean;
  leverage?: number;
  sizeUsd?: number;
}

export type ParseResult = { ok: true; signal: ParsedSignal } | { ok: false; error: string };

const ACTIONS: Record<string, SignalDirection> = {
  buy: 'long', long: 'long', sell: 'short', short: 'short', close: 'flat', flat: 'flat', exit: 'flat',
};

/** "BITSTAMP:BTCUSD" -> "BTC", "BTCUSDT.P" -> "BTC", "BTC-PERP" -> "BTC" */
export function normalizeSymbol(raw: string): string {
  const upper = raw.trim().toUpperCase();
  const withoutPrefix = upper.includes(':') ? upper.split(':').pop()! : upper;
  return withoutPrefix
    .replace(/\.P$/, '')
    .replace(/[-./_]?PERP$/, '')
    .replace(/[-./_]?(USDT|USDC|BUSD|USD)$/, '');
}

function optionalNumber(value: unknown, name: string): number | undefined | string {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${name} must be a positive number`;
  return n;
}

export function parseWebhookPayload(body: unknown): ParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;

  if (typeof b.secret !== 'string' || !b.secret) return { ok: false, error: 'Missing required field: secret' };
  if (typeof b.symbol !== 'string' || !b.symbol.trim()) return { ok: false, error: 'Missing required field: symbol' };

  // `position` (the strategy's position after the order) wins over `action` when both are sent.
  const hasPosition = typeof b.position === 'string' && b.position.trim() !== '';
  const rawAction = hasPosition ? b.position : b.action;
  if (typeof rawAction !== 'string' || !rawAction.trim()) return { ok: false, error: 'Missing required field: action or position' };
  const direction = ACTIONS[rawAction.trim().toLowerCase()];
  if (!direction) return { ok: false, error: `Unknown ${hasPosition ? 'position' : 'action'}: ${rawAction.slice(0, 40)}` };

  const symbol = normalizeSymbol(b.symbol);
  if (!/^[A-Z0-9]{1,20}$/.test(symbol)) return { ok: false, error: `Invalid symbol: ${b.symbol.slice(0, 40)}` };

  const leverage = optionalNumber(b.leverage, 'leverage');
  if (typeof leverage === 'string') return { ok: false, error: leverage };
  if (leverage != null && !Number.isInteger(leverage)) return { ok: false, error: 'leverage must be a whole number' };
  const sizeUsd = optionalNumber(b.size_usd, 'size_usd');
  if (typeof sizeUsd === 'string') return { ok: false, error: sizeUsd };

  return { ok: true, signal: { secret: b.secret, symbol, direction, isTargetPosition: hasPosition, leverage, sizeUsd } };
}

export interface PlanInput {
  direction: SignalDirection;
  isTargetPosition: boolean;
  /** Existing position on the exchange for this symbol, if any. */
  current: { side: 'long' | 'short'; notionalUsd: number } | null;
  orderSizeUsd: number;
  maxPositionSizeUsd: number;
}

export type Plan =
  | { type: 'close' }
  | { type: 'open'; side: 'long' | 'short' }
  | { type: 'reverse'; side: 'long' | 'short' }
  | { type: 'none'; reason: string };

/**
 * Decides what a signal does given the live position.
 *
 * - flat/close: close the position.
 * - Same side as the open position: add, but only while the total stays within the max position size.
 * - Opposite side: with `action` (ambiguous in TradingView, where "sell" is both
 *   "exit long" and "enter short") the position is closed and nothing is opened.
 *   With `position` the intent is explicit, so it is closed and reversed.
 */
export function planSignal(input: PlanInput): Plan {
  const { direction, current, orderSizeUsd, maxPositionSizeUsd } = input;

  if (direction === 'flat') return current ? { type: 'close' } : { type: 'none', reason: 'No open position to close' };

  const tooBig = orderSizeUsd > maxPositionSizeUsd;

  if (!current) {
    if (tooBig) return { type: 'none', reason: `Order size $${orderSizeUsd} exceeds max position size $${maxPositionSizeUsd}` };
    return { type: 'open', side: direction };
  }

  if (current.side === direction) {
    if (input.isTargetPosition) return { type: 'none', reason: `Already ${direction}` };
    if (current.notionalUsd + orderSizeUsd > maxPositionSizeUsd) {
      return { type: 'none', reason: `Already ${direction}; adding $${orderSizeUsd} would exceed max position size $${maxPositionSizeUsd}` };
    }
    return { type: 'open', side: direction };
  }

  if (!input.isTargetPosition || tooBig) return { type: 'close' };
  return { type: 'reverse', side: direction };
}

/** Copy of the payload that is safe to store: the secret never goes into logs or trade rows. */
export function redactPayload(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>).slice(0, 20)) {
    if (k === 'secret') continue;
    out[k] = typeof v === 'string' ? v.slice(0, 500) : typeof v === 'number' || typeof v === 'boolean' || v === null ? v : '[omitted]';
  }
  return out;
}
