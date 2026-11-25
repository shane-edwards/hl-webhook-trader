import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparisonTrades, forwardTrades } from '../lib/automation/paper-trades';
import { openPaperPnl } from '../lib/autopilot/paper-fill';
import type { ForwardBook } from '../lib/strategy-search/model';
import type { PaperEvent } from '../lib/automation/crypto-paper-comparison';

test('forward trades deduplicate repeated checkpoints and never reopen a settled position', () => {
  const book: ForwardBook = {version:1,rule:{family:'range',setting:8,trend:0,volume:0,stop:1,reward:2,maxBars:6},
    started:1,cursor:10,lastExit:0,count:0,equity:1,peak:1,drawdown:0,recent:[],state:'tracking',
    pending:{signal:5,entry:6,price:100,stop:98,target:104}};
  const fill = {entry:6,exit:12,price:100,exitPrice:103,net:.027};
  const old = {market:'crypto' as const,idea_id:'search:crypto:BTC:1h',books:[book],trial:null};
  assert.equal(forwardTrades([old])[0].closed,false);
  const latest = {...old,books:[{...book,pending:undefined,recent:[fill]}]};
  const results = forwardTrades([latest,latest,old]);
  assert.equal(results.length,1);
  assert.equal(results[0].closed,true);
  assert.equal(results[0].net,.027);
});

test('portfolio comparisons count each filled signal once and omit signals both portfolios skipped', () => {
  const entry: PaperEvent = {id:'a',at:1,type:'entry',symbol:'BTC',name:'Breakout',sizes:{one:40,shared:20}};
  const events = [entry,{...entry,id:'b',sizes:{one:0,shared:0}},
    {...entry,at:5,type:'exit' as const,net:.03},{...entry,id:'c',sizes:{one:0,shared:10}}];
  const trades = comparisonTrades([],events);
  assert.deepEqual(trades.map(t => [t.portfolios,t.closed,t.net]),[['Both portfolios',true,.03],['Shared budget',false,null]]);
});

test('open paper P&L uses both sides, round-trip costs and signed funding', () => {
  const row = {entry_price:100,notional_usd:200,size:2,funding_paid:1};
  assert.equal(openPaperPnl({...row,side:'long'},110),18.74);
  assert.equal(openPaperPnl({...row,side:'short'},90),18.74);
});
