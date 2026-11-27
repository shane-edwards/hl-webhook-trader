export const STOCK_SECTIONS = ['discover', 'setups', 'trade', 'autopilot', 'research', 'account'] as const;
export type StockSection = typeof STOCK_SECTIONS[number];

export function stockSection(value: string | null): StockSection {
  return STOCK_SECTIONS.find(section => section === value) ?? 'discover';
}

export function stockHref(section: StockSection, params?: Record<string, string>) {
  const query = new URLSearchParams(params);
  if (section !== 'discover') query.set('tab', section);
  const search = query.toString();
  return search ? `/stocks?${search}` : '/stocks';
}

export function isStocksPath(pathname: string) {
  return pathname === '/stocks' || pathname.startsWith('/stocks/');
}

export const cryptoSections = [
  { label: 'Trade', href: '/dashboard' },
  { label: 'Autopilot', href: '/autopilot' },
  { label: 'Markets', href: '/markets' },
  { label: 'Research', href: '/lab' },
  { label: 'Activity', href: '/trades' },
  { label: 'Settings', href: '/settings' },
];

export const stockSections = [
  { id: 'discover', label: 'Discover', title: 'Discover stocks' },
  { id: 'setups', label: 'Setups', title: 'Stock entry scanner' },
  { id: 'trade', label: 'Trade', title: 'Trade stocks' },
  { id: 'autopilot', label: 'Autopilot', title: 'Stock Autopilot' },
  { id: 'research', label: 'Research', title: 'Stock research' },
  { id: 'account', label: 'eToro', title: 'eToro account' },
] as const;

export const cryptoResearch = [
  { label: 'Strategy Lab', href: '/lab' },
  { label: 'Scalping', href: '/lab/scalping' },
  { label: 'Funding gaps', href: '/lab/funding' },
];

export const cryptoActivity = [
  { label: 'Trade history', href: '/trades' },
  { label: 'Analytics', href: '/analytics' },
];

export const stockResearch = [
  { label: 'Backtest', href: stockHref('research'), pathname: '/stocks' },
  { label: 'Catalysts', href: '/stocks/catalysts', pathname: '/stocks/catalysts' },
  { label: 'Scorecard', href: '/stocks/scorecard', pathname: '/stocks/scorecard' },
  { label: 'Portfolio replay', href: '/stocks/portfolio', pathname: '/stocks/portfolio' },
  { label: 'Execution journal', href: '/stocks/journal', pathname: '/stocks/journal' },
  { label: 'Intraday lab', href: '/stocks/lab', pathname: '/stocks/lab' },
  { label: 'Intraday', href: '/stocks/intraday', pathname: '/stocks/intraday' },
  { label: 'Opening volume', href: '/stocks/opening', pathname: '/stocks/opening' },
  { label: 'Earnings', href: '/stocks/factors', pathname: '/stocks/factors' },
];
