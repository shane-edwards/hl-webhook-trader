import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachContext, cryptoContext, DAY, stockContext } from '../lib/strategy-search/context';
import { searchHistory } from '../lib/strategy-search/engine';
import { seedRecipes } from '../lib/strategy-search/evolution';
import { compareExperiments, fingerprint } from '../lib/strategy-search/experiments';
import { archivePositioning, dailySignals } from '../lib/strategy-search/positioning';
import seed from '../lib/strategy-search/positioning-history.json';
import { strToU8, zipSync } from 'fflate';
import { ruleKey, ruleName, SEARCH_ASSETS, type Experiment } from '../lib/strategy-search/model';

const bars = Array.from({length: 1200}, (_, i) => {
  const c = 100 + Math.sin(i/8)*10 + Math.sin(i/3)*3;
  return { t: Date.UTC(2023,0,1+i), o:c, h:c+1, l:c-1, c, v:100 };
});

test('bundled positioning history covers the crypto catalog and preserves unavailable observations', () => {
  const days = (Date.parse(seed.through)-Date.parse(seed.first))/DAY+1;
  assert.deepEqual(Object.keys(seed.assets).sort(),[...SEARCH_ASSETS.crypto].sort());
  for (const rows of Object.values(seed.assets)) {
    assert.equal(rows.length,days);
    assert.ok(rows.every(([interest,funding]) => (interest === null || Number.isFinite(interest) && interest > 0) &&
      (funding === null || Number.isFinite(funding))));
  }
});

test('crypto factors use completed UTC days and leave holes in observations', () => {
  const context = cryptoContext(new Map([[DAY,100],[2*DAY,125],[4*DAY,100]]), new Map([[DAY,.01],[2*DAY,.03]]));
  assert.equal(context.get(2*DAY)?.fundingChange, undefined);
  assert.ok(Math.abs(context.get(3*DAY)!.fundingChange! - .02) < 1e-12);
  assert.equal(context.get(3*DAY)?.openInterest, .25);
  assert.equal(context.get(5*DAY)?.openInterest, undefined);
  const daily = dailySignals(new Map([[DAY,[100,.01]],[2*DAY,[125,.03]],[4*DAY,[100,null]]]));
  assert.equal(daily.get(2*DAY)?.venueFunding,undefined);
  assert.ok(Math.abs(daily.get(3*DAY)!.venueFunding!-.02)<1e-12);
  assert.equal(daily.get(3*DAY)?.binanceInterest,.25);
  assert.equal(daily.get(5*DAY)?.binanceInterest,undefined);
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

test('a new UTC day extends the bundled archive and the next timeframe reuses its checkpoint', async t => {
  const day = Date.parse(seed.through) + DAY;
  const date = new Date(day).toISOString().slice(0,10);
  let requests = 0;
  const mock = t.mock.method(globalThis,'fetch',async (input: string) => {
    requests++;
    if (input.includes('hyperliquid')) return Response.json(Array.from({length:24},(_,i) =>
      ({coin:'BTC', time:day+i*3_600_000+2, fundingRate:'.00001'})));
    const name = 'BTCUSDT-metrics-'+date+'.csv';
    return new Response(Buffer.from(zipSync({[name]:strToU8(date+' 23:55:00,BTCUSDT,12345\n')})));
  });
  const first = await archivePositioning('BTC',day+DAY,[]);
  assert.equal(requests,2);
  assert.equal(first.tail[0][1],12345);
  assert.ok(Math.abs(first.tail[0][2]!-.00024)<1e-12);
  assert.equal(first.context.has(day+DAY),true);
  const second = await archivePositioning('BTC',day+DAY,first.tail);
  assert.equal(requests,2);
  assert.deepEqual(first,second);
  mock.mock.restore();
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
  const context = new Map(bars.map((b,i) => [b.t,{venueFunding:i % 2 ? .01 : -.01,binanceInterest:i%3 ? .03 : -.03}]));
  const history = attachContext(bars.map(b => ({...b})),context);
  const pair = {market:'crypto',symbol:'BTC',frame:'1d'} as const;
  const record: Experiment[] = [];
  const first = searchHistory(pair,history,'fixture',{previous:[],record});
  assert.ok(first.generation!.contexts!.venueFunding! > 0 && first.generation!.contexts!.binanceInterest! > 0);
  assert.equal(record.length,first.generation!.tried);
  const second = searchHistory(pair,history,'fixture',{previous:record,record:[]});
  assert.ok(second.generation!.exactRepeats! >= 40);
  const changed: Experiment[] = [];
  searchHistory(pair,history.map((b,i) => i < Math.floor(history.length*.44) ? b : {...b,c:b.c+12,venueFunding:0}),'fixture',{previous:[],record:changed});
  assert.deepEqual(changed,record);
  const [base] = seedRecipes('long',0);
  const contextual = { ...base, recipe:{...base.recipe,context:'openInterest' as const} };
  assert.notEqual(ruleKey(base),ruleKey(contextual));
  assert.match(ruleName(contextual),/open interest/);
});
