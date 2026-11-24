import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachContext, cryptoContext, DAY, stockContext } from '../lib/strategy-search/context';
import { searchHistory } from '../lib/strategy-search/engine';
import { seedRecipes } from '../lib/strategy-search/evolution';
import { compareExperiments, fingerprint } from '../lib/strategy-search/experiments';
import { ruleKey, ruleName, type Experiment } from '../lib/strategy-search/model';

const bars = Array.from({length: 1200}, (_, i) => {
  const c = 100 + Math.sin(i/8)*10 + Math.sin(i/3)*3;
  return { t: Date.UTC(2023,0,1+i), o:c, h:c+1, l:c-1, c, v:100 };
});

test('crypto factors use completed UTC days and leave holes in observations', () => {
  const context = cryptoContext(new Map([[DAY,100],[2*DAY,125],[4*DAY,100]]), new Map([[DAY,.01],[2*DAY,.03]]));
  assert.equal(context.get(2*DAY)?.fundingChange, undefined);
  assert.ok(Math.abs(context.get(3*DAY)!.fundingChange! - .02) < 1e-12);
  assert.equal(context.get(3*DAY)?.openInterest, .25);
  assert.equal(context.get(5*DAY)?.openInterest, undefined);
});

test('stock factors use the prior session and the first day after a comparable EPS filing', () => {
  const recent = bars.slice(0, 12);
  const daily = recent.map((b,i) => ({ day:new Date(b.t).toISOString().slice(0,10), bidClose:100+i }));
  const sector = daily.map(b => ({...b,bidClose:100}));
  const facts = [{ start:'2022-10-01',end:'2022-12-31',val:2 }, { start:'2021-10-01',end:'2021-12-31',val:1 }]
    .map(f => ({ ...f, filed:'2023-01-08', form:'10-Q',accn:'original' }));
  const context = stockContext(recent,daily,sector,facts);
  assert.equal(context.get(recent[7].t)?.earnings,undefined);
  assert.equal(context.get(recent[8].t)?.earnings,1);
  assert.equal(context.get(recent[8].t)?.sector,107/102-1);
  const revised = stockContext(recent,daily,sector,[...facts,{...facts[0],val:4,filed:'2023-01-12',form:'10-Q/A',accn:'revision'}]);
  assert.deepEqual(revised,context);
});

test('experiment memory compares actual entry and exit times within a direction', () => {
  const [base,other] = seedRecipes('long',0);
  const trades = new Map(bars.slice(0,70).map(b => [b.t,b.t+DAY]));
  const first = fingerprint(base,trades,2);
  assert.equal(compareExperiments(first,[first]),'repeat');
  assert.equal(compareExperiments(fingerprint(other,trades,3),[first]),'similar');
  const longer = new Map([...trades].map(([entry,exit]) => [entry,exit+DAY]));
  assert.equal(compareExperiments(fingerprint(other,longer,3),[first]),'new');
  assert.equal(compareExperiments(fingerprint({...other,side:'short'},trades,3),[first]),'new');
});

test('scheduled search records contextual experiments and recognizes prior runs using discovery data only', () => {
  const context = new Map(bars.map((b,i) => [b.t,{fundingChange:i % 2 ? .01 : -.01,openInterest:i%3 ? .03 : -.03}]));
  const history = attachContext(bars.map(b => ({...b})),context);
  const pair = {market:'crypto',symbol:'BTC',frame:'1d'} as const;
  const record: Experiment[] = [];
  const first = searchHistory(pair,history,'fixture',{previous:[],record});
  assert.ok(first.generation!.contexts!.fundingChange! > 0 && first.generation!.contexts!.openInterest! > 0);
  assert.equal(record.length,first.generation!.tried);
  const second = searchHistory(pair,history,'fixture',{previous:record,record:[]});
  assert.ok(second.generation!.exactRepeats! >= 40);
  const changed: Experiment[] = [];
  searchHistory(pair,history.map((b,i) => i < Math.floor(history.length*.44) ? b : {...b,c:b.c+12,fundingChange:0}),'fixture',{previous:[],record:changed});
  assert.deepEqual(changed,record);
  const [base] = seedRecipes('long',0);
  const contextual = { ...base, recipe:{...base.recipe,context:'openInterest' as const} };
  assert.notEqual(ruleKey(base),ruleKey(contextual));
  assert.match(ruleName(contextual),/open interest/);
});
