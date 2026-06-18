'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency, formatPercent, formatPrice } from '@/lib/utils';
import type { Position } from '@/types';
import { TrendingUp, TrendingDown, XCircle, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

export function ActivePositions() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState<string | null>(null);

  const fetchPositions = useCallback(async () => {
    try {
      const res = await fetch('/api/positions');
      const data = await res.json();
      setPositions(data.positions ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPositions();
    const interval = setInterval(fetchPositions, 15000);
    return () => clearInterval(interval);
  }, [fetchPositions]);

  async function handleClose(symbol: string) {
    // Find the open trade for this symbol and close it
    setClosing(symbol);
    try {
      const tradesRes = await fetch(`/api/trades?status=open&symbol=${symbol}`);
      const tradesData = await tradesRes.json();
      const trade = tradesData.trades?.[0];

      if (!trade) {
        toast.error(`No open trade record found for ${symbol}`);
        return;
      }

      const res = await fetch(`/api/trades/${trade.id}`, { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error ?? 'Failed to close position');
        return;
      }

      toast.success(`${symbol} position closed at $${formatPrice(data.fillPrice)}`);
      await fetchPositions();
    } catch {
      toast.error('Failed to close position');
    } finally {
      setClosing(null);
    }
  }

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Active Positions</CardTitle>
        <Button variant="ghost" size="icon" onClick={fetchPositions} className="h-7 w-7">
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="px-5 space-y-3 pb-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : positions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <TrendingUp className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">No active positions</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {positions.map(pos => {
              const isLong = pos.side === 'long';
              const pnlPositive = pos.unrealizedPnl >= 0;
              return (
                <div key={pos.symbol} className="px-5 py-3.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 ${isLong ? 'bg-profit/10' : 'bg-loss/10'}`}>
                      {isLong
                        ? <TrendingUp className="w-4 h-4 text-profit" />
                        : <TrendingDown className="w-4 h-4 text-loss" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{pos.symbol}</span>
                        <Badge variant={isLong ? 'long' : 'short'} className="text-[10px] px-1.5 py-0">
                          {pos.side.toUpperCase()} {pos.leverage}x
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {pos.size} @ ${formatPrice(pos.entryPrice)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 flex-shrink-0">
                    <div className="text-right">
                      <p className={`text-sm font-bold tabular-nums ${pnlPositive ? 'text-profit' : 'text-loss'}`}>
                        {formatCurrency(pos.unrealizedPnl)}
                      </p>
                      <p className={`text-xs tabular-nums ${pnlPositive ? 'text-profit' : 'text-loss'}`}>
                        {formatPercent(pos.unrealizedPnlPercent)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-loss hover:bg-loss/10"
                      onClick={() => handleClose(pos.symbol)}
                      disabled={closing === pos.symbol}
                    >
                      {closing === pos.symbol
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <XCircle className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
