import type { createServiceClient } from '@/lib/supabase/server';
import { readPages as pages } from '@/lib/supabase/pages';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { getStrategy } from '@/lib/autopilot/strategies';
import { openPaperPnl } from '@/lib/autopilot/paper-fill';
import { ruleKey, ruleName, type ForwardBook, type SearchMarket } from '@/lib/strategy-search/model';
import type { StockJournalOrder } from '@/lib/stocks/execution-journal';
import { etoroFromConnection } from '@/lib/stocks/connection';
import type { NamedTrial } from './forward-trials';
import type { PaperComparison, PaperEvent } from './crypto-paper-comparison';
import { findIdea, ideaId, versionedIdea } from './ideas';
import { stockDemoNet } from './policy';

type Db = ReturnType<typeof createServiceClient>;
export type PaperTrade = {
  id: string; market: SearchMarket; symbol: string; name: string; source: 'Crypto paper' | 'eToro Demo' | 'Forward simulation' | 'Portfolio comparison';
  side?: string; entry: number; exit: number | null; closed: boolean; price?: number | null; exitPrice?: number | null; net: number | null;
  unit: 'usd' | 'fraction'; estimated?: boolean; portfolios?: string;
};


function tradeName(market: SearchMarket, symbol: string, rule: string | null) {
  if (!rule) return 'Manual trade';
  return findIdea(ideaId(market, rule, symbol))?.name ?? (market === 'crypto' ? getStrategy(rule)?.name : null) ??
    (rule === 'xs_momentum_90' ? 'Cross-coin momentum' : rule.replaceAll(/[_-]/g, ' '));
}

async function cryptoTrades(db: Db, user: string, cutoff: string): Promise<PaperTrade[]> {
  const rows = await pages((from, to) => db.from('autopilot_positions')
    .select('id,symbol,strategy_id,side,status,entry_time,entry_price,size,notional_usd,funding_paid,exit_time,exit_price,pnl')
    .eq('user_id', user).eq('mode', 'paper').in('status', ['open','closed']).lte('entry_time', cutoff)
    .order('entry_time').order('id').range(from,to));
  const mids = rows.some(r => r.status === 'open') ? await marketDataClient().getAllMids().catch(() => ({} as Record<string,string>)) : {};
  return rows.map(r => {
    const open = r.status === 'open', mark = Number(mids[r.symbol]);
    return { id: 'crypto:' + r.id, market: 'crypto', name: tradeName('crypto', r.symbol, r.strategy_id), symbol:r.symbol,
      source:'Crypto paper', side:r.side, entry:Date.parse(r.entry_time), price:r.entry_price, closed:!open, exit:r.exit_time ? Date.parse(r.exit_time) : null,
      exitPrice:r.exit_price, net:open ? (mark > 0 ? openPaperPnl(r,mark) : null) : r.pnl, estimated:open, unit:'usd' };
  });
}

async function stockTrades(db: Db, user: string, cutoff: string): Promise<PaperTrade[]> {
  const rows = await pages((from,to) => db.from('etoro_stock_orders')
    .select('id,symbol,strategy,created_at,closed_at,statement_result,fill_metrics,estimated_costs,close_execution,position_ids,connection_version')
    .eq('user_id',user).eq('environment','demo').eq('state','filled').lte('created_at',cutoff)
    .order('created_at').order('id').range(from,to));
  const marks = new Map<string, number>();
  if (rows.some(r => !r.closed_at)) {
    const connection = await db.from('etoro_connections').select('environment,credentials_encrypted,updated_at')
      .eq('user_id',user).eq('environment','demo').maybeSingle();
    if (connection.data) {
      try {
        const portfolio = await etoroFromConnection(connection.data).portfolio();
        const positions = new Map(portfolio.positions.map(p => [p.id,p.pnl]));
        for (const r of rows) {
          if (r.closed_at || Date.parse(r.connection_version) !== Date.parse(connection.data.updated_at)) continue;
          const values = (r.position_ids as number[] ?? []).map(id => positions.get(id));
          if (values.length && values.every((v): v is number => v != null && Number.isFinite(v)))
            marks.set(r.id, values.reduce((sum,v) => sum + v,0));
        }
      } catch { /* The local fill record remains available when the broker has no current mark. */ }
    }
  }
  return (rows as unknown as StockJournalOrder[]).map(r => ({
    id:'demo:' + r.id, market:'stocks', name:tradeName('stocks',r.symbol,r.strategy), symbol:r.symbol, source:'eToro Demo',
    entry:Date.parse(r.fill_metrics?.executionAt ?? r.created_at), price:r.fill_metrics?.price,
    closed:!!r.closed_at, exit:r.closed_at ? Date.parse(r.closed_at) : null, net:r.closed_at ? stockDemoNet(r) : marks.get(r.id) ?? null,
    estimated:r.closed_at ? !r.statement_result : true, unit:'usd',
  }));
}

