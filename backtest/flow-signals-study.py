"""Pre-registered study: US spot Bitcoin ETF flows and Hyperliquid liquidations as daily signals.

Run from the repo root:  python -B backtest/flow-signals-study.py
Reads only cached files. Writes backtest/flow-signals-results.json. Deterministic (no randomness).

Conventions (all fixed before any result was seen):
- pos[d] is the position held from the 00:00 UTC open of calendar day d to the open of day d+1.
- Day return of the perp = open[d+1] / open[d] - 1 (the final cached day uses its close).
- Funding for day d = Binance funding stamps at 08:00 and 16:00 of d and 00:00 of d+1. Long pays a positive rate.
- Cost per side is charged on every unit of position change; a flip costs two sides.
- 1x notional, rebalanced daily, no stops. Daily returns are compounded.
- A trade is one unbroken run of days with the same non-zero position. Runs are cut at window edges.
"""
import glob
import json
import math
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data", "intraday")
OUT = os.path.join(HERE, "flow-signals-results.json")
COSTS = {"base": 0.0010, "stressed": 0.0020}
COINS = ["BTC", "ETH", "SOL"]
PRICE_END = pd.Timestamp("2026-10-31")
LIQ_WINDOWS = {"discovery": ("2025-05-01", "2025-12-31"), "holdout": ("2026-01-01", "2026-10-31")}


# ---------- loaders ----------
def load_prices(coin):
    frames = []
    for f in sorted(glob.glob(os.path.join(DATA, "crypto-swing", "prices", f"{coin}USDT-1d-*.csv"))):
        with open(f) as fh:
            lines = [x for x in fh.read().splitlines() if x and x[0].isdigit()]
        for x in lines:
            p = x.split(",")
            frames.append((int(p[0]), float(p[1]), float(p[4])))
    df = pd.DataFrame(frames, columns=["ts", "open", "close"]).drop_duplicates("ts").sort_values("ts")
    df.index = pd.to_datetime(df.ts, unit="ms").dt.normalize()
    return df[["open", "close"]]


def load_funding(coin):
    rows = []
    for f in sorted(glob.glob(os.path.join(DATA, "crypto-swing", "funding", f"{coin}USDT-fundingRate-*.csv"))):
        with open(f) as fh:
            for x in fh.read().splitlines():
                if x and x[0].isdigit():
                    p = x.split(",")
                    rows.append((int(p[0]), float(p[2])))
    df = pd.DataFrame(rows, columns=["ts", "rate"]).drop_duplicates("ts")
    # a stamp at 00:00 of d+1 belongs to the position held during day d
    day = (pd.to_datetime(df.ts, unit="ms") - pd.Timedelta(minutes=30)).dt.normalize()
    return df.groupby(day.values).rate.sum()


def market(coin):
    px = load_prices(coin)
    idx = pd.date_range(px.index.min(), px.index.max(), freq="D")
    missing = len(idx.difference(px.index))
    px = px.reindex(idx)
    nxt = px.open.shift(-1)
    ret = nxt.fillna(px.close) / px.open - 1
    fund = load_funding(coin).reindex(idx)
    fund_missing = int(fund.loc["2024-01-01":].isna().sum())
    return pd.DataFrame({"ret": ret, "fund": fund.fillna(0.0)}), {"price_days_missing": int(missing),
                                                                  "funding_days_missing_since_2024": fund_missing,
                                                                  "first": str(idx[0].date()), "last": str(idx[-1].date())}


def load_flows():
    with open(os.path.join(DATA, "crypto-flow", "btc-etf-flows.json")) as fh:
        raw = json.load(fh)
    days = raw["days"]
    s = pd.Series([d["netFlowUsd"] for d in days], index=pd.to_datetime([d["date"] for d in days]), dtype=float)
    meta = {"rows": len(days), "first": days[0]["date"], "last": days[-1]["date"],
            "fields": sorted(days[0].keys()), "units": raw.get("units"),
            "zero_flow_rows": int((s == 0).sum()), "null_flow_rows": int(s.isna().sum()),
            "weekday_counts": {str(k): int(v) for k, v in s.index.weekday.value_counts().sort_index().items()},
            "updatedThrough": raw.get("updatedThrough")}
    return s, meta


