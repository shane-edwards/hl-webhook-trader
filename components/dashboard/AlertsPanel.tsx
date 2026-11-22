'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff, ChevronDown } from 'lucide-react';
import { cn, formatRelativeTime } from '@/lib/utils';

interface Alert { id: string; message: string; delivered: string[]; created_at: string }
interface Data { channels: string[]; alerts: Alert[]; available: boolean }

const isUrgent = (m: string) => /ERROR|FAILED|HEALTH|WARNING|NOT placed|CLOSED AT ONCE|STILL OPEN|by hand/.test(m);

/** The app's own alert log. Shows what was sent, and says plainly when nothing can reach a phone yet. */
export function AlertsPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const load = () => fetch('/api/alerts').then(r => (r.ok ? r.json() : null)).then(d => d && setData(d)).catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [refreshKey]);

  if (!data) return null;
  const latest = data.alerts[0];
  const hasChannel = data.channels.length > 0;
  return (
    <section className="surface" aria-label="Alerts">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="flex w-full items-start gap-3 px-5 py-4 text-left">
        {hasChannel ? <Bell className="w-4 h-4 text-primary mt-0.5 shrink-0" /> : <BellOff className="w-4 h-4 text-warning mt-0.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Alerts</h2>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {!hasChannel && <span className="text-warning">Not reaching your phone: no channel is set up (see Settings). </span>}
            {latest ? `Latest, ${formatRelativeTime(latest.created_at)}: ${latest.message.split('\n')[0]}` : data.available ? 'Nothing yet.' : 'The alert log needs database migration 007.'}
          </p>
        </div>
        <ChevronDown className={cn('w-4 h-4 text-muted-foreground shrink-0 mt-0.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {data.alerts.length === 0 && <li className="px-5 py-4 text-sm text-muted-foreground">No alerts recorded.</li>}
          {data.alerts.map(a => (
            <li key={a.id} className="px-5 py-3">
              <p className={cn('text-xs whitespace-pre-wrap break-words', isUrgent(a.message) && 'text-warning')}>{a.message}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {formatRelativeTime(a.created_at)} · {a.delivered.length ? `sent to ${a.delivered.join(', ')}` : 'shown here only'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
