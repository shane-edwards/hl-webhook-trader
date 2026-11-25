import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { advanceMinute, comparisonSummary, MINUTE, newComparison, scheduleSignals, START,
  type PaperEvent, type IdeaSignal, type MinuteMarket } from '../lib/automation/crypto-paper-comparison';
import { observePaperSignals, settlePaperMinutes } from '../lib/automation/crypto-paper-worker';
import { BARS_NEEDED } from '../lib/autopilot/signals';
import { studyEvidence } from '../lib/automation/model';
import { COST } from '../lib/autopilot/simulate';

const start = Date.UTC(2026, 8, 1);
const names = ['BTC','ETH','SOL'];
const sig = (symbol: string, bar = start - 3_600_000): IdeaSignal => ({ symbol, rule:'trend_breakout', version:symbol+'.v1',
  id:symbol+'@'+bar, name:symbol+' breakout', bar, stopPct:.02 });
const market = (t: number, open = 100, low = open, funding = 0): Map<string, MinuteMarket> =>
  new Map(names.map(symbol => [symbol,{bar:{t,o:open,h:open,l:low,c:open},funding}]));
function near(a: number,b: number) { assert.ok(Math.abs(a-b)<1e-8, `${a} != ${b}`); }

test('common future fill, single vs shared budget, independent return even for skipped overlapping signals', () => {
  const s = newComparison(start), events: PaperEvent[] = [];
  scheduleSignals(s,start+1,names.map(n => sig(n)),[]);
  advanceMinute(s,start,market(start),events);
  assert.equal(s.lots.length,0);
  const entry = start+MINUTE;
  advanceMinute(s,entry,market(entry),events);
  assert.equal(s.lots.length,3);
  assert.deepEqual([s.one.entered,s.shared.entered,s.one.skipped,s.shared.skipped],[1,3,2,0]);
  assert.ok(s.lots.reduce((sum,l) => sum+l.sizes.shared*(l.stopPct+.0075),0) <= START*.005+1e-8);
  assert.equal(events.find(e => e.symbol==='ETH')!.one,'One-position limit');
  assert.ok(s.shared.cash >= 0);
  scheduleSignals(s,entry+10,names.map(n=>sig(n)),s.lots.map(l=>l.id));
  assert.equal(s.pending?.signals.length,0);
  const exit = start+2*MINUTE;
  advanceMinute(s,exit,market(exit,105),events);
  assert.equal(s.lots.length,0);
  near(s.trials['ETH.v1'].totalReturn,1.05*(1-COST)-(1+COST));
  for (const book of ['one','shared'] as const) {
    const profit = events.filter(e=>e.type==='exit').reduce((sum,e)=>sum+e.sizes[book]*e.net!,0);
    near(s[book].equity,START+profit);
  }
});

test('an open coin never blocks independent signals, portfolio duplicates are skipped and all pay actual funding', () => {
  const s = newComparison(start), events: PaperEvent[] = [];
  scheduleSignals(s,start,[sig('BTC')],[]);
  advanceMinute(s,start,market(start),events);
  advanceMinute(s,start+MINUTE,market(start+MINUTE),events);
  const second = {...sig('BTC'),version:'BTC.v2',id:'second'};
  scheduleSignals(s,start+MINUTE,[second,sig('ETH')],[]);
  advanceMinute(s,start+2*MINUTE,market(start+2*MINUTE,100,100,.001),events);
  assert.equal(s.lots.length,3);
  assert.equal(s.lots.find(l=>l.id===second.id)?.sizes.shared,0);
  assert.equal(s.trials['BTC.v2'].count,1);
  assert.equal(s.shared.entered,2);
  const end = start+3*MINUTE;
  advanceMinute(s,end,market(end,95),events);
  assert.equal(s.lots.length,0);
  const closed = events.filter(e=>e.type==='exit');
  assert.equal(closed.length,3);
  for (const e of closed) near(e.net!, .95*(1-.0005)*(1-COST)-(1+COST)-.001);
  near(s.shared.equity,START+closed.reduce((v,e)=>v+e.sizes.shared*e.net!,0));
  assert.ok(comparisonSummary(s).shared.drawdown>0);
});