def load_liquidations():
    hourly = {c: [] for c in COINS}
    files = [f for f in sorted(glob.glob(os.path.join(DATA, "hyperliquid-liquidations", "*.json")))
             if not f.endswith("-15m.json")]
    for f in files:
        with open(f) as fh:
            d = json.load(fh)
        for c in COINS:
            hourly[c].extend(d[c])
    out, meta = {}, {"files": len(files)}
    for c in COINS:
        h = pd.DataFrame(hourly[c], columns=["ts", "o", "h", "l", "c", "v", "funding", "colA", "colB"])
        h.index = pd.to_datetime(h.ts, unit="ms")
        r = h.c / h.o - 1
        counts = h.o.resample("D").count()
        daily = h[["colA", "colB"]].resample("D").sum()
        daily = daily[counts == 24]  # drop partial days (only the first one)
        # Side check: uses only the same-hour price move, never a forward return.
        meta[c] = {"hourly_rows": len(h), "first_hour": str(h.index[0]), "last_hour": str(h.index[-1]),
                   "full_days": len(daily), "partial_days_dropped": int((counts < 24).sum()),
                   "colA_total_usd": float(h.colA.sum()), "colB_total_usd": float(h.colB.sum()),
                   "colA_share_in_falling_hours": float(h.colA[r < 0].sum() / h.colA.sum()),
                   "colB_share_in_rising_hours": float(h.colB[r > 0].sum() / h.colB.sum())}
        out[c] = daily.rename(columns={"colA": "long_liq", "colB": "short_liq"})
    return out, meta


# ---------- signals ----------
def asof_calendar(series, idx, lag_days):
    """Value of a flow-date series usable on calendar day t: latest flow date D with D + lag_days <= t."""
    shifted = series.copy()
    shifted.index = shifted.index + pd.Timedelta(days=lag_days)
    return shifted.reindex(idx.union(shifted.index)).ffill().reindex(idx)


def etf_trend(flows, idx, lag):
    s5 = flows.rolling(5).sum()
    v = asof_calendar(s5, idx, lag)
    return (v > 0).astype(float).where(v.notna(), 0.0), v.first_valid_index()


def etf_shock(flows, idx, lag, hold=5):
    vals = flows.values
    sig = pd.Series(0, index=flows.index)
    first = None
    for i in range(120, len(vals)):
        hist = vals[i - 120:i]
        hi, lo = np.percentile(hist, 90), np.percentile(hist, 10)
        if first is None:
            first = flows.index[i]
        if vals[i] > hi:
            sig.iloc[i] = 1
        elif vals[i] < lo:
            sig.iloc[i] = -1
    pos = pd.Series(0.0, index=idx)
    cur, until = 0.0, None
    events = {d + pd.Timedelta(days=lag): s for d, s in sig.items() if s != 0}
    for t in idx:
        if until is not None and t >= until:
            cur, until = 0.0, None
        if t in events:
            cur, until = float(events[t]), t + pd.Timedelta(days=hold)
        pos[t] = cur
    return pos, first + pd.Timedelta(days=lag), int((sig == 1).sum()), int((sig == -1).sum())


def liq_position(daily_series, idx, direction, hold=3, lookback=60, pct=95):
    vals = daily_series.values
    days = daily_series.index
    pos = pd.Series(0.0, index=idx)
    first, n_sig = None, 0
    until = None
    ev = set()
    for i in range(lookback, len(vals)):
        if (days[i] - days[i - lookback]).days != lookback:
            continue  # require 60 consecutive full days
        if first is None:
            first = days[i] + pd.Timedelta(days=1)
        if vals[i] > np.percentile(vals[i - lookback:i], pct):
            ev.add(days[i] + pd.Timedelta(days=1))
            n_sig += 1
    for t in idx:
        if until is not None and t >= until:
            until = None
        if t in ev:
            until = t + pd.Timedelta(days=hold)
        pos[t] = direction if until is not None else 0.0
    return pos, first, n_sig


# ---------- accounting ----------
def run_leg(pos, mkt, start, end, cost):
    """Daily net returns and trade list for one coin inside [start, end]; flat outside."""
    p = pos.loc[start:end]
    m = mkt.loc[start:end]
    gross = p * m.ret - p * m.fund
    prev = p.shift(1).fillna(0.0)
    nxt = p.shift(-1).fillna(0.0)
    # entry cost on the first day of a run, exit cost on its last day
    entry = ((p != 0) & (p != prev)).astype(float) * p.abs()
    exit_ = ((p != 0) & (p != nxt)).astype(float) * p.abs()
    net = gross - cost * (entry + exit_)
    trades, acc, live = [], 1.0, False
    for t in p.index:
        if p[t] != 0:
            acc *= 1 + net[t]
            live = True
            if exit_[t] > 0:
                trades.append(acc - 1)
                acc, live = 1.0, False
    assert not live
    return net, trades, p


