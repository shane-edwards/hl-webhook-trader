// First real orders, on Hyperliquid TESTNET only:  npm run testnet:check
//
// Nothing in this app had ever been placed with a real account when this was
// written; everything was checked against the SDK's signatures and a simulated
// exchange. This script is the missing step. It walks one small position
// through every order type the app sends and reports what the exchange said.
//
//   HL_TESTNET_KEY=0x...            key of a testnet account or of its API (agent) wallet
//   HL_TESTNET_ACCOUNT=0x...        the account address, when the key is an API wallet
//   npm run testnet:check [COIN]    COIN defaults to BTC
//
// Fund the testnet account first (app.hyperliquid-testnet.xyz, "Faucet").
// It uses about $15 of position size and always tries to leave the account flat.
import { createHLClient } from '../lib/hyperliquid/client';
import { getUserFills } from '../lib/hyperliquid/public';

const key = process.env.HL_TESTNET_KEY;
if (!key) { console.error('Set HL_TESTNET_KEY (a TESTNET key). This script never talks to mainnet.'); process.exit(1); }
const coin = (process.argv[2] ?? 'BTC').toUpperCase();
// isTestnet is hard-coded: there is no flag that points this script at mainnet.
const hl = createHLClient({ privateKey: key, accountAddress: process.env.HL_TESTNET_ACCOUNT, isTestnet: true });

const results: Array<[string, boolean, string]> = [];
async function step<T>(name: string, fn: () => Promise<T>, describe: (v: T) => string = () => ''): Promise<T | null> {
  try {
    const v = await fn();
    results.push([name, true, describe(v)]);
    console.log(`PASS  ${name}${describe(v) ? `: ${describe(v)}` : ''}`);
    return v;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push([name, false, message]);
    console.log(`FAIL  ${name}: ${message}`);
    return null;
  }
}
const expect = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const triggers = async () => (await hl.getOpenOrders(coin)).filter(o => o.isTrigger && o.reduceOnly);

