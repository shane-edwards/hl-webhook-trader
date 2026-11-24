import type { AutomationMarket } from '@/lib/automation/model';

export const JOURNEY_STEPS = ['find', 'test', 'trade'] as const;
export type JourneyStep = typeof JOURNEY_STEPS[number];

export function journeyHref(step: JourneyStep, market?: AutomationMarket, idea?: string) {
  const query = new URLSearchParams();
  if (market) query.set('market', market);
  if (idea) query.set('idea', idea);
  const search = query.toString();
  return `/journey/${step}${search ? `?${search}` : ''}`;
}

export function currentJourneyStep(path: string, tab: string | null): JourneyStep | null {
  if (path === '/tools' || path === '/settings' || path === '/stocks' && tab === 'account') return null;
  if (path === '/journey/test' || path.startsWith('/lab') || path.startsWith('/stocks/') && !path.endsWith('/catalysts') || path === '/stocks' && tab === 'research') return 'test';
  if (path === '/journey/find' || path === '/markets' || path === '/stocks/catalysts' || path === '/stocks' && (tab === 'setups' || !tab)) return 'find';
  return 'trade';
}
