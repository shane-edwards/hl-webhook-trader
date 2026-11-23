import { STOCK_INSTRUMENTS } from './trade-rules';

// Exact US listings and sector ETFs resolved through the broker's instrument search.
export const CATALYST_INSTRUMENTS: Record<string, number> = {
  ...STOCK_INSTRUMENTS, BAC: 1011, GS: 1467, CVX: 1014, COP: 1510, SLB: 4253, ORCL: 1135, CRM: 1839, ADP: 1648,
  INTC: 1021, QCOM: 1485, NFLX: 1127, DIS: 1016, HD: 1018, KO: 1024, PEP: 1043, PFE: 1028, MRK: 1027,
  UNP: 1492, UPS: 1493, MCD: 1025, GE: 1017, AMAT: 1706, XLK: 3021, XLC: 4427, XLY: 3024,
  XLP: 3022, XLF: 3004, XLV: 3017, XLE: 3008, XLI: 3019,
};

export const CATALYST_SECTORS = {
  XLK: ['Technology', { AAPL: 320193, MSFT: 789019, NVDA: 1045810, AMD: 2488, AVGO: 1730168, MU: 723125, PLTR: 1321655,
    ORCL: 1341439, CRM: 1108524, INTC: 50863, QCOM: 804328, AMAT: 6951 }],
  XLC: ['Communications', { GOOGL: 1652044, META: 1326801, NFLX: 1065280, DIS: 1744489 }],
  XLY: ['Consumer discretionary', { AMZN: 1018724, TSLA: 1318605, HD: 354950, MCD: 63908 }],
  XLP: ['Consumer staples', { WMT: 104169, COST: 909832, KO: 21344, PEP: 77476 }],
  XLF: ['Financials', { JPM: 19617, BAC: 70858, GS: 886982 }],
  XLV: ['Healthcare', { UNH: 731766, LLY: 59478, PFE: 78003, MRK: 310158 }],
  XLE: ['Energy', { XOM: 34088, CVX: 93410, COP: 1163165, SLB: 87347 }],
  XLI: ['Industrials', { BA: 12927, CAT: 18230, ADP: 8670, UNP: 100885, UPS: 1090727, GE: 40545 }],
} as const;

export const CATALYST_UNIVERSE = Object.entries(CATALYST_SECTORS)
  .flatMap(([etf, [sector, members]]) => Object.entries(members).map(([symbol, cik]) => ({ symbol, cik, etf, sector })));
export type CatalystMarket = typeof CATALYST_UNIVERSE[number];