type Snapshot = { idea_id: string; market: SearchMarket; trial: NamedTrial | null; books: ForwardBook[] | null };

// Snapshots arrive newest first. Closed fills recur across checkpoints. Open positions belong to the latest checkpoint only.
export function forwardTrades(rows: Snapshot[]): PaperTrade[] {
  const trades = new Map<string,PaperTrade>(), seen = new Set<string>();
  for (const r of rows) {
    const latest = !seen.has(r.idea_id);
    seen.add(r.idea_id);
    if (r.trial) {
      const trial = r.trial, idea = versionedIdea(r.market,trial.version);
      for (const f of trial.fills) {
        const id = `trial:${r.idea_id}:${trial.version}:${trial.started}:${f.entry}`;
        if (!trades.has(id)) trades.set(id,{id,market:r.market,source:'Forward simulation',
          symbol:idea?.symbol ?? r.idea_id.split(':')[2], name:idea?.name ?? r.idea_id.split(':')[1], entry:f.entry,exit:f.exit,closed:true,net:f.net,unit:'fraction'});
      }
    }
    for (const book of r.books ?? []) {
      const prefix = `forward:${r.idea_id}:${book.version}:${book.started}:${ruleKey(book.rule)}:`;
      const base = {market:r.market, symbol:r.idea_id.split(':')[2], name:ruleName(book.rule), side:book.rule.side ?? 'long',
        source:'Forward simulation',unit:'fraction'} as const;
      for (const f of book.recent) {
        const id = prefix + f.entry;
        if (!trades.has(id)) trades.set(id,{...base,id,entry:f.entry,exit:f.exit,closed:true,price:f.price,exitPrice:f.exitPrice,net:f.net});
      }
      if (latest && book.pending && (book.state === 'tracking' || book.state === 'data-gap')) {
        const f = book.pending, id = prefix + f.entry;
        trades.set(id,{...base,id,entry:f.entry,price:f.price,exit:null,closed:false,net:null});
      }
    }
  }
  return [...trades.values()];
}

export function comparisonTrades(lots: PaperComparison['lots'], events: PaperEvent[]): PaperTrade[] {
  const trades = new Map<string,PaperTrade>();
  for (const e of events) {
    if (!e.sizes.one && !e.sizes.shared) continue;
    const id = 'comparison:' + e.id;
    if (e.type === 'entry') trades.set(id,{id,market:'crypto',symbol:e.symbol,name:e.name,source:'Portfolio comparison',
      portfolios:e.sizes.one && e.sizes.shared ? 'Both portfolios' : e.sizes.one ? 'One position' : 'Shared budget',
      side:'long',entry:e.at,exit:null,closed:false,net:null,unit:'fraction'});
    else {
      const row = trades.get(id);
      if (row) { row.exit = e.at; row.closed = true; row.net = e.net ?? null; }
    }
  }
  for (const lot of lots) {
    const row = trades.get('comparison:' + lot.id);
    if (row) row.price = lot.entry;
  }
  return [...trades.values()];
}

async function portfolioTrades(db: Db, user: string) {
  const latest = await db.from('crypto_paper_portfolios').select('through_ms,lots:state->lots')
    .eq('user_id',user).order('through_ms',{ascending:false}).limit(1).maybeSingle();
  if (latest.error) throw latest.error;
  if (!latest.data) return [];
  const checkpoints = await pages((from,to) => db.from('crypto_paper_portfolios').select('events').eq('user_id',user)
    .lte('through_ms',latest.data!.through_ms).not('events->0','is',null).order('through_ms').range(from,to));
  return comparisonTrades(latest.data.lots as unknown as PaperComparison['lots'],checkpoints.flatMap(r => r.events as PaperEvent[]));
}

export async function readPaperTrades(db: Db, user: string) {
  const cutoff = new Date().toISOString();
  const [crypto, stocks, history, portfolios] = await Promise.all([cryptoTrades(db,user,cutoff),stockTrades(db,user,cutoff),
    pages((from,to) => db.from('automation_runs').select('market,idea_id,trial:report->data->trial,books:report->data->search->forward')
      .eq('user_id',user).eq('kind','focused').eq('status','completed').lte('completed_at',cutoff)
      .or('report->data->trial->>version.not.is.null,report->data->search->forward->0->>version.not.is.null')
      .order('completed_at',{ascending:false}).order('id').range(from,to)), portfolioTrades(db,user)]);
  return [...crypto,...stocks,...forwardTrades(history as unknown as Snapshot[]),...portfolios]
    .sort((a,b) => (b.exit ?? b.entry) - (a.exit ?? a.entry) || a.id.localeCompare(b.id));
}
