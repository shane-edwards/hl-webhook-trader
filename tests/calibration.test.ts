import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildCalibration, ideaResult, knownAt, loggedIdea, noEdgeProbability, predictProbability, PRIOR_WEIGHT, type LoggedIdea } from '../lib/scorecard';

const HOUR = 3_600_000, DAY = 24 * HOUR, T0 = Date.UTC(2026, 10, 1);
const near = (actual: number | null, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);

const idea = (over: Partial<LoggedIdea>): LoggedIdea => ({ bias: 'long', strength: 'strong', stopPct: 2, targetPct: 4,
  outcome: null, resolved: false, createdAt: T0, outcomeAt: null, ...over });
const won = (day: number, over: Partial<LoggedIdea> = {}) => idea({ createdAt: T0 + day * DAY, outcome: 'target', outcomeAt: T0 + day * DAY + 5 * HOUR, ...over });
const lost = (day: number, over: Partial<LoggedIdea> = {}) => idea({ createdAt: T0 + day * DAY, outcome: 'stop', outcomeAt: T0 + day * DAY + 5 * HOUR, ...over });

test('with no edge the chance of target first is the stop distance over the whole distance', () => {
  near(noEdgeProbability(2, 4), 1 / 3);
  near(noEdgeProbability(3, 3), 0.5);
  assert.equal(noEdgeProbability(0, 4), null);
  assert.equal(noEdgeProbability(2, Number.NaN), null);
});

test('an idea counts as a miss when the stop came first or the week ran out, and is open until then', () => {
  assert.equal(ideaResult({ outcome: 'target', resolved: false }), 1);
  assert.equal(ideaResult({ outcome: 'stop', resolved: false }), 0);
  assert.equal(ideaResult({ outcome: 'neither', resolved: true }), 0);
  assert.equal(ideaResult({ outcome: null, resolved: false }), null);
  assert.equal(knownAt(idea({})), null);
  assert.equal(knownAt(won(0)), T0 + 6 * HOUR, 'known when the hourly bar that touched the target closed');
  assert.equal(knownAt(idea({ outcome: 'neither', resolved: true })), T0 + 7 * DAY + HOUR);
});

test('a prediction starts at the no-edge chance and moves with the earlier record of the same kind', () => {
  const fresh = predictProbability(idea({}), [], T0)!;
  near(fresh.probability, 1 / 3);
  assert.equal(fresh.sample, 0);

  // Ten earlier strong longs, seven reached the target: each beat or missed its own 1/3 chance.
  const history = [...Array.from({ length: 7 }, (_, i) => won(i)), ...Array.from({ length: 3 }, (_, i) => lost(7 + i))];
  const later = predictProbability(idea({}), history, T0 + 30 * DAY)!;
  assert.equal(later.sample, 10);
  near(later.probability, 1 / 3 + (7 * (2 / 3) - 3 * (1 / 3)) / (10 + PRIOR_WEIGHT));

  // Another direction or strength, and ideas still open, do not count.
  const others = [won(0, { bias: 'short' }), won(1, { strength: 'moderate' }), idea({ createdAt: T0 + DAY })];
  assert.equal(predictProbability(idea({}), others, T0 + 30 * DAY)!.sample, 0);
  assert.equal(predictProbability(idea({ stopPct: 0 }), history, T0 + 30 * DAY), null);
});

test('a prediction never uses a result that was not yet known', () => {
  const history = [won(0), won(1), won(2)];
  // As of day 1 only the first idea has finished (it closed five hours after it appeared).
  assert.equal(predictProbability(idea({}), history, T0 + DAY)!.sample, 1);
  assert.equal(predictProbability(idea({}), history, T0 + 5 * HOUR)!.sample, 0, 'the bar that touched the target has not closed yet');
  // An idea that ran out the week is known only after the week.
  const expired = [idea({ outcome: 'neither', resolved: true })];
  assert.equal(predictProbability(idea({}), expired, T0 + 7 * DAY)!.sample, 0);
  assert.equal(predictProbability(idea({}), expired, T0 + 7 * DAY + HOUR)!.sample, 1);
});

