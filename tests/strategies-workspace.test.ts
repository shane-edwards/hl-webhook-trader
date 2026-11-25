import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogIdeas, namedRow, searchRows } from '../lib/automation/strategy-workspace';
import { studyEvidence, paperThreshold, PAPER_REQUIREMENT, type AutomationProfile } from '../lib/automation/model';
import type { PaperResults } from '../lib/automation/policy';
import { trialAdmission, updateTrial } from '../lib/automation/forward-trials';
import { advanceForward, checkPerpVenue } from '../lib/strategy-search/engine';
import type { SearchReport } from '../lib/strategy-search/model';

const idea = catalogIdeas('stocks').find(i => i.executable)!;
const e = studyEvidence({ ...idea, from:'2025-01-01', through:'2026-01-01', trades:12, holdoutTrades:4,
  early:.03, later:.02, stress:.01, benchmark:0, drawdown:.02 });
const now = Date.UTC(2026,0,3);
const asOf = new Date(now).toISOString();
const profile = { market:'stocks', enabled:true, entries_paused:false, mode:'research' } as AutomationProfile;

test('evaluated rules enter exploratory paper even with losing or empty holdouts', () => {
  assert.equal(trialAdmission(e),'sample');
  for (const patch of [{early:0},{benchmark:.02},{drawdown:.13},{stress:-.01},{holdoutTrades:0}])
    assert.equal(trialAdmission({...e,...patch}),'exploratory');
  for (const patch of [{stress:NaN},{reason:'Incomplete data'}])
    assert.equal(trialAdmission({...e,...patch}),null);
});

test('named forward paper begins empty, deduplicates closes, flags gaps and keeps observing drawdown', () => {
  const historical = [{entry:now-20,exit:now-10,net:.8}];
  const start = updateTrial(e,null,historical,0,now,now)!;
  assert.equal(start.fills.length,0);
  const fills = [...historical, {entry:now+1,exit:now+3,net:.02}, {entry:now+4,exit:now+5,net:-.17}];
  const next = updateTrial(e,start,fills,0,now+8,now+9)!;
  assert.equal(next.state,'tracking'); assert.equal(next.count,2);
  assert.ok(next.drawdown >= .16);
  assert.equal(updateTrial(e,next,fills,0,now+20,now+21)?.count,2);
  const gap = updateTrial(e,start,fills,now+1,now+8,now+9)!;
  assert.equal(gap.state,'data-gap'); assert.equal(gap.checked,now);
  assert.deepEqual(updateTrial(e,gap,fills,0,now+8,now+9),next);
});

test('only a current executable backtest and the exact broker paper results reach review', () => {
  const trial = updateTrial(e,null,[],0,now,now)!;
  const passed = {...e,qualified:true};
  const closes = (count: number) => Array.from({length:count},(_,i) => ({at:new Date(now+i*86400000).toISOString(),pnl:3+i%2}));
  const broker = paperThreshold(closes(PAPER_REQUIREMENT.trades));
  const row = (o = passed, date = asOf, result: PaperResults = broker) => namedRow(idea,o,date,trial,result,profile,false,true,now);
  assert.equal(row().stage,'ready');
  assert.equal(row(e).stage,'paper');
  assert.equal(row(passed,'2024-01-01').stage,'paper');
  assert.equal(row({...passed,version:'other'}).stage,'paper');
  assert.equal(row(passed,asOf,paperThreshold([])).stage,'paper');
  assert.equal(row(passed,asOf,paperThreshold(closes(PAPER_REQUIREMENT.trades-1))).stage,'paper');
  assert.equal(row(passed,asOf,{...broker,passed:false,blocked:'Rule has not passed the long-history backtest'}).stage,'paper');
  const only = {...idea,executable:false};
  assert.equal(namedRow(only,passed,asOf,trial,broker,profile,false,true,now).live,'Paper only');
  const live = {...profile,mode:'live' as const,scan_for_opportunities:true,live_scan_versions:[e.version],entries_paused:true};
  assert.equal(namedRow(idea,passed,asOf,trial,broker,live,false,true,now).status,'Entries paused');
});

test('small-sample generated rules can track forward, and crypto still requires venue evidence', () => {
  const metric = {trades:7,groups:4,net:.03,average:.004,drawdown:.02,score:4};
  const report: SearchReport = { verdict:'small-sample', pair:{market:'stocks',symbol:'AAPL',frame:'1d'},rule:{
    family:'range',setting:8,trend:0,volume:0,stop:2,reward:2,maxBars:6},stress:metric, holdout:metric,venue:null,benchmark:0,
    revision:7,source:'fixture',bars:500,from:'',through:asOf,tried:4,validationPassed:3,testedOnLaterData:1,holdoutFrom:'' };
  const books = advanceForward(report,[],[],now);
  assert.equal(books[0].admission,'sample');
  assert.equal(advanceForward(report,books,[],now+1).length,1);
  const [row] = searchRows({...report,forward:books},true);
  assert.equal(row.stage,'paper'); assert.equal(row.live,'Paper only');
  const perp = {...report,pair:{market:'crypto' as const,symbol:'BTC',frame:'1h' as const}};
  assert.equal(checkPerpVenue(perp,[]).verdict,'venue-failed');
  assert.equal(advanceForward(perp,[],[],now).length,0);
});