def summarise(daily, trades, exposure):
    n = len(daily)
    eq = (1 + daily).cumprod()
    total = float(eq.iloc[-1] - 1)
    ann = float((1 + total) ** (365.0 / n) - 1) if total > -1 else -1.0
    sd = float(daily.std(ddof=1))
    sharpe = float(daily.mean() / sd * math.sqrt(365)) if sd > 0 else None
    dd = float((eq / eq.cummax().clip(lower=1.0) - 1).min())
    out = {"days": n, "exposure": float(exposure), "total_return": total, "annualised_return": ann,
           "sharpe": sharpe, "max_drawdown": dd}
    if trades is not None:
        k = len(trades)
        mean = float(np.mean(trades)) if k else None
        t = None
        if k >= 2:
            s = float(np.std(trades, ddof=1))
            t = float(mean / (s / math.sqrt(k))) if s > 0 else None
        out.update({"trades": k, "mean_trade_return": mean, "trade_t_stat": t})
    return out


def buy_hold(mkt, start, end, cost, fraction=1.0):
    pos = pd.Series(fraction, index=mkt.loc[start:end].index)
    net, _, _ = run_leg(pos, mkt, start, end, cost)
    return net


def bench_summary(daily, frac=1.0):
    s = summarise(daily, None, frac)
    return s


