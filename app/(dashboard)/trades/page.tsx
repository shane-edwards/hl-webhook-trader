'use client';

import { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { TradesTable } from '@/components/trades/TradesTable';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Trade } from '@/types';
import { Search, Filter } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { toast } from 'sonner';

type FilterStatus = 'all' | 'open' | 'closed' | 'cancelled';

export default function TradesPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');

  const fetchTrades = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/trades?limit=500');
      const data = await res.json();
      setTrades(data.trades ?? []);
    } catch {
      toast.error('Failed to load trades');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchTrades(); }, [fetchTrades]);

  const filtered = trades.filter(t => {
    const matchSearch = !search || t.symbol.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || t.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const totalPnl = trades.filter(t => t.status === 'closed').reduce((a, t) => a + (t.pnl ?? 0), 0);
  const openCount = trades.filter(t => t.status === 'open').length;

  const statuses: { value: FilterStatus; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'Open' },
    { value: 'closed', label: 'Closed' },
    { value: 'cancelled', label: 'Cancelled' },
  ];

  return (
    <div className="flex flex-col min-h-full">
      <Header onRefresh={() => fetchTrades(true)} refreshing={refreshing} />

      <div className="p-4 lg:p-6 space-y-5 flex-1">
        {/* Summary bar */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="bg-card border border-border rounded-xl px-4 py-3">
            <p className="text-xs text-muted-foreground">Total P&L</p>
            <p className={`text-lg font-bold tabular-nums ${totalPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
              {formatCurrency(totalPnl)}
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl px-4 py-3">
            <p className="text-xs text-muted-foreground">Open Trades</p>
            <p className="text-lg font-bold text-primary">{openCount}</p>
          </div>
          <div className="bg-card border border-border rounded-xl px-4 py-3">
            <p className="text-xs text-muted-foreground">Total Trades</p>
            <p className="text-lg font-bold text-foreground">{trades.length}</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Filter by symbol..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Filter className="w-4 h-4 text-muted-foreground" />
            {statuses.map(s => (
              <Button
                key={s.value}
                variant={statusFilter === s.value ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStatusFilter(s.value)}
                className="h-8 text-xs"
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Results count */}
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">{filtered.length} trades</p>
          {(search || statusFilter !== 'all') && (
            <Badge variant="secondary" className="text-xs">Filtered</Badge>
          )}
        </div>

        <TradesTable trades={filtered} loading={loading} onRefresh={() => fetchTrades()} />
      </div>
    </div>
  );
}