(async () => {
  console.log(`Testnet check on ${coin} for account ${hl.address}\n`);
  const started = Date.now();
  const account = await step('read account', () => hl.getAccountSummary(), a => `value $${a.totalValue.toFixed(2)}`);
  if (!account || account.totalValue < 20) { console.log('\nThe account needs at least $20 of testnet funds. Stopping.'); process.exit(1); }
  if (await hl.getPosition(coin)) { console.log(`\nThere is already a ${coin} position on this account. Close it first so the check starts flat.`); process.exit(1); }

  const fill = await step('market entry (IOC order + set leverage)', () => hl.placeMarketOrder({ coin, isBuy: true, sizeUsd: 15, leverage: 2 }), f => `${f.sizeInContracts} at ${f.fillPrice}`);
  if (!fill) { console.log('\nThe entry failed, so nothing else can be checked.'); process.exit(1); }

  try {
    const pos = await step('position is readable', async () => { const p = await hl.getPosition(coin); expect(!!p && p.side === 'long', 'no long position found'); return p!; }, p => `${p.size} @ ${p.entryPrice}`);
    const entry = pos?.entryPrice ?? fill.fillPrice, size = pos?.size ?? fill.sizeInContracts;

    await step('stop-loss and take-profit (positionTpsl)', async () => {
      const oids = await hl.placeProtectiveOrders({ coin, side: 'long', size, stopLossPx: entry * 0.95, takeProfitPx: entry * 1.05 });
      expect(!!oids.stopLossOid && !!oids.takeProfitOid, `order ids missing: ${JSON.stringify(oids)}`);
      const open = await triggers();
      expect(open.length === 2, `expected 2 resting triggers, found ${open.length}: ${JSON.stringify(open)}`);
      // The app tells stops from targets by this text; if it differs on the real exchange, exits management breaks.
      expect(open.some(o => /stop/i.test(o.orderType)) && open.some(o => /profit/i.test(o.orderType)), `unexpected orderType labels: ${open.map(o => o.orderType).join(', ')}`);
      return open;
    }, o => o.map(x => `${x.orderType} @ ${x.triggerPx}`).join(', '));

    await step('move the stop (new stop placed with grouping "na", then the old one cancelled)', async () => {
      const before = (await triggers()).filter(o => /stop/i.test(o.orderType));
      await hl.placeTriggerOrders({ coin, side: 'long', legs: [{ kind: 'sl', triggerPx: entry * 0.97, size }], grouping: 'na' });
      await hl.cancelOrders(coin, before.map(o => o.oid));
      const after = (await triggers()).filter(o => /stop/i.test(o.orderType));
      expect(after.length === 1, `expected exactly 1 stop after the move, found ${after.length}`);
      return after[0];
    }, o => `stop now ${o.triggerPx}`);

    await step('split targets (two take-profits with their own sizes)', async () => {
      await hl.cancelProtectiveOrders(coin);
      // Each part must clear the $10 minimum, so this only works if the position is worth $20 or more; report honestly if not.
      const half = Math.floor((size / 2) * 1e5) / 1e5;
      const oids = await hl.placeTriggerOrders({ coin, side: 'long', grouping: 'na', legs: [
        { kind: 'sl', triggerPx: entry * 0.95, size }, { kind: 'tp', triggerPx: entry * 1.05, size: half }, { kind: 'tp', triggerPx: entry * 1.1, size: size - half },
      ] });
      return oids;
    }, o => `order ids ${o.join(', ')}`);

    await step('clear the stop and targets', async () => { await hl.cancelProtectiveOrders(coin); expect((await triggers()).length === 0, 'triggers still resting'); });
  } finally {
    await step('close the position (reduce-only IOC)', async () => {
      const closed = await hl.closePosition(coin);
      expect(closed.fullyClosed, `only ${closed.filledSize} closed`);
      expect(!(await hl.getPosition(coin)), 'position still open');
      return closed;
    }, c => `at ${c.fillPrice}`);
  }

  const mark = await hl.getMarkPrice(coin);
  const limit = await step('post-only limit entry with attached stop and target (normalTpsl)', () =>
    hl.placeLimitEntry({ coin, isBuy: true, size: 15 / (mark * 0.8), price: mark * 0.8, leverage: 2, stopLossPx: mark * 0.76, takeProfitPx: mark * 0.88 }), o => `resting, order ${o.oid} at ${o.price}`);
  if (limit) {
    await step('order status of the resting entry', async () => { const st = await hl.getOrderStatus(limit.oid); expect(st?.status === 'open' && st.filledSize === 0, `unexpected status ${JSON.stringify(st)}`); return st!; }, s => s.status);
    await step('rule 1: no stop is active while the entry is unfilled', async () => {
      const open = await hl.getOpenOrders(coin);
      console.log(`      open orders as the exchange lists them: ${JSON.stringify(open)}`);
      return open;
    }, o => `${o.length} listed (see above; children of an unfilled entry should not be able to trade)`);
    await step('cancel the entry: its stop and target go with it', async () => {
      await hl.cancelOrders(coin, [limit.oid]);
      await wait(1500);
      const st = await hl.getOrderStatus(limit.oid);
      expect(!!st && /cancel/i.test(st.status), `status after cancel: ${JSON.stringify(st)}`);
      const left = await hl.getOpenOrders(coin);
      expect(left.length === 0, `orders left behind: ${JSON.stringify(left)}`);
      return st!;
    }, s => s.status);
  }

  await wait(2000);
  await step('fills are readable with fees (used for true profit per trade)', async () => {
    const { fills } = await getUserFills(hl.address, started - 5_000, true);
    const mine = fills.filter(f => f.coin === coin);
    expect(mine.length >= 2, `expected the entry and exit fills, found ${mine.length}`);
    expect(mine.every(f => f.fee > 0), 'a fill came back without a fee');
    expect(mine.some(f => /^Close/.test(f.dir)), `no closing fill; dir values: ${mine.map(f => f.dir).join(', ')}`);
    return mine;
  }, f => `${f.length} fills, fees $${f.reduce((a, x) => a + x.fee, 0).toFixed(4)}, realised $${f.reduce((a, x) => a + x.closedPnl, 0).toFixed(4)}`);

  const failed = results.filter(r => !r[1]);
  console.log(`\n${results.length - failed.length} of ${results.length} steps passed.`);
  if (failed.length) console.log('Failed steps are the things to fix before any real money:\n' + failed.map(f => `  - ${f[0]}: ${f[2]}`).join('\n'));
  else console.log('Next: connect this testnet wallet in the app (Settings, testnet on), place a trade from the ticket with a split target and a trailing stop,\nrun the Autopilot in live mode there, and use the kill switch.');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
