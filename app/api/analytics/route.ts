import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { analyticsReport } from '@/lib/analytics-report';
import type { Trade } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const asOf = new Date().toISOString();
  try {
    const report = await analyticsReport(async afterId => {
      let query = db.from('trades').select('id,status,pnl,net_pnl,fees,funding_paid,entry_time,exit_time,duration_seconds,fills_synced_at,signal_source,webhook_payload,order_type,size_usd,slippage_bps').eq('user_id', user.id).lte('created_at', asOf).order('id').limit(500);
      if (afterId) query = query.gt('id', afterId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return data as Trade[];
    });
    return NextResponse.json(report);
  } catch {
    return NextResponse.json({ error: 'Could not load the complete trade history.' }, { status: 503 });
  }
}
