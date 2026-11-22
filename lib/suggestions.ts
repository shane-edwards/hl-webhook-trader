// Trade suggestions: what the built-in rules say about a market right now,
// combined into one read (long / short / no trade) with a suggested stop-loss
// and take-profit for each direction.
//
// This is a rule-based summary, not a forecast. Only rules that held up in
// testing count toward the direction; the others are shown but carry no vote.
import { computeIndicators, STRATEGIES, WARMUP_BARS, type Bar } from '@/lib/autopilot/strategies';
import evidence from '@/lib/autopilot/evidence.json';

export type Bias = 'long' | 'short' | 'neutral';

export interface Factor {
  label: string;
  /** +1/+2 supports a long, -1/-2 supports a short, 0 is neutral or not counted. */
  vote: number;
  detail: string;
  /** False for rules that failed testing: shown for information, never counted. */
  counted: boolean;
}

export interface Levels { stopLossPct: number; takeProfitPct: number; stopPrice: number; targetPrice: number }

export interface Suggestion {
  symbol: string;
  price: number;
  bias: Bias;
  /** Sum of counted votes, from about -7 to +7. */
  score: number;
  strength: 'strong' | 'moderate' | 'none';
  summary: string;
  factors: Factor[];
  /** Suggested protection for a trade in each direction, whichever side the user picks. */
  long: Levels;
  short: Levels;
  /** 24h average true range as a percent of price: the yardstick the levels are built from. */
  atrPct: number;
  /** True when there was not enough history for the trend rules, so only volatility-based levels are given. */
  limitedHistory: boolean;
}

/** Did this rule, in this direction mode, pass the backtest gate? */
const passedGate = (id: string, allowShort: boolean) =>
  evidence.strategies.some(e => e.id === id && e.allowShort === allowShort && e.gatePassed === true);

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Reward-to-risk used for the suggested target: the trade must win more than a third of the time to pay. */
export const TARGET_R = 2;
const MIN_STOP_PCT = 0.5, MAX_STOP_PCT = 12;

function levels(price: number, dir: 1 | -1, stopFraction: number): Levels {
  const stopLossPct = round(Math.min(MAX_STOP_PCT, Math.max(MIN_STOP_PCT, stopFraction * 100)), 1);
  const takeProfitPct = round(stopLossPct * TARGET_R, 1);
  return { stopLossPct, takeProfitPct, stopPrice: price * (1 - (dir * stopLossPct) / 100), targetPrice: price * (1 + (dir * takeProfitPct) / 100) };
}

/**
 * Builds the suggestion from completed hourly bars (oldest first) and the
 * current price. Needs WARMUP_BARS of history for the trend rules; with less,
 * it still returns volatility-based levels and a neutral read.
 */
export function buildSuggestion(symbol: string, bars: Bar[], price: number): Suggestion {
  const i = bars.length - 1;
  const ind = computeIndicators(bars);
  const atr = Number.isFinite(ind.atrPct[i]) ? ind.atrPct[i] : 0.01;
  const limitedHistory = bars.length < WARMUP_BARS;
  const factors: Factor[] = [];

  // Stop distance each side: the middle of what the rules that would take that side use,
  // and never tighter than the nearest 24-hour extreme, where an ordinary pullback would reach.
  const stops: Record<'long' | 'short', number[]> = { long: [2.5 * atr], short: [2.5 * atr] };

  if (!limitedHistory) {
    const up30 = ind.close[i] > ind.emaSlow[i];
    factors.push({ label: '30-day trend', vote: up30 ? 1 : -1, counted: true, detail: `Price is ${up30 ? 'above' : 'below'} its 30-day average` });
    const h = ind.h4;
    if (Number.isFinite(h.ema200[i])) {
      const up4 = h.close[i] > h.ema200[i];
      factors.push({ label: '4-hour trend', vote: up4 ? 1 : -1, counted: true, detail: `4-hour close is ${up4 ? 'above' : 'below'} its 200-period average` });
      const m = h.macd[i] > h.signal[i];
      factors.push({ label: 'MACD (4-hour)', vote: m ? 1 : -1, counted: true, detail: `MACD is ${m ? 'above' : 'below'} its signal line` });
    }
    for (const s of STRATEGIES) {
      // A fresh entry from flat is the strongest statement a rule makes.
      const sig = s.evaluate(ind, bars, i, 0, true);
      // A sell signal only counts if the rule's long-and-short version passed testing.
      const counted = sig.target === -1 ? passedGate(s.id, true) : passedGate(s.id, false) || passedGate(s.id, true);
      if (sig.target !== 0) {
        factors.push({ label: s.name, vote: counted ? 2 * sig.target : 0, counted, detail: `${sig.target === 1 ? 'Buy' : 'Sell'} signal now: ${sig.reason}${counted ? '' : ' (this rule did not hold up in testing, so it is not counted)'}` });
        if (counted) stops[sig.target === 1 ? 'long' : 'short'].push(sig.stopPct);
      } else if (counted) {
        // Would the rule currently be holding a position? That shows which side it is on.
        const holdLong = s.evaluate(ind, bars, i, 1, true).target === 1, holdShort = s.evaluate(ind, bars, i, -1, true).target === -1;
        if (holdLong !== holdShort) factors.push({ label: s.name, vote: 0, counted: true, detail: `No new signal; an existing ${holdLong ? 'long' : 'short'} would still be held` });
        else factors.push({ label: s.name, vote: 0, counted: true, detail: 'No signal' });
      }
    }
  }

  const structure = (dir: 1 | -1) => {
    const ref = dir === 1 ? ind.low24[i] : ind.high24[i];
    return Number.isFinite(ref) ? Math.abs(price - ref) / price + 0.25 * atr : 0;
  };
  const long = levels(price, 1, Math.max(median(stops.long), Math.min(structure(1), 4 * atr)));
  const short = levels(price, -1, Math.max(median(stops.short), Math.min(structure(-1), 4 * atr)));

  const score = factors.reduce((a, f) => a + (f.counted ? f.vote : 0), 0);
  const bias: Bias = score >= 2 ? 'long' : score <= -2 ? 'short' : 'neutral';
  const strength = Math.abs(score) >= 4 ? 'strong' : Math.abs(score) >= 2 ? 'moderate' : 'none';
  const entries = factors.filter(f => f.counted && Math.abs(f.vote) === 2).length;
  const summary = limitedHistory
    ? 'Not enough price history for the trend rules. Stop and target are sized from recent volatility only.'
    : bias === 'neutral'
      ? 'The rules disagree or see no trend. No trade is suggested; if you trade anyway, keep the size small.'
      : `${strength === 'strong' ? 'Strong' : 'Moderate'} ${bias} read: ${entries ? `${entries} tested rule${entries > 1 ? 's' : ''} signalling an entry now, ` : 'no fresh entry signal, but '}the trend measures lean ${bias}.`;

  return { symbol, price, bias, score, strength, summary, factors, long, short, atrPct: round(atr * 100, 2), limitedHistory };
}
