type RiskInput = {
  ask: number; bid: number; stop: number; leverage: number; budget: number; gapPct: number; slippageBps: number;
  minimumAmount: number; maxAmount: number; roundTripFeesUsd: number;
};

export function sizeStockRisk(input: RiskInput) {
  const { ask, bid, stop, leverage, budget, gapPct, slippageBps, minimumAmount, maxAmount, roundTripFeesUsd } = input;
  if (!Object.values(input).every(Number.isFinite) || !(ask >= bid && bid > stop && stop > 0) || leverage < 1 ||
      budget <= 0 || gapPct < 0 || gapPct >= 100 || slippageBps < 0 || minimumAmount < 0 || maxAmount <= 0 || roundTripFeesUsd < 0) return null;
  const slip = slippageBps / 10_000;
  const modeledEntry = ask * (1 + slip);
  const modeledStop = stop * (1 - slip);
  const modeledGap = modeledStop * (1 - gapPct / 100);
  const stressPerDollar = leverage * (1 - modeledGap / modeledEntry);
  const amount = Math.floor(Math.min(maxAmount, (budget - roundTripFeesUsd) / stressPerDollar) * 100 + 1e-8) / 100;
  if (amount <= 0 || amount + 1e-8 < minimumAmount) return null;
  const exposure = amount * leverage;
  const units = exposure / modeledEntry;
  return { amount, exposure, stop, modeledGap, lossAtStop: units * (modeledEntry - modeledStop) + roundTripFeesUsd,
    gapLoss: units * (modeledEntry - modeledGap) + roundTripFeesUsd };
}
