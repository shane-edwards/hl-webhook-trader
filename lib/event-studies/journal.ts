import type { createServiceClient } from '@/lib/supabase/server';

export type Database = ReturnType<typeof createServiceClient>;
export type Observation<T> = { day: string; checked_at: string; detail: T };
export const DAY = 86_400_000;
export const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

// The existing server-only journal enforces uniqueness on (strategy, day).
// Each leg or phase owns a distinct series, so retries preserve the first quote.
export async function record<T>(db: Database, series: string, day: string, time: number, detail: T) {
  const { error } = await db.from('forward_test_days').insert({
    strategy: series, day, checked_at: new Date(time).toISOString(), detail,
  });
  if (error && error.code !== '23505') throw new Error(error.message);
}

export async function observations<T>(db: Database, series: string, count: number): Promise<Observation<T>[]> {
  const { data, error } = await db.from('forward_test_days').select('day,checked_at,detail')
    .eq('strategy', series).order('day', { ascending: false }).limit(count);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function observation<T>(db: Database, series: string, day: string): Promise<Observation<T> | null> {
  const { data, error } = await db.from('forward_test_days').select('day,checked_at,detail')
    .eq('strategy', series).eq('day', day).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export interface StudyResult {
  date: string;
  label: string;
  net: number | null;
  control: number | null;
  benchmark?: number | null;
  note?: string;
}
export interface StudyCard {
  id: 'supplier' | 'unlock' | 'auction';
  name: string;
  status: string;
  rule: string;
  comparison: string;
  results: StudyResult[];
  sensitivity?: { label: string; value: number; detail: string };
  needsConnection?: boolean;
}
