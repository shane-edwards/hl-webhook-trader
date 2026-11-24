import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { closePositionFully } from '@/lib/execution';
import { accountResource } from '@/lib/trading-lock';

type Db = Parameters<typeof closePositionFully>[1];

export async function closeUnverifiedEntry(hl: HyperliquidClient, db: Db, userId: string,
  row: { symbol: string; side: string; account_resource?: string | null }, slippage: number) {
  if (row.account_resource !== accountResource(hl, userId)) throw new Error('Recovery requires the original Hyperliquid wallet and network');
  const position = await hl.getPosition(row.symbol);
  if (!position) return false;
  if (position.side !== row.side) throw new Error('The exchange position changed side during recovery. Check the wallet.');
  await closePositionFully(hl, db, userId, row.symbol, slippage, 'Recovering an unverified Autopilot entry');
  return true;
}
