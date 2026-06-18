import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { encrypt } from '@/lib/encryption';
import { generateWebhookSecret } from '@/lib/utils';
import type { SettingsUpdate } from '@/types';

export const dynamic = 'force-dynamic';

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

export async function PUT(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: SettingsUpdate = await request.json();
  const serviceClient = createServiceClient();

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.default_leverage != null) {
    const v = Number(body.default_leverage);
    if (v < 1 || v > 50) return NextResponse.json({ error: 'Leverage must be 1–50' }, { status: 400 });
    update.default_leverage = v;
  }
  if (body.default_order_size_usd != null) update.default_order_size_usd = Number(body.default_order_size_usd);
  if (body.max_position_size_usd != null) update.max_position_size_usd = Number(body.max_position_size_usd);
  if (body.risk_per_trade_percent != null) update.risk_per_trade_percent = Number(body.risk_per_trade_percent);
  if (body.webhook_secret != null) update.webhook_secret = body.webhook_secret;
  if (body.webhook_enabled != null) update.webhook_enabled = Boolean(body.webhook_enabled);
  if (body.is_testnet != null) update.is_testnet = Boolean(body.is_testnet);
  if (body.slippage_percent != null) update.slippage_percent = Number(body.slippage_percent);
  if (body.hl_wallet_address != null) update.hl_wallet_address = body.hl_wallet_address;

  if (body.hl_private_key && body.hl_private_key.trim()) {
    try {
      update.hl_private_key_encrypted = encrypt(body.hl_private_key.trim());
    } catch {
      return NextResponse.json({ error: 'Failed to encrypt private key — is ENCRYPTION_KEY set?' }, { status: 500 });
    }
  }

  const { data, error } = await serviceClient
    .from('settings')
    .update(update)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ settings: sanitize(data) });
}

function sanitize(s: Record<string, unknown> | null) {
  if (!s) return null;
  const { hl_private_key_encrypted, ...rest } = s;
  return { ...rest, has_private_key: !!hl_private_key_encrypted };
}