test('bad market data pauses a checkpoint and replay produces identical results', () => {
  const s = newComparison(start), events: PaperEvent[] = [];
  scheduleSignals(s,start,[sig('ETH')],[]);
  advanceMinute(s,start,market(start),events);
  const checkpoint = structuredClone(s);
  assert.throws(()=>advanceMinute(s,start+MINUTE,new Map(),events));
  assert.deepEqual(s,checkpoint);
  advanceMinute(s,start+MINUTE,market(start+MINUTE),events);
  advanceMinute(checkpoint,start+MINUTE,market(start+MINUTE),[]);
  assert.deepEqual(s,checkpoint);
  assert.throws(()=>advanceMinute(s,start+MINUTE,market(start+MINUTE),[]));
});

test('hourly observation scans overlapping signals and retries missing symbols within the same hour', async () => {
  const hourly = Array.from({length:BARS_NEEDED},(_,i) => {
    const o = i + 100;
    return {t:start - (BARS_NEEDED-i)*3_600_000,o,c:o+.8,h:o+.9,l:o-.2,v:100};
  });
  let offline = true;
  const feed = {
    getHourlyCandles: async (symbol: string) => { if (symbol === 'ETH' && offline) throw Error('offline'); return hourly; },
    getCandles: async (_symbol: string, _frame: string, from: number, until = Date.now()) =>
      Array.from({length:(until-from)/MINUTE},(_,i)=>({...market(from+i*MINUTE).get('ETH')!.bar, v:100})),
    getFundingRates: async () => [],
  };
  const now = start + 5*MINUTE;
  const s = newComparison(now), events: PaperEvent[] = [];
  const candidates = names.map(symbol=>studyEvidence({market:'crypto',symbol,rule:'trend_breakout',name:'Trend breakout',trades:100,
    holdoutTrades:45,early:.1,later:.1,stress:.1,benchmark:.01,drawdown:.01,from:'',through:''}));
  await observePaperSignals(s,candidates,feed,()=>now);
  assert.deepEqual(s.missing,['ETH']);
  assert.deepEqual(s.pending!.signals.map(g=>g.symbol),['BTC','SOL']);
  await settlePaperMinutes(s,feed,now+3*MINUTE,events);
  assert.equal(s.shared.entered,2); assert.equal(s.one.entered,1);
  offline=false;
  await observePaperSignals(s,candidates,feed,()=>now+3*MINUTE);
  assert.deepEqual(s.pending!.signals.map(g=>g.symbol),['ETH']);
  await settlePaperMinutes(s,feed,now+5*MINUTE,events);
  assert.equal(s.shared.entered,3);
  assert.equal(s.trials[candidates.find(c=>c.symbol==='ETH')!.version].count,1);
  assert.equal(events.filter(e=>e.type==='entry').length,3);
});

test('paper journal is server-only and concurrent workers cannot fork an account history', async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);");
    await db.exec(readFileSync('supabase/migrations/20261125014016_crypto_paper_portfolios.sql','utf8'));
    const permissions = await db.query<{visible:boolean;editable:boolean;append:boolean}>(
      "select has_table_privilege('authenticated','crypto_paper_portfolios','select') as visible, has_table_privilege('service_role','crypto_paper_portfolios','update') as editable, has_table_privilege('service_role','crypto_paper_portfolios','insert') as append");
    assert.deepEqual(permissions.rows[0],{visible:false,editable:false,append:true});
    await db.exec("insert into auth.users values('00000000-0000-4000-8000-000000000001')");
    const insert = (through:number,parent:number) => db.query("insert into crypto_paper_portfolios(user_id,through_ms,prior_ms,state,events,summary) select id,$1,$2,'{}','[]','{}' from auth.users",[through,parent]);
    await insert(60,0); await assert.rejects(insert(120,0)); await insert(120,60);
    await assert.rejects(insert(120,60));
  } finally { await db.close(); }
});
