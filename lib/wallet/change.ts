import type { createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { withTradingLock } from '@/lib/trading-lock';

type Db = ReturnType<typeof createServiceClient>;
type WalletSettings = { updated_at: string; hl_wallet_address?: string; hl_private_key_encrypted?: string; is_testnet?: boolean };

export async function withWalletChange<T>(db: Db, userId: string, expected: WalletSettings, change: () => Promise<T>, restoreResource?: string) {
  return withTradingLock(hlClientFromSettings(expected), db, userId, async () => {
    const [settings, positions, trades, pending, plans, profile] = await Promise.all([
      db.from('settings').select('updated_at, flatten_pending, autopilot_enabled, autopilot_mode').eq('user_id', userId).single(),
      db.from('autopilot_positions').select('account_resource').eq('user_id', userId).eq('mode', 'live').eq('status', 'open'),
      db.from('trades').select('id').eq('user_id', userId).eq('status', 'open').limit(1),
      db.from('pending_orders').select('id').eq('user_id', userId).eq('status', 'resting').limit(1),
      db.from('position_plans').select('id').eq('user_id', userId).eq('status', 'active').limit(1),
      db.from('automation_profiles').select('mode, enabled, entries_paused').eq('user_id', userId).eq('market', 'crypto').maybeSingle(),
    ]);
    if ([settings, positions, trades, pending, plans, profile].some(result => result.error)) throw new Error('Could not verify managed trades before changing the wallet.');
    if (settings.data?.updated_at !== expected.updated_at) throw new Error('Settings changed. Refresh and try again.');
    if (!expected.hl_private_key_encrypted && !process.env.HL_PRIVATE_KEY && restoreResource && positions.data?.length &&
        positions.data.every(row => row.account_resource === restoreResource)) return change();
    if (positions.data?.length || trades.data?.length || pending.data?.length || plans.data?.length || settings.data.flatten_pending)
      throw new Error('Finish managed positions, resting entries and recovery before changing the wallet.');
    if (settings.data.autopilot_enabled && settings.data.autopilot_mode === 'live' ||
        profile.data?.mode === 'live' && profile.data.enabled && !profile.data.entries_paused)
      throw new Error('Pause Live Autopilot before changing the wallet.');
    return change();
  });
}
