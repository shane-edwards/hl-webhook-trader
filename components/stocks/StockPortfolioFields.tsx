'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { StockPortfolio } from '@/lib/stocks/portfolio';
import { STOCK_TRADE_RULES, STOCK_TRADE_SYMBOLS } from '@/lib/stocks/trade-rules';

const limits = [
  { key: 'maxExposure', label: 'Gross exposure (USD)', max: 1_000_000 },
  { key: 'maxGroup', label: 'Exposure per group (USD)', max: 1_000_000 },
  { key: 'maxPositions', label: 'Open instruments', max: 10 },
  { key: 'dailyLoss', label: 'Daily equity loss (USD)', max: 100_000 },
  { key: 'maxCostBps', label: 'Entry cost (bps of exposure)', max: 200 },
] as const;

export function StockPortfolioFields({ settings, onChange }: { settings: StockPortfolio; onChange: (value: StockPortfolio) => void }) {
  return <div className="sm:col-span-2 lg:col-span-3 space-y-3 rounded-lg border border-border p-3">
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Strategies</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">{STOCK_TRADE_RULES.map(rule =>
        <label key={rule.id} className="flex items-center gap-2">
          <input type="checkbox" checked={settings.strategies.includes(rule.id)} onChange={e => onChange({ ...settings,
            strategies: e.target.checked ? [...settings.strategies, rule.id] : settings.strategies.filter(id => id !== rule.id) })} />
          {rule.name}{rule.id === 'earnings-rebound' && ' (Experimental)'}
        </label>)}</div>
    </fieldset>
    <fieldset>
      <legend className="text-sm font-medium">Stocks</legend>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="text-xs text-muted-foreground">{settings.symbols.length} selected</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...settings, symbols: [...STOCK_TRADE_SYMBOLS] })}>Select all</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...settings, symbols: [] })}>Clear</Button>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-sm">{[...STOCK_TRADE_SYMBOLS].sort().map(ticker =>
        <label className="flex items-center gap-2" key={ticker}>
          <input type="checkbox" checked={settings.symbols.includes(ticker)} onChange={e => onChange({ ...settings,
            symbols: e.target.checked ? [...settings.symbols, ticker] : settings.symbols.filter(symbol => symbol !== ticker) })} />{ticker}
        </label>)}</div>
    </fieldset>
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
      {limits.map(({ key, label, max }) => <label key={key} className="text-sm">{label}
        <Input className="mt-1" type="number" min={1} max={max} required step={key === 'maxPositions' ? '1' : '0.01'}
          value={settings[key] || ''} onChange={e => onChange({ ...settings, [key]: Number(e.target.value) })} />
      </label>)}
    </div>
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">How portfolio limits work</summary>
      <p className="mt-2">The daily limit measures equity from the first usable US session check, including cash movements. Reaching it blocks entries for the rest of the session. Existing exit rules continue. Exposure includes other direct eToro holdings. Tideframe waits while pending orders or copy positions prevent a reliable exposure check.</p>
    </details>
  </div>;
}