# ---------- study ----------
def main():
    mk, price_meta = {}, {}
    for c in COINS:
        mk[c], price_meta[c] = market(c)
    flows, flow_meta = load_flows()
    liq, liq_meta = load_liquidations()
    results = {"spec": {"costs_per_side": COSTS, "note": "see module docstring for conventions"},
               "data": {"etf_flows": flow_meta, "liquidations": liq_meta, "prices": price_meta},
               "etf": {}, "liquidations": {}, "verdicts": {}}

    # ----- ETF variants on BTC -----
    btc = mk["BTC"]
    first_trade_day = flows.index[0] + pd.Timedelta(days=1)
    span = (PRICE_END - first_trade_day).days + 1
    half = span // 2
    etf_windows = {"discovery": (first_trade_day, first_trade_day + pd.Timedelta(days=half - 1)),
                   "holdout": (first_trade_day + pd.Timedelta(days=half), PRICE_END)}
    idx = pd.date_range(first_trade_day, PRICE_END, freq="D")
    usable_flows = flows.loc[:PRICE_END]
    results["etf"]["windows_nominal"] = {k: [str(a.date()), str(b.date())] for k, (a, b) in etf_windows.items()}
    results["etf"]["flow_rows_used"] = int(len(usable_flows))
    results["etf"]["flow_rows_after_price_end_unused"] = int(len(flows) - len(usable_flows))

    for lag, lag_name in ((1, "D+1"), (2, "D+2")):
        trend, trend_first = etf_trend(usable_flows, idx, lag)
        shock, shock_first, n_hi, n_lo = etf_shock(usable_flows, idx, lag)
        variants = {"etf_flow_trend": (trend, trend_first),
                    "etf_flow_shock_follow": (shock, shock_first),
                    "etf_flow_shock_fade": (-shock, shock_first)}
        results["etf"].setdefault("shock_signal_counts", {})[lag_name] = {"above_p90": n_hi, "below_p10": n_lo}
        for name, (pos, first) in variants.items():
            for wname, (ws, we) in etf_windows.items():
                start = max(ws, first)
                for cname, cost in COSTS.items():
                    net, trades, p = run_leg(pos, btc, start, we, cost)
                    exposure = float(p.abs().mean())
                    row = summarise(net, trades, exposure)
                    row["window"] = [str(start.date()), str(we.date())]
                    row["days_in_market"] = int((p != 0).sum())
                    row["long_days"] = int((p > 0).sum())
                    row["short_days"] = int((p < 0).sum())
                    row["benchmark_buy_hold"] = bench_summary(buy_hold(btc, start, we, cost))
                    if name == "etf_flow_trend":
                        row["benchmark_exposure_matched"] = bench_summary(
                            buy_hold(btc, start, we, cost, exposure), exposure)
                    results["etf"].setdefault(name, {}).setdefault(lag_name, {}).setdefault(wname, {})[cname] = row

    # ----- Liquidation variants on BTC, ETH, SOL -----
    lidx = pd.date_range("2025-05-01", PRICE_END, freq="D")
    for name, col, direction in (("liq_long_flush_rebound", "long_liq", 1.0),
                                 ("liq_short_squeeze_fade", "short_liq", -1.0)):
        legs, firsts, nsig = {}, [], {}
        for c in COINS:
            legs[c], f, nsig[c] = liq_position(liq[c][col], lidx, direction)
            firsts.append(f)
        first = max(firsts)
        results["liquidations"].setdefault("signal_counts", {})[name] = nsig
        for wname, (ws, we) in LIQ_WINDOWS.items():
            start, end = max(pd.Timestamp(ws), first), pd.Timestamp(we)
            for cname, cost in COSTS.items():
                nets, trades, expo, per_coin, bh = [], [], [], {}, []
                for c in COINS:
                    net, tr, p = run_leg(legs[c], mk[c], start, end, cost)
                    nets.append(net)
                    trades.extend(tr)
                    expo.append(p.abs().mean())
                    per_coin[c] = summarise(net, tr, p.abs().mean())
                    bh.append(buy_hold(mk[c], start, end, cost))
                port = pd.concat(nets, axis=1).mean(axis=1)
                row = summarise(port, trades, float(np.mean(expo)))
                row["window"] = [str(start.date()), str(end.date())]
                row["per_coin"] = per_coin
                row["benchmark_buy_hold_equal_weight_long"] = bench_summary(pd.concat(bh, axis=1).mean(axis=1))
                results["liquidations"].setdefault(name, {}).setdefault(wname, {})[cname] = row

    # ----- verdicts (rule fixed in advance) -----
    def verdict(disc, hold, trend=False):
        reasons = []
        pos_both = disc["total_return"] > 0 and hold["total_return"] > 0
        if not pos_both:
            reasons.append("not positive in both windows at stressed cost")
        t = hold.get("trade_t_stat")
        if t is None or t < 2:
            reasons.append("holdout trade t-stat below 2")
        if trend:
            beats = all(w["total_return"] > w["benchmark_exposure_matched"]["total_return"] for w in (disc, hold))
            if not beats:
                reasons.append("does not beat exposure-matched buy and hold in both windows")
            return ("pass" if not reasons else "fail"), reasons
        if hold["trades"] < 20:
            return "too few to judge", [f"only {hold['trades']} holdout trades"] + reasons
        return ("pass" if not reasons else "fail"), reasons

    for name in ("etf_flow_trend", "etf_flow_shock_follow", "etf_flow_shock_fade"):
        for lag_name in ("D+1", "D+2"):
            r = results["etf"][name][lag_name]
            v, why = verdict(r["discovery"]["stressed"], r["holdout"]["stressed"], trend=(name == "etf_flow_trend"))
            results["verdicts"].setdefault(name, {})[lag_name] = {"verdict": v, "reasons": why}
        results["verdicts"][name]["final"] = results["verdicts"][name]["D+1"]["verdict"]
    for name in ("liq_long_flush_rebound", "liq_short_squeeze_fade"):
        r = results["liquidations"][name]
        v, why = verdict(r["discovery"]["stressed"], r["holdout"]["stressed"])
        results["verdicts"][name] = {"final": v, "reasons": why}

    with open(OUT, "w") as fh:
        json.dump(results, fh, indent=1, sort_keys=True)

    # ----- console summary -----
    def line(tag, r, bench):
        mt = r.get("mean_trade_return")
        print(f"{tag:58s} n={r.get('trades')!s:>4} exp={r['exposure']:.2f} tot={r['total_return']*100:8.2f}% "
              f"ann={r['annualised_return']*100:8.2f}% sh={r['sharpe'] if r['sharpe'] is None else round(r['sharpe'],2)!s:>6} "
              f"dd={r['max_drawdown']*100:7.2f}% mean={'' if mt is None else round(mt*1e4,1)!s:>7}bps "
              f"t={'' if r.get('trade_t_stat') is None else round(r['trade_t_stat'],2)!s:>6} | bh={bench*100:8.2f}%")
    print("ETF windows", results["etf"]["windows_nominal"])
    for name in ("etf_flow_trend", "etf_flow_shock_follow", "etf_flow_shock_fade"):
        for lag_name in ("D+1", "D+2"):
            for w in ("discovery", "holdout"):
                for c in COSTS:
                    r = results["etf"][name][lag_name][w][c]
                    line(f"{name} {lag_name} {w} {c} {r['window'][0]}", r, r["benchmark_buy_hold"]["total_return"])
                    if "benchmark_exposure_matched" in r:
                        print(f"{'':58s} exposure-matched bh tot={r['benchmark_exposure_matched']['total_return']*100:.2f}%")
    for name in ("liq_long_flush_rebound", "liq_short_squeeze_fade"):
        for w in ("discovery", "holdout"):
            for c in COSTS:
                r = results["liquidations"][name][w][c]
                line(f"{name} {w} {c} {r['window'][0]}", r, r["benchmark_buy_hold_equal_weight_long"]["total_return"])
    print(json.dumps(results["verdicts"], indent=1))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
