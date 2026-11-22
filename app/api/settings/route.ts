import { NextResponse } from 'next/server';
import { isAddress } from 'ethers';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { encrypt } from '@/lib/encryption';
import { generateWebhookSecret } from '@/lib/utils';

import { STRATEGIES } from '@/lib/autopilot/strategies';
import { MOMENTUM_ID } from '@/lib/autopilot/momentum';

export const dynamic = 'force-dynamic';

const STRATEGY_IDS = new Set([...STRATEGIES.map(s => s.id), MOMENTUM_ID]);

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const serviceClient = createServiceClient();
  const { data: settings, error } = await serviceClient
    .from('settings')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (error && error.code === 'PGRST116') {
    const defaultSecret = generateWebhookSecret();
    const { data: created } = await serviceClient
      .from('settings')
      .insert({
        user_id: user.id,
        default_leverage: 5,
        default_order_size_usd: 100,
        max_position_size_usd: 1000,
        risk_per_trade_percent: 2,
        webhook_secret: defaultSecret,
        webhook_enabled: false,
        is_testnet: true,
        slippage_percent: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    return NextResponse.json({ settings: sanitize(created) });
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ settings: sanitize(settings) });
}

// [field, min, max, label, wholeNumber?]
const NUMERIC_FIELDS: Array<[string, number, number, string, boolean?]> = [
  ['default_leverage', 1, 50, 'Leverage', true],
  ['default_order_size_usd', 10, 10_000_000, 'Order size (USD)'],
  ['max_position_size_usd', 10, 100_000_000, 'Max position size (USD)'],
  ['risk_per_trade_percent', 0.1, 100, 'Risk per trade (%)'],
  ['slippage_percent', 0.01, 10, 'Slippage (%)'],
  ['strategy_target_vol', 0.05, 1.5, 'Strategy target volatility'],
  ['strategy_max_leverage', 0.1, 5, 'Strategy max leverage'],
  ['autopilot_risk_per_trade_pct', 0.05, 5, 'Risk per trade (%)'],
  ['autopilot_max_positions', 1, 20, 'Max positions', true],
  ['autopilot_max_leverage', 0.1, 10, 'Max leverage per position'],
  ['autopilot_daily_loss_limit_pct', 0.5, 50, 'Daily loss limit (%)'],
  ['autopilot_max_drawdown_pct', 1, 90, 'Max drawdown (%)'],
  ['max_gross_exposure_x', 0.1, 50, 'Max total exposure (x account)'],
  ['portfolio_daily_loss_limit_pct', 0.5, 90, 'Account daily loss limit (%)'],
];
const BOOLEAN_FIELDS = ['webhook_enabled', 'is_testnet', 'strategy_enabled', 'strategy_dry_run', 'autopilot_enabled', 'autopilot_allow_short', 'daily_summary_enabled'];

export async function PUT(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  const bad = (message: string) => NextResponse.json({ error: message }, { status: 400 });

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  for (const [field, min, max, label, whole] of NUMERIC_FIELDS) {
    if (body[field] == null) continue;
    const v = Number(body[field]);
    if (!Number.isFinite(v) || v < min || v > max) return bad(`${label} must be between ${min} and ${max}`);
    if (whole && !Number.isInteger(v)) return bad(`${label} must be a whole number`);
    update[field] = v;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (body[field] == null) continue;
    if (typeof body[field] !== 'boolean') return bad(`${field} must be true or false`);
    update[field] = body[field];
  }

  // Empty or null clears the cap (strategy then sizes against the whole account).
  if ('strategy_capital_usd' in body) {
    const raw = body.strategy_capital_usd;
    if (raw == null || raw === '') {
      update.strategy_capital_usd = null;
    } else {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 10) return bad('Strategy capital must be at least $10, or empty for the whole account');
      update.strategy_capital_usd = v;
    }
  }

  // Default stop-loss / take-profit distance for webhook entries. Empty clears it.
  for (const field of ['default_stop_loss_percent', 'default_take_profit_percent']) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw == null || raw === '') { update[field] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0.05 || v > 50) return bad('Stop-loss and take-profit must be between 0.05% and 50%, or empty');
    update[field] = v;
  }

  if (body.autopilot_mode != null) {
    if (body.autopilot_mode !== 'paper' && body.autopilot_mode !== 'live') return bad('Autopilot mode must be paper or live');
    update.autopilot_mode = body.autopilot_mode;
  }
  if (body.autopilot_symbols != null) {
    const list = Array.isArray(body.autopilot_symbols) ? body.autopilot_symbols.map((x: unknown) => String(x).trim().toUpperCase()).filter(Boolean) : null;
    if (!list || list.length === 0 || list.length > 20 || list.some((x: string) => !/^[A-Z0-9]{1,20}$/.test(x))) return bad('Give between 1 and 20 market symbols, e.g. BTC, ETH, SOL');
    update.autopilot_symbols = [...new Set(list)];
  }
  if (body.autopilot_strategies != null) {
    const list = Array.isArray(body.autopilot_strategies) ? body.autopilot_strategies.map(String) : null;
    if (!list || list.some((id: string) => !STRATEGY_IDS.has(id))) return bad('Unknown autopilot strategy');
    update.autopilot_strategies = [...new Set(list)];
  }

  if (body.webhook_secret != null) {
    if (typeof body.webhook_secret !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(body.webhook_secret)) {
      return bad('Webhook secret must be 16–128 letters, digits, "-" or "_"');
    }
    update.webhook_secret = body.webhook_secret;
  }

  if (body.hl_wallet_address != null) {
    const address = String(body.hl_wallet_address).trim();
    if (address && !isAddress(address)) return bad('Wallet address is not a valid 0x address');
    update.hl_wallet_address = address || null;
  }

  if (typeof body.hl_private_key === 'string' && body.hl_private_key.trim()) {
    const key = body.hl_private_key.trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) return bad('Private key must be 64 hex characters');
    try {
      update.hl_private_key_encrypted = encrypt(key.startsWith('0x') ? key : `0x${key}`);
    } catch {
      return NextResponse.json({ error: 'Failed to encrypt private key — is ENCRYPTION_KEY set?' }, { status: 500 });
    }
  }

  const serviceClient = createServiceClient();
  const { data, error } = await serviceClient
    .from('settings')
    .update(update)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) {
    // 23505 = unique violation on webhook_secret (migration 002).
    if (error.code === '23505') return bad('That webhook secret is already in use; generate a new one');
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ settings: sanitize(data) });
}

function sanitize(s: Record<string, unknown> | null) {
  if (!s) return null;
  const { hl_private_key_encrypted, ...rest } = s;
  return { ...rest, has_private_key: !!hl_private_key_encrypted };
}
