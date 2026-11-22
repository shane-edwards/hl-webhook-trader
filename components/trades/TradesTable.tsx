'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency, formatPercent, formatDate, formatDuration, formatPrice } from '@/lib/utils';
import type { Trade } from '@/types';
import { XCircle, Loader2, ChevronUp, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { journalOf, netPnl, READ_LABEL, STOP_LABEL } from '@/lib/journal';

interface TradesTableProps {
  trades: Trade[];
  loading: boolean;
  onRefresh: () => void;
}

type SortField = 'entry_time' | 'symbol' | 'pnl' | 'pnl_percentage' | 'leverage' | 'size_usd';
type SortDir = 'asc' | 'desc';

export function TradesTable({ trades, loading, onRefresh }: TradesTableProps) {
  const [closing, setClosing] = useState<string | null>(null);
  const [confirmTrade, setConfirmTrade] = useState<Trade | null>(null);
  const [sort, setSort] = useState<{ field: SortField; dir: SortDir }>({ field: 'entry_time', dir: 'desc' });

  function handleSort(field: SortField) {
    setSort(prev => ({
      field,
      dir: prev.field === field && prev.dir === 'desc' ? 'asc' : 'desc',
    }));
  }

  const sorted = [...trades].sort((a, b) => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    if (sort.field === 'entry_time') {
      return dir * (new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime());
    }
    if (sort.field === 'symbol') return dir * a.symbol.localeCompare(b.symbol);
    const aVal = (a[sort.field] ?? 0) as number;
    const bVal = (b[sort.field] ?? 0) as number;
    return dir * (aVal - bVal);
  });

  async function handleClose() {
    if (!confirmTrade) return;
    setClosing(confirmTrade.id);
    setConfirmTrade(null);

    try {
      const res = await fetch(`/api/trades/${confirmTrade.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to close trade');
        return;
      }
      toast.success(`Trade closed at $${formatPrice(data.fillPrice)}`);
      onRefresh();
    } catch {
      toast.error('Failed to close trade');
    } finally {
      setClosing(null);
    }
  }

  // Plain render helpers rather than components declared inside this one, which React would re-create on every render.
  const sortIcon = (field: SortField) =>
    sort.field !== field ? <span className="w-3 h-3" /> : sort.dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  const th = (label: string, field?: SortField) => (
    <th
      key={label}
      className={`px-3 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap ${field ? 'cursor-pointer hover:text-foreground select-none' : ''}`}
      onClick={field ? () => handleSort(field) : undefined}
    >
      <span className="flex items-center gap-1">
        {label}
        {field && sortIcon(field)}
      </span>
    </th>
  );

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <p className="text-sm">No trades found</p>
        <p className="text-xs mt-1">Trades will appear here when your webhook signals are processed</p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full">
          <thead className="border-b border-border bg-secondary/50">
            <tr>
              {th('Date', 'entry_time')}
              {th('Asset', 'symbol')}
              {th('Side')}
              {th('Status')}
              {th('Entry')}
              {th('Exit')}
              {th('Size', 'size_usd')}
              {th('Lev.', 'leverage')}
              {th('Net P&L $', 'pnl')}
              {th('P&L %', 'pnl_percentage')}
              {th('Duration')}
              {th('Source')}
              {th('Action')}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map(trade => {
              const net = netPnl(trade);
              const pnlPos = net >= 0;
              const journal = journalOf(trade);
              const costs = trade.fills_synced_at
                ? `Price move ${formatCurrency(Number(trade.exchange_pnl ?? trade.pnl ?? 0))}, fees ${formatCurrency(-Number(trade.fees ?? 0))}, funding ${formatCurrency(-Number(trade.funding_paid ?? 0))} (from the exchange)`
                : 'Price move only: fees and funding not pulled from the exchange yet';
              const isOpen = trade.status === 'open';
              return (
                <tr key={trade.id} className="hover:bg-accent/30 transition-colors">
                  <td className="px-3 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {formatDate(trade.entry_time)}
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-sm font-semibold text-foreground">{trade.symbol}</span>
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant={trade.side === 'long' ? 'long' : 'short'}>
                      {trade.side.toUpperCase()}
                    </Badge>
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant={trade.status as 'open' | 'closed' | 'cancelled'}>
                      {trade.status.toUpperCase()}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-xs font-mono text-foreground">
                    ${formatPrice(trade.entry_price)}
                  </td>
                  <td className="px-3 py-3 text-xs font-mono text-muted-foreground">
                    {trade.exit_price ? `$${formatPrice(trade.exit_price)}` : '—'}
                  </td>
                  <td className="px-3 py-3 text-xs text-foreground">
                    {formatCurrency(trade.size_usd, 0)}
                  </td>
                  <td className="px-3 py-3 text-xs text-foreground">
                    {trade.leverage}x
                  </td>
                  <td className={`px-3 py-3 text-xs font-bold tabular-nums ${isOpen ? 'text-muted-foreground' : pnlPos ? 'text-profit' : 'text-loss'}`}>
                    {isOpen ? '—' : <span title={costs}>{formatCurrency(net)}{!trade.fills_synced_at && <span className="font-normal text-muted-foreground" aria-label="before fees and funding">*</span>}</span>}
                  </td>
                  <td className={`px-3 py-3 text-xs font-medium tabular-nums ${isOpen ? 'text-muted-foreground' : pnlPos ? 'text-profit' : 'text-loss'}`}>
                    {isOpen ? '—' : formatPercent(trade.pnl_percentage ?? 0)}
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {trade.duration_seconds ? formatDuration(trade.duration_seconds) : '—'}
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant="secondary" className="text-[10px]">
                      {trade.signal_source}
                    </Badge>
                    {journal && (
                      <p className="mt-1 text-[10px] text-muted-foreground whitespace-nowrap" title={journal.note ?? trade.notes ?? undefined}>
                        {READ_LABEL[journal.read]} · {STOP_LABEL[journal.stop].toLowerCase()}{journal.note ? ' · note' : ''}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {isOpen && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-loss hover:bg-loss/10"
                        onClick={() => setConfirmTrade(trade)}
                        disabled={closing === trade.id}
                      >
                        {closing === trade.id
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <><XCircle className="w-3.5 h-3.5 mr-1" />Close</>}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Confirm dialog */}
      <Dialog open={!!confirmTrade} onOpenChange={() => setConfirmTrade(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Close Position</DialogTitle>
            <DialogDescription>
              This will execute a market close order on Hyperliquid for your{' '}
              <strong>{confirmTrade?.symbol}</strong>{' '}
              <strong>{confirmTrade?.side}</strong> position. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTrade(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleClose}>Close Position</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
