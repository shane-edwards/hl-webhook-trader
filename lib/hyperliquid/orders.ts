// Pure builders for Hyperliquid order actions. Kept apart from the client so
// the exact wire shape (key order matters: the action is hashed as msgpack)
// can be tested without a network. Shapes follow the official SDK's
// order_request_to_order_wire / order_wires_to_order_action.
import { formatPrice, formatSize } from './format';

export type Grouping = 'na' | 'normalTpsl' | 'positionTpsl';

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: 'Ioc' | 'Gtc' | 'Alo' } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'sl' | 'tp' } };
}

export interface OrderAction { type: 'order'; orders: OrderWire[]; grouping: Grouping }

/** A resting or immediate limit order. `Alo` is post-only: it is rejected rather than crossing the book. */
export function limitOrderWire(asset: number, szDecimals: number, isBuy: boolean, price: number, size: number, tif: 'Ioc' | 'Gtc' | 'Alo', reduceOnly = false): OrderWire {
  return { a: asset, b: isBuy, p: formatPrice(price, szDecimals), s: formatSize(size, szDecimals), r: reduceOnly, t: { limit: { tif } } };
}

/**
 * A reduce-only stop-loss or take-profit that fires a market order at
 * `triggerPx`. `p` is the worst price that market order may fill at: 10%
 * through the trigger.
 */
export function triggerOrderWire(asset: number, szDecimals: number, positionSide: 'long' | 'short', triggerPx: number, size: number, tpsl: 'sl' | 'tp'): OrderWire {
  const closeIsBuy = positionSide === 'short';
  return {
    a: asset,
    b: closeIsBuy,
    p: formatPrice(triggerPx * (closeIsBuy ? 1.1 : 0.9), szDecimals),
    s: formatSize(size, szDecimals),
    r: true,
    t: { trigger: { isMarket: true, triggerPx: formatPrice(triggerPx, szDecimals), tpsl } },
  };
}

export function orderAction(orders: OrderWire[], grouping: Grouping): OrderAction {
  return { type: 'order', orders, grouping };
}
