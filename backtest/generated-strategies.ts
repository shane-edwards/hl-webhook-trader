/** Fixed daily recipes on predetermined baskets. Run with --download to fill missing public data. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { replayFixed, searchHistory, searchInputs } from '../lib/strategy-search/engine';
import { seedRecipes } from '../lib/strategy-search/evolution';
import { ruleName, type SearchBar, type SearchSide } from '../lib/strategy-search/model';

const cache = 'backtest/data/intraday', day = 86_400_000;
const baskets = {
  stocks: ['AAPL AMD AMZN CAT JPM MSFT PFE PG WMT XOM HD CSCO','KO UNH INTC DIS JNJ BAC IBM CVX TGT ORCL UPS TXN','HON MCD LOW AXP DE NKE MMM DUK SO ADP GILD QCOM'],
  crypto: ['BTC ETH LTC XRP','ADA DOGE LINK SOL','BCH BNB ETC TRX','AAVE AVAX ATOM XLM'],
};
async function cached(path: string, url: string, member?: string): Promise<Buffer> {
  if (existsSync(path)) return readFileSync(path);
  if (!process.argv.includes('--download')) throw new Error(`Missing ${path}. Run with --download.`);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent':'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`${response.status} retrieving ${url}`);
  const raw = new Uint8Array(await response.arrayBuffer());
  const value = Buffer.from(member ? unzipSync(raw)[member] : raw);
  mkdirSync(dirname(path), {recursive:true});
  writeFileSync(path,value);
  return value;
}
async function stock(symbol: string): Promise<SearchBar[]> {
  const data = await cached(join(cache,'daily-price-action',symbol+'.json'),
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=1104537600&period2=1793491200&interval=1d&events=div%2Csplits`);
  const raw = JSON.parse(data.toString()).chart.result[0];
  const q = raw.indicators.quote[0];
  return raw.timestamp.map((stamp: number, i: number) => {
    const ratio = raw.indicators.adjclose[0].adjclose[i]/q.close[i];
    return {t: Math.floor(stamp*1000/day)*day, o:q.open[i]*ratio, h:q.high[i]*ratio,
      l:q.low[i]*ratio, c:q.close[i]*ratio, v:q.volume[i]};
  }).filter((b: SearchBar) => b.o>0 && b.c>0 && b.l>0 && b.h>0);
}
function rows(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes).trim().split(/\r?\n/).filter(line=>/^\d/.test(line)).map(line=>line.split(',').map(Number));
}
async function crypto(symbol: string): Promise<SearchBar[]> {
  const base = 'https://data.binance.vision/data/futures/um';
  const prices = new Map<number,SearchBar>(), payments = new Map<number,number>();
  for (let m=0; m<70; m++) {
    const month = new Date(Date.UTC(2021,m,1)).toISOString().slice(0,7);
    for (const [folder,product,tag] of [['prices',`klines/${symbol}USDT/1d`,'1d'],['funding',`fundingRate/${symbol}USDT`,'fundingRate']]) {
      const name = `${symbol}USDT-${tag}-${month}`;
      const contents = await cached(join(cache,'crypto-swing',folder,name+'.csv'),`${base}/monthly/${product}/${name}.zip`,name+'.csv');
      for (const r of rows(contents)) {
        if (folder==='prices') prices.set(r[0],{t:r[0],o:r[1],h:r[2],l:r[3],c:r[4],v:r[5]});
        else {
          const stamp=Math.round(r[0]/3_600_000)*3_600_000;
          if (payments.has(stamp)) throw new Error('Duplicate settlement');
          payments.set(stamp,r[2]);
        }
      }
    }
  }
  const stamps=[...payments.keys()].sort((a,b)=>a-b);
  if (stamps.some((t,i)=>i>0 && t-stamps[i-1]>8*3_600_000)) throw new Error('Incomplete funding');
  for(let t=Date.UTC(2021,0,1);t<Date.UTC(2026,10,1);t+=day) {
    if (prices.has(t)) continue;
    const name=`${symbol}USDT-1h-${new Date(t).toISOString().slice(0,10)}`;
    const zip=await cached(join(cache,'daily-price-action',name+'.zip'),`${base}/daily/klines/${symbol}USDT/1h/${name}.zip`);
    const h=rows(unzipSync(zip)[name+'.csv']);
    if(h.length!==24 || h.some((r,i)=>r[0]!==t+i*3_600_000)) throw new Error('Incomplete hourly repair');
    prices.set(t,{t,o:h[0][1],h:Math.max(...h.map(r=>r[2])),l:Math.min(...h.map(r=>r[3])),c:h[23][4],v:h.reduce((sum,r)=>sum+r[5],0)});
  }
  for(const [stamp,rate] of payments) {
    const bar=prices.get(Math.floor((stamp-1)/day)*day);
    if(bar) {bar.funding=(bar.funding??0)+Math.max(0,rate);bar.shortFunding=(bar.shortFunding??0)+Math.max(0,-rate);}
  }
  return [...prices.values()].sort((a,b)=>a.t-b.t);
}

async function batch(market: keyof typeof baskets) {
  const stocks=market==='stocks';
  const bounds=(stocks?['2012-01-01','2017-01-01','2022-01-01','2026-11-01']:['2022-01-01','2024-01-01','2025-01-01','2026-11-01']).map(Date.parse);
  const results = seedRecipes('long',0,64).map(rule=>({name:ruleName(rule),rule, baskets:[] as {early:number;validation:number;latest:number;stress:number;benchmark:number;trades:number}[]}));
  for (const basket of baskets[market]) {
    const names=basket.split(' ');
    const sides: SearchSide[]=stocks?['long']:['long','short'];
    const weight=1/(names.length*sides.length);
    const totals=results.map(()=>({early:0,validation:0,latest:0,stress:0,benchmark:0,trades:0}));
    for (const symbol of names) {
      const bars=await (stocks?stock:crypto)(symbol);
      const cuts=bounds.map(t=>{const i=bars.findIndex(bar=>bar.t>=t);return i<0?bars.length:i;});
      if(cuts[0]<110 || cuts.slice(1).some((n,i)=>n<=cuts[i])) throw new Error('Insufficient history for '+symbol);
      if(stocks && bars.slice(cuts[0],cuts[3]).some((b,i,a)=>i && b.t-a[i-1].t>7*day)) throw new Error('Stock calendar gap '+symbol);
      for (const side of sides) {
        const input=searchInputs(bars,cuts[1],side);
        for (const [i,item] of results.entries()) {
          const rule={...item.rule,side};
          const periods=['early','validation','latest','stress'] as const;
          periods.forEach((label,k)=>{
            const segment=Math.min(k,2);
            const cost=stocks?(k===3?.0035:.0015):(k===3?.002:.001);
            const run=replayFixed(input,rule,cuts[segment],cuts[segment+1],cost);
            totals[i][label]+=run.net*weight;
            if(k===2) totals[i].trades+=run.trades;
            if(k===3) totals[i].benchmark+=weight*(side==='short'?-1:1)*
              (Math.exp(run.exposure*Math.log(bars[cuts[3]-1].c/bars[cuts[2]].o))-1);
          });
        }
      }
    }
    results.forEach((r,i)=>r.baskets.push(totals[i]));
  }
  return results;
}
async function main(){
  const output={stocks:await batch('stocks'),crypto:await batch('crypto')};
  writeFileSync('backtest/generated-strategy-results.json',JSON.stringify(output,null,2)+'\n');
  const format=(n:number)=>(100*n).toFixed(2)+'%';
  const mean=(values:number[])=>values.reduce((a,b)=>a+b,0)/values.length;
  const used=new Set<string>();
  const examples:string[]=[];
  for(const market of ['crypto','stocks'] as const){
    const candidates=output[market].map(r=>({r,base:mean(r.baskets.map(b=>b.latest)),stress:mean(r.baskets.map(b=>b.stress))}))
      .filter(x=>x.base>0 && !used.has(x.r.name)).sort((a,b)=>b.stress-a.stress);
    for(const {r,base,stress} of candidates.slice(0,market==='crypto'?5:20-examples.length)){
      used.add(r.name);
      examples.push(`| ${market} | ${r.name} | ${format(base)} | ${format(stress)} | ${r.baskets.filter(b=>b.stress>0).length}/${r.baskets.length} |`);
    }
  }
  const lines=['# Generated directional trades', '',
    'All 64 fixed setup–trigger combinations were tested in each market. Every rule enters at the next open when its trigger occurs one to four bars after its setup. Each uses a 1.75× 14-bar average true range stop, a target of 1.8 times initial risk, and a 12-bar time exit. Stops take priority on ambiguous bars. The table uses the long terminology. Crypto shorts mirror the price conditions.',
    '', '## Twenty historically profitable trade ideas', '',
    'These distinct rules had positive cumulative returns after base costs with equal starting capital across all baskets of their market. The five positive crypto examples are included first, followed by the highest pooled stressed-return stock examples with distinct setup and trigger combinations. This is a retrospective list. The higher-cost column and number of positive baskets show how sensitive those gains were.',
    '', '| Market | Setup → trigger | All baskets, base | All baskets, higher costs | Baskets positive at higher costs |',
    '| --- | --- | ---: | ---: | ---: |', ...examples, '', '## Complete results', '',
    'Each row shows the primary basket after base costs and the weakest of the replication and primary baskets at higher costs. Percentages are cumulative, before tax. All 64 rows are shown in generation order. Similar strategies may take many of the same trades.',
    '', '| Setup → trigger | Stocks primary | Stocks weakest stressed | Crypto primary | Crypto weakest stressed |',
    '| --- | ---: | ---: | ---: | ---: |'];
  for(const [i,row] of output.stocks.entries()){
    const values=[row,output.crypto[i]].flatMap(r=>[r.baskets[0].latest, Math.min(...r.baskets.map(b=>b.stress))]);
    lines.push('| '+[row.name,...values.map(format)].join(' | ')+' |');
  }
  lines.push('', '## Sample and accounting', '',
    'Stocks use 36 surviving US equities in three disjoint twelve-stock baskets. The unlevered long sleeves share initial capital equally. Discovery covers 2012–2016, validation 2017–2021, and the last window January 2022–October 2026. Daily OHLC is adjusted for splits and distributions. Base and higher modeled costs are 0.15% and 0.35% per side. Survivorship and stock market exposure can account for apparent profits.',
    '', 'Crypto uses 16 Binance USDT perpetuals in four disjoint four-coin baskets. Long and short sleeves share initial capital equally and are accounted for separately. Discovery covers 2022–2023, validation 2024 and the last window January 2025–October 2026. Each side pays adverse recorded funding and receives no favorable funding. Execution costs are 0.10% and 0.20% per side. Baskets share calendar dates. Daily bars cannot establish executable fills or intraday drawdown.',
    '', 'The replication screen requires positive primary discovery and validation returns plus positive later returns under higher costs and at least twelve closed trades in every basket. The platform applies separate per-symbol qualification and forward simulation. This batch never registers historical results as executable candidates.',
    '', '[All periods, costs, exposure-adjusted benchmarks and trade counts](generated-strategy-results.json)');
  writeFileSync('backtest/GENERATED-STRATEGIES.md',lines.join('\n')+'\n');
  for(const [market,results] of Object.entries(output)){
    const positive=results.filter(r=>r.baskets[0].latest>0);
    const repeated=results.filter(r=>r.baskets[0].early>0 && r.baskets[0].validation>0 && r.baskets.every(b=>b.stress>0&&b.trades>=12));
    console.log(market,results.length,'tested,',positive.length,'primary positive,',repeated.length,'repeated');
    console.log(repeated.map(r=>r.name).join('\n'));
  }
  // Exercise the evolutionary production search with the same frozen calendar cutoff on two equity pairs.
  for(const symbol of ['AAPL','MSFT']){
    const bars=(await stock(symbol)).filter(b=>b.t>=Date.UTC(2023,9,1));
    const report=searchHistory({market:'stocks',symbol,frame:'1d'},bars,'Adjusted daily research candles');
    console.log(symbol,report.verdict,report.generation);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
