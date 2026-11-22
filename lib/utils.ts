import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, formatDistanceToNow, parseISO } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number, decimals = 2): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

export function formatPercent(value: number, decimals = 2): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatPrice(value: number): string {
  if (value >= 1000) {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

export function formatSize(value: number, symbol: string): string {
  if (value < 0.001) return `${value.toFixed(6)} ${symbol}`;
  if (value < 1) return `${value.toFixed(4)} ${symbol}`;
  return `${value.toFixed(3)} ${symbol}`;
}

export function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'MMM d, yyyy HH:mm');
  } catch {
    return dateStr;
  }
}

export function formatRelativeTime(dateStr: string): string {
  try {
    return formatDistanceToNow(parseISO(dateStr), { addSuffix: true });
  } catch {
    return dateStr;
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function pnlColor(value: number): string {
  if (value > 0) return 'text-profit';
  if (value < 0) return 'text-loss';
  return 'text-muted-foreground';
}

export function pnlBgColor(value: number): string {
  if (value > 0) return 'bg-profit/10 text-profit border-profit/20';
  if (value < 0) return 'bg-loss/10 text-loss border-loss/20';
  return 'bg-muted text-muted-foreground';
}

export function sideColor(side: string): string {
  return side === 'long' ? 'text-profit' : 'text-loss';
}

export function sideBadgeClass(side: string): string {
  return side === 'long'
    ? 'bg-profit/10 text-profit border-profit/20'
    : 'bg-loss/10 text-loss border-loss/20';
}

export function truncateAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function generateWebhookSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // Web Crypto, not Math.random: this secret is the only thing guarding the webhook.
  // Rejection sampling keeps the distribution uniform (256 is not a multiple of 62).
  const limit = 256 - (256 % chars.length);
  let out = '';
  while (out.length < 32) {
    for (const byte of crypto.getRandomValues(new Uint8Array(48))) {
      if (byte < limit && out.length < 32) out += chars[byte % chars.length];
    }
  }
  return out;
}
