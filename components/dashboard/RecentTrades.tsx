'use client';

import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency, formatPercent, formatDate } from '@/lib/utils';
import type { Trade } from '@/types';
import { ArrowRight } from 'lucide-react';

interface RecentTradesProps {
  trades: Trade[];
  loading?: boolean;
}

export function RecentTrades({ trades, loading }: RecentTradesProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-sm font-semibold">Recent Trades</CardTitle>
        <Link
          href="/trades"
          className="text-xs text-primary hover:underline flex items-center gap-1"
        >
          View all <ArrowRight className="w-3 h-3" />
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="px-5 space-y-3 pb-4">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : trades.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            No trades yet
          </div>
        ) : (
          <div className="divide-y divide-border">
            {trades.slice(0, 8).map(trade => {
              const pnlPositive = (trade.pnl ?? 0) >= 0;
              const isOpen = trade.status === 'open';
              return (
                <div key={trade.id} className="px-5 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge variant={trade.side === 'long' ? 'long' : 'short'} className="w-12 justify-center flex-shrink-0">
                      {trade.side === 'long' ? 'LONG' : 'SHORT'}
                    </Badge>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{trade.symbol}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(trade.entry_time)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {isOpen ? (
                      <Badge variant="open">OPEN</Badge>
                    ) : (
                      <div className="text-right">
                        <p className={`text-sm font-bold tabular-nums ${pnlPositive ? 'text-profit' : 'text-loss'}`}>
                          {formatCurrency(trade.pnl ?? 0)}
                        </p>
                        <p className={`text-xs tabular-nums ${pnlPositive ? 'text-profit' : 'text-loss'}`}>
                          {formatPercent(trade.pnl_percentage ?? 0)}
                        </p>
                      </div>
                    )}
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