test('a long run of winners cannot push a prediction to certainty', () => {
  const history = Array.from({ length: 5000 }, (_, i) => won(i / 100, { stopPct: 4, targetPct: 0.1 }));
  assert.equal(predictProbability(idea({ stopPct: 4, targetPct: 0.1 }), history, T0 + 400 * DAY)!.probability, 0.98);
});

test('calibration scores stored predictions and rebuilds the missing ones from the earlier record', () => {
  const ideas = [
    won(0, { predicted: 0.8 }), lost(1, { predicted: 0.2 }),
    won(2),                       // no stored prediction: rebuilt from the two ideas above
    idea({ createdAt: T0 + 3 * DAY, predicted: 0.9 }), // still open: not scored
  ];
  const c = buildCalibration(ideas);
  assert.equal(c.scored, 3);
  assert.equal(c.stored, 2);
  // Rebuilt: one win (+2/3) and one loss (-1/3) known by day 2.
  const rebuilt = 1 / 3 + (2 / 3 - 1 / 3) / (2 + PRIOR_WEIGHT);
  near(c.meanPredicted, (0.8 + 0.2 + rebuilt) / 3);
  near(c.hitRate, 2 / 3);
  near(c.brier, (0.2 ** 2 + 0.2 ** 2 + (1 - rebuilt) ** 2) / 3);
  near(c.noEdgeBrier, ((2 / 3) ** 2 + (1 / 3) ** 2 + (2 / 3) ** 2) / 3);
  near(c.skill, 1 - c.brier! / c.noEdgeBrier!);
  assert.ok(c.skill! > 0, 'these predictions beat assuming no edge');
  assert.deepEqual(c.buckets.map(b => b.ideas), [1, 1, 0, 0, 1]);
  near(c.buckets[4].actual, 1);
  near(c.buckets[0].actual, 0);
});

test('calibration with nothing scored reports no numbers', () => {
  const c = buildCalibration([idea({})]);
  assert.equal(c.scored, 0);
  assert.equal(c.brier, null);
  assert.equal(c.skill, null);
});

test('a database row reads into an idea, and migration 027 stores a prediction within 0 to 1', async () => {
  const row = loggedIdea({ bias: 'short', strength: 'moderate', stop_pct: '2.50', target_pct: '5.00', outcome: 'stop', resolved: false,
    created_at: '2026-11-01T00:00:00Z', outcome_at: '2026-11-01T05:00:00Z', predicted_prob: '0.3125' });
  assert.deepEqual(row, { bias: 'short', strength: 'moderate', stopPct: 2.5, targetPct: 5, outcome: 'stop', resolved: false,
    createdAt: T0, outcomeAt: T0 + 5 * HOUR, predicted: 0.3125 });
  assert.equal(loggedIdea({ created_at: '2026-11-01T00:00:00Z' }).predicted, null);

  const pg = new PGlite();
  try {
    await pg.exec('CREATE TABLE public.suggestion_log (id serial PRIMARY KEY, symbol text NOT NULL);');
    const sql = readFileSync('supabase/migrations/027_suggestion_predictions.sql', 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // running it twice is harmless
    await pg.exec("INSERT INTO public.suggestion_log (symbol) VALUES ('OLD');");
    await pg.exec("INSERT INTO public.suggestion_log (symbol, predicted_prob, predicted_n) VALUES ('NEW', 0.4167, 12);");
    await assert.rejects(pg.exec("INSERT INTO public.suggestion_log (symbol, predicted_prob) VALUES ('BAD', 1.2);"));
    const { rows } = await pg.query<{ symbol: string; predicted_prob: string | null }>('SELECT symbol, predicted_prob FROM public.suggestion_log ORDER BY id');
    assert.deepEqual(rows.map(r => [r.symbol, r.predicted_prob == null ? null : Number(r.predicted_prob)]), [['OLD', null], ['NEW', 0.4167]]);
  } finally {
    await pg.close();
  }
});
