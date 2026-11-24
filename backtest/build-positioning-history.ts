import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { SEARCH_ASSETS } from '../lib/strategy-search/model';
import { DAY } from '../lib/strategy-search/context';

const first = Date.parse('2023-09-01'), end = Date.parse(process.argv[2] ?? '');
if (!Number.isFinite(end) || end < first || end + DAY > Date.now()) throw Error('Pass the last completed UTC date.');
const days = Math.floor((end - first) / DAY) + 1;
const date = (t:number) => new Date(t).toISOString().slice(0,10);
const cache = 'backtest/data/intraday/positioning-seed';
const result: Record<string,(number | null)[][]> = {};

async function http(url:string, init?:RequestInit) {
  for(let attempt=0; ; attempt++) {
    try {
      const response = await fetch(url,{...init,signal:AbortSignal.timeout(12000)});
      if(response.ok || response.status===404) return response;
      throw Error('HTTP '+response.status);
    } catch(error) {
      if(attempt>=4) throw error;
      await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
    }
  }
}

async function main() {
  await mkdir(cache,{recursive:true});
  for (const asset of SEARCH_ASSETS.crypto) {
    const contract = asset+'USDT';
    const target = join(cache,asset+'-'+date(end)+'.json');
    try { result[asset]=JSON.parse(await readFile(target,'utf8')); continue; } catch { /* first build */ }
    const history:(number|null)[][] = Array.from({length:days},()=>[null,null]);
    const csv = await readFile('backtest/data/'+asset.toLowerCase()+'-funding-daily-hyperliquid.csv','utf8').catch(()=>'');
    let last = first-1;
    for(const line of csv.trim().split('\n').slice(1)) {
      const [day,rate,hours]=line.split(','); const t=Date.parse(day), index=(t-first)/DAY;
      if(index>=0 && index<days && Number(hours)===24) {history[index][1]=Number(rate);last=t;}
    }
    let cursor=last+1;
    if(last>=first) cursor=last+DAY;
    const funding=new Map<number,Map<number,number>>();
    while(cursor<end+DAY) {
      const response=await http('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'fundingHistory',coin:asset,startTime:cursor,endTime:end+DAY-1})});
      const rows=await response.json();
      if(!Array.isArray(rows)) throw Error('Invalid funding response');
      if(!rows.length) break;
      for(const row of rows) {
        const hour=Math.floor(row.time/3600000), t=Math.floor(hour/24)*DAY;
        if(row.coin!==asset || t<first || t>end) continue;
        const group=funding.get(t)??new Map();group.set(hour,Number(row.fundingRate));funding.set(t,group);
      }
      const next=Math.max(...rows.map(r=>r.time))+1;
      if(next<=cursor)throw Error('Funding cursor did not advance');
      cursor=next;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    for(const [t,hours] of funding) if(hours.size===24)history[(t-first)/DAY][1]=Number([...hours.values()].reduce((a,b)=>a+b,0).toFixed(10));
    let index=0;
    const work=async()=>{
      while(index<days){
        const i=index++,day=date(first+i*DAY), name=contract+'-metrics-'+day;
        let content=await readFile(join('backtest/data/intraday/crypto-positioning',contract,name+'.csv'),'utf8').catch(()=>'');
        if(!content) {
          const response=await http('https://data.binance.vision/data/futures/um/daily/metrics/'+contract+'/'+name+'.zip');
          if(response.status===404) continue;
          const file=unzipSync(new Uint8Array(await response.arrayBuffer()))[name+'.csv'];
          if(!file) throw Error('Invalid archive');
          content=strFromU8(file);
        }
        const row=content.split('\n').find(l=>l.startsWith(day+' 23:55:00,'+contract+','));
        const value=Number(row?.split(',')[2]);
        if(value>0 && Number.isFinite(value))history[i][0]=value;
      }
    };
    await Promise.all(Array.from({length:20},work));
    result[asset]=history;
    await writeFile(target,JSON.stringify(history));
    console.log(asset,'days with open interest / funding',history.filter(r=>r[0]!=null).length,history.filter(r=>r[1]!=null).length);
  }
  await writeFile('lib/strategy-search/positioning-history.json',JSON.stringify({first:date(first),through:date(end),assets:result})+'\n');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
