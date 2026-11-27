import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compound, summariseVault, vaultPeriods } from '../lib/income/hlp';

const near = (actual: number | null, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
const DAY = 86_400_000, T0 = Date.UTC(2025, 0, 1);
const at = (days: number) => T0 + days * DAY;

test('a period return is its profit over the value at its start, so deposits and withdrawals drop out', () => {
  // 100 in the vault earns 10. Then 890 is deposited (value 1000, profit still 10) and the vault earns 50.
  const periods = vaultPeriods([[at(0), '100'], [at(14), '1000'], [at(28), '1050']], [[at(0), '0'], [at(14), '10'], [at(28), '60']]);
  assert.equal(periods.length, 2);
  near(periods[0].ret, 0.10);
  near(periods[1].ret, 0.05);
  // A stretch that starts with an empty vault, or has no matching profit point, is skipped.
  assert.equal(vaultPeriods([[at(0), '0'], [at(14), '100']], [[at(0), '0'], [at(14), '5']]).length, 0);
  assert.equal(vaultPeriods([[at(0), '100'], [at(14), '110']], [[at(0), '0']]).length, 0);
  // Out-of-order points are sorted first.
  near(vaultPeriods([[at(14), '110'], [at(0), '100']], [[at(14), '10'], [at(0), '0']])[0].ret, 0.10);
});

test('returns compound, and the dip is the deepest fall from a high', () => {
  const periods = [{ from: at(0), to: at(10), ret: 0.10 }, { from: at(10), to: at(20), ret: -0.05 }, { from: at(20), to: at(30), ret: -0.05 }, { from: at(30), to: at(40), ret: 0.20 }];
  const all = compound(periods);
  near(all.total, 1.1 * 0.95 * 0.95 * 1.2 - 1);
  near(all.dip, 1 - 0.95 * 0.95);
  assert.equal(all.days, 40);
  near(all.annual, (1 + all.total) ** (365 / 40) - 1);
  // Only periods ending after the cutoff count.
  near(compound(periods, at(20)).total, 0.95 * 1.2 - 1);
  assert.deepEqual(compound([]), { total: 0, dip: 0, days: 0, annual: null });
});

test('the summary gives twelve months, the current rate, the dip, the size and each year', () => {
  // Fortnightly points for two years: 1% a fortnight in 2025, 0.25% a fortnight in 2026, value steady at 1000 then halved.
  const value: Array<[number, string]> = [], pnl: Array<[number, string]> = [];
  let profit = 0;
  for (let i = 0; i <= 52; i++) {
    const time = at(i * 14), year = new Date(time).getUTCFullYear();
    if (i > 0) profit += (year === 2025 ? 0.01 : 0.0025) * Number(value[i - 1][1]);
    value.push([time, String(i >= 40 ? 500 : 1000)]);
    pnl.push([time, String(profit)]);
  }
  const s = summariseVault(value, pnl);
  assert.equal(s.updated, at(52 * 14));
  // Twelve months back takes in the 26 fortnights of 2026 and the last one of 2025.
  near(s.year, 1.01 * 1.0025 ** 26 - 1);
  near(s.nowAnnual, 1.0025 ** (365 / 14) - 1);
  near(s.dip, 0);
  assert.equal(s.size, 500);
  assert.equal(s.sizeYearAgo, 1000);
  assert.deepEqual(s.years.map(row => [row.year, row.partial]), [[2026, true], [2025, false]]);
  near(s.years[1].total, 1.01 ** 26 - 1);

  // Too little history to quote twelve months or a current rate.
  const short = summariseVault(value.slice(0, 4), pnl.slice(0, 4));
  assert.equal(short.year, null);
  assert.equal(short.nowAnnual, null);
  assert.equal(summariseVault([], []).updated, null);
});
