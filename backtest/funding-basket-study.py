"""Pre-registered cross-sectional funding carry study on 16 Binance USD-M perpetuals.

Run from the repo root:  python -B backtest/funding-basket-study.py
Uses only the local cache. Never downloads. Deterministic. Writes funding-basket-results.json.

Fixed specification (set before any result was seen):
  Weekly rebalance at Monday's daily open (UTC). Rank coins by trailing mean daily funding
  over the lookback ending the previous day. Short the top quartile, long the bottom quartile,
  equal weight inside each side, 50% of capital per side. Hold one week.
  Variants: carry_7d, carry_30d, carry_7d_btc_hedged_short_only, placebo_random (seed 7, 200 runs).
  Costs on traded notional: 0.10% per side (base), 0.20% per side (stressed).
"""
import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "data" / "intraday"
OUT = ROOT / "funding-basket-results.json"

COINS = ["AAVE", "ADA", "ATOM", "AVAX", "BCH", "BNB", "BTC", "DOGE",
         "ETC", "ETH", "LINK", "LTC", "SOL", "TRX", "XLM", "XRP"]
CALENDAR = pd.date_range("2021-01-01", "2026-10-31")
WINDOWS = {
    "discovery": ("2022-01-01", "2023-12-31"),
    "validation": ("2024-01-01", "2024-12-31"),
    "holdout": ("2025-01-01", "2026-10-31"),
}
COSTS = {"base": 0.0010, "stressed": 0.0020}
SEED = 7
PLACEBO_RUNS = 200
BOOT_DRAWS = 2000
BOOT_BLOCK = 20
YEAR = 365


def load_coin(ticker):
    folder = CACHE / "crypto-swing"

    def rows(kind, mid):
        names = [folder / kind / f"{ticker}USDT-{mid}-{month}.csv"
                 for month in pd.period_range("2021-01", "2026-10", freq="M")]
        missing = [f.name for f in names if not f.exists()]
        if missing:
            raise FileNotFoundError(f"Cache does not cover {missing[0]}; this study never downloads")
        lines = (line for f in names for line in f.read_text().splitlines() if line and line[0].isdigit())
        return pd.read_csv(io.StringIO("\n".join(lines)), header=None)

    p = rows("prices", "1d")[[0, 1, 4]]
    p.columns = ["timestamp", "open", "close"]
    p.index = pd.to_datetime(p.pop("timestamp"), unit="ms")
    patched = []
    for day in CALENDAR.difference(p.index):
        # Days absent from the monthly daily archive are rebuilt from cached hourly bars,
        # the same patch the folder's other daily crypto studies use.
        name = f"{ticker}USDT-1h-{day.strftime('%Y-%m-%d')}.zip"
        file = CACHE / "daily-price-action" / name
        if not file.exists():
            raise FileNotFoundError(f"Cache does not cover {name}; this study never downloads")
        with zipfile.ZipFile(file) as archive:
            lines = archive.read(name.replace(".zip", ".csv")).decode().splitlines()
        hours = pd.read_csv(io.StringIO("\n".join(x for x in lines if x[0].isdigit())), header=None)
        assert pd.to_datetime(hours[0], unit="ms").tolist() == list(pd.date_range(day, periods=24, freq="h"))
        p.loc[day] = [hours[1].iloc[0], hours[4].iloc[-1]]
        patched.append(day.strftime("%Y-%m-%d"))
    p = p.sort_index()
    assert p.index.equals(CALENDAR)

    f = rows("funding", "fundingRate")
    times = pd.to_datetime(f[0], unit="ms").dt.round("h")
    assert not times.duplicated().any() and times.is_monotonic_increasing
    assert times.diff().dropna().max() <= pd.Timedelta(hours=8)
    rate = pd.Series(f[2].to_numpy(float))
    # Signal: prints stamped inside calendar day d (00:00 up to 23:59). All known before d+1's open.
    signal = rate.groupby(times.dt.normalize().to_numpy()).sum().reindex(CALENDAR)
    # Accrual: a position opened at day d's open pays the prints after that open up to and
    # including the next midnight print.
    shifted = (times - pd.Timedelta(seconds=1)).dt.normalize().to_numpy()
    accrual = rate.groupby(shifted).sum().reindex(CALENDAR)
    # The first calendar day has no bucket for the 2020-12-31 side; the last day lacks the
    # 2026-11-01 00:00 print, which is not in the cache. Keep what is there.
    accrual = accrual.fillna(0.0)
    return p, signal, accrual, patched


def load_all():
    opens, closes, sig, acc, patched = {}, {}, {}, {}, {}
    for coin in COINS:
        p, s, a, pt = load_coin(coin)
        opens[coin], closes[coin], sig[coin], acc[coin] = p.open, p.close, s, a
        if pt:
            patched[coin] = pt
    opens, closes = pd.DataFrame(opens), pd.DataFrame(closes)
    ret = opens.shift(-1) / opens - 1          # open to next open
    ret.iloc[-1] = closes.iloc[-1] / opens.iloc[-1] - 1   # final day: no next open in cache
    return ret, pd.DataFrame(sig), pd.DataFrame(acc), patched


def quartile(n):
    return max(2, n // 4)


def carry_weights(score):
    """score: array per coin (nan = not eligible). Short highest, long lowest."""
    ok = np.flatnonzero(~np.isnan(score))
    if len(ok) < 4:
        return None
    k = quartile(len(ok))
    order = ok[np.argsort(-score[ok], kind="stable")]
    w = np.zeros(len(score))
    w[order[:k]] = -0.5 / k
    w[order[-k:]] = 0.5 / k
    return w


def hedged_weights(score):
    ok = np.flatnonzero(~np.isnan(score))
    btc = COINS.index("BTC")
    if len(ok) < 4 or np.isnan(score[btc]):
        return None
    k = quartile(len(ok))
    order = [i for i in ok[np.argsort(-score[ok], kind="stable")] if i != btc][:k]
    w = np.zeros(len(score))
    w[order] = -0.5 / k
    w[btc] = 0.5
    return w


def simulate(R, FA, score, days, weight_fn, cost, trade_weekday=0, signal_lag=1):
    """days: integer positions of the window in the calendar. score: per-day signal matrix.
    A rebalance on day d uses score[d - signal_lag], data that ended before d's open."""
    weekday = CALENDAR.dayofweek.to_numpy()
    n_coins = R.shape[1]
    equity, pos = 1.0, np.zeros(n_coins)
    target = np.zeros(n_coins)
    daily, price_pnl, fund_pnl, cost_pnl = [], 0.0, 0.0, 0.0
    turnovers, short_f, long_f, short_sig, long_sig = [], [], [], [], []
    for j, d in enumerate(days):
        start = equity
        if weekday[d] == trade_weekday:
            w = weight_fn(score[d - signal_lag])
            if w is not None:
                want = w * equity
                traded = np.abs(want - pos).sum()
                fee = cost * traded
                turnovers.append(traded / equity)
                equity -= fee
                cost_pnl -= fee
                pos, target = want, w
                s = score[d - signal_lag]
                short_sig.append(s[w < 0].mean())
                if (w > 0).any():
                    long_sig.append(s[w > 0].mean())
        pp = float(pos @ R[d])
        fp = float(-(pos @ FA[d]))     # short (negative notional) receives, long pays
        if (target < 0).any():
            short_f.append(FA[d][target < 0].mean())
        if (target > 0).any():
            long_f.append(FA[d][target > 0].mean())
        pos = pos * (1 + R[d])
        equity += pp + fp
        price_pnl += pp
        fund_pnl += fp
        if j == len(days) - 1:           # close everything at the window end and pay for it
            fee = cost * np.abs(pos).sum()
            equity -= fee
            cost_pnl -= fee
        daily.append(equity / start - 1)
    daily = np.array(daily)
    return {
        "daily": daily,
        "total_return": equity - 1,
        "price_pnl": price_pnl,
        "funding_pnl": fund_pnl,
        "cost_pnl": cost_pnl,
        "rebalances": len(turnovers),
        "avg_weekly_turnover": float(np.mean(turnovers[1:])) if len(turnovers) > 1 else None,
        "short_basket_funding_ann_pct": float(np.mean(short_f)) * YEAR * 100 if short_f else None,
        "long_basket_funding_ann_pct": float(np.mean(long_f)) * YEAR * 100 if long_f else None,
        "short_basket_signal_funding_ann_pct": float(np.mean(short_sig)) * YEAR * 100 if short_sig else None,
        "long_basket_signal_funding_ann_pct": float(np.mean(long_sig)) * YEAR * 100 if long_sig else None,
    }


def ann_return(daily):
    return float(np.prod(1 + daily) ** (YEAR / len(daily)) - 1)


def stats(run):
    d = run["daily"]
    curve = np.cumprod(1 + d)
    peak = np.maximum.accumulate(np.concatenate([[1.0], curve]))[1:]
    sd = d.std(ddof=1)
    out = {
        "total_return": float(run["total_return"]),
        "annualised_return": ann_return(d),
        "sharpe": float(d.mean() / sd * np.sqrt(YEAR)) if sd > 0 else None,
        "max_drawdown": float((curve / peak - 1).min()),
        "days": int(len(d)),
    }
    for key in ("rebalances", "avg_weekly_turnover", "price_pnl", "funding_pnl", "cost_pnl",
                "short_basket_funding_ann_pct", "long_basket_funding_ann_pct",
                "short_basket_signal_funding_ann_pct", "long_basket_signal_funding_ann_pct"):
        v = run[key]
        out[key] = None if v is None else (int(v) if key == "rebalances" else float(v))
    return out


def block_bootstrap(daily, rng):
    n, p = len(daily), 1.0 / BOOT_BLOCK
    out = np.empty(BOOT_DRAWS)
    for b in range(BOOT_DRAWS):
        idx = np.empty(n, dtype=np.int64)
        i = 0
        while i < n:
            start = rng.integers(n)
            length = min(rng.geometric(p), n - i)
            idx[i:i + length] = (start + np.arange(length)) % n
            i += length
        out[b] = ann_return(daily[idx])
    return {"p05": float(np.percentile(out, 5)), "median": float(np.percentile(out, 50)),
            "p95": float(np.percentile(out, 95)), "share_positive": float((out > 0).mean())}


def main():
    ret, sig, acc, patched = load_all()
    R, FA = ret.to_numpy(), acc.to_numpy()
    scores = {L: sig.rolling(L, min_periods=L).mean().to_numpy() for L in (7, 30)}
    # A coin is eligible only once it has a full lookback of funding and a price to trade at.
    for L in scores:
        scores[L][np.isnan(R)] = np.nan
    win_days = {name: np.flatnonzero((CALENDAR >= a) & (CALENDAR <= b)) for name, (a, b) in WINDOWS.items()}

    results = {
        "spec": {
            "coins": COINS, "windows": WINDOWS, "costs_per_side": COSTS,
            "rebalance": "weekly, Monday daily open UTC, signal ends the previous day",
            "quartile_rule": "floor(n/4), minimum 2; equal weight; 50% of capital per side",
            "placebo": {"seed": SEED, "runs": PLACEBO_RUNS},
            "bootstrap": {"type": "stationary block", "mean_block_days": BOOT_BLOCK, "draws": BOOT_DRAWS, "seed": SEED},
            "annualisation_days": YEAR,
            "window_handling": "each window starts flat, first trade on its first Monday, "
                               "all positions closed (and charged) on its last day",
            "turnover_definition": "sum of absolute weight changes / equity, averaged over rebalances "
                                   "after the initial entry",
            "pnl_split": "dollar P&L per 1.0 of starting capital; price + funding + costs = total return",
        },
        "data_notes": {"daily_bars_rebuilt_from_cached_hourly": patched,
                       "eligible_coins_first_discovery_rebalance": int((~np.isnan(scores[30][win_days["discovery"][2]])).sum())},
        "variants": {},
    }

    fixed = {
        "carry_7d": (scores[7], carry_weights),
        "carry_30d": (scores[30], carry_weights),
        "carry_7d_btc_hedged_short_only": (scores[7], hedged_weights),
    }
    runs = {}
    for name, (score, fn) in fixed.items():
        block = {}
        for win, days in win_days.items():
            block[win] = {}
            for cname, cost in COSTS.items():
                run = simulate(R, FA, score, days, fn, cost)
                runs[(name, win, cname)] = run
                block[win][cname] = stats(run)
        results["variants"][name] = {"results": block}

    # One extra day of delay: same signal, traded at Tuesday's open (t+2).
    for name in ("carry_7d", "carry_30d"):
        score, fn = fixed[name]
        block = {}
        for win, days in win_days.items():
            block[win] = {c: stats(simulate(R, FA, score, days, fn, cost, trade_weekday=1, signal_lag=2))
                          for c, cost in COSTS.items()}
        results["variants"][name]["extra_day_delay"] = block
        rng = np.random.default_rng(SEED)
        results["variants"][name]["holdout_stressed_bootstrap_annualised_return_90pct"] = block_bootstrap(
            runs[(name, "holdout", "stressed")]["daily"], rng)

    # Placebo: same construction as carry_7d, ranking replaced by a random permutation each week.
    placebo = {}
    keys = ("total_return", "annualised_return", "sharpe", "max_drawdown", "rebalances",
            "avg_weekly_turnover", "price_pnl", "funding_pnl", "cost_pnl")
    for win, days in win_days.items():
        placebo[win] = {}
        for cname, cost in COSTS.items():
            rows = []
            for i in range(PLACEBO_RUNS):
                rng = np.random.default_rng([SEED, i])   # same draws for both cost levels

                def random_fn(score_row, rng=rng):
                    fake = np.where(np.isnan(score_row), np.nan, rng.permutation(len(score_row)).astype(float))
                    return carry_weights(fake)

                rows.append(stats(simulate(R, FA, scores[7], days, random_fn, cost)))
            mean = {k: float(np.mean([r[k] for r in rows])) for k in keys}
            mean["rebalances"] = int(round(mean["rebalances"]))
            mean["days"] = rows[0]["days"]
            totals = np.array([r["total_return"] for r in rows])
            mean["total_return_p05"] = float(np.percentile(totals, 5))
            mean["total_return_p95"] = float(np.percentile(totals, 95))
            sharpes = np.array([r["sharpe"] for r in rows])
            mean["sharpe_p05"] = float(np.percentile(sharpes, 5))
            mean["sharpe_p95"] = float(np.percentile(sharpes, 95))
            placebo[win][cname] = mean
    results["variants"]["placebo_random"] = {"results": placebo,
                                             "note": "mean of 200 random runs; p05/p95 are across runs"}

    # Pass rule, fixed before any result: stressed total return > 0 in all three windows,
    # holdout stressed Sharpe >= 0.5, and holdout stressed total return above the placebo p95.
    bar = placebo["holdout"]["stressed"]["total_return_p95"]
    for name in fixed:
        res = results["variants"][name]["results"]
        a = all(res[w]["stressed"]["total_return"] > 0 for w in WINDOWS)
        b = (res["holdout"]["stressed"]["sharpe"] or 0) >= 0.5
        c = res["holdout"]["stressed"]["total_return"] > bar
        results["variants"][name]["pass_rule"] = {
            "stressed_positive_all_windows": bool(a), "holdout_stressed_sharpe_at_least_0_5": bool(b),
            "beats_placebo_p95_holdout": bool(c), "placebo_p95_holdout_stressed_total_return": bar,
            "passes": bool(a and b and c)}
    results["variants"]["placebo_random"]["pass_rule"] = {"passes": False, "note": "the null; not a candidate"}

    OUT.write_text(json.dumps(results, indent=2) + "\n")

    def pct(x):
        return "n/a" if x is None else f"{x * 100:+.1f}%"

    print("| Variant | Window | Costs | Total | Ann. | Sharpe | Max DD | Rebals | Turnover | Price | Funding | Costs |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for name, v in results["variants"].items():
        for win in WINDOWS:
            for cname in COSTS:
                r = v["results"][win][cname]
                print(f"| {name} | {win} | {cname} | {pct(r['total_return'])} | {pct(r['annualised_return'])} | "
                      f"{r['sharpe']:+.2f} | {pct(r['max_drawdown'])} | {r['rebalances']} | "
                      f"{r['avg_weekly_turnover'] * 100:.0f}% | {pct(r['price_pnl'])} | {pct(r['funding_pnl'])} | "
                      f"{pct(r['cost_pnl'])} |")
    print()
    for win in WINDOWS:
        for cname in COSTS:
            r = placebo[win][cname]
            print(f"placebo {win} {cname}: mean {pct(r['total_return'])} p05 {pct(r['total_return_p05'])} "
                  f"p95 {pct(r['total_return_p95'])} sharpe p05 {r['sharpe_p05']:+.2f} p95 {r['sharpe_p95']:+.2f}")
    print()
    for name in ("carry_7d", "carry_30d"):
        v = results["variants"][name]
        for win in WINDOWS:
            r, d = v["results"][win]["stressed"], v["extra_day_delay"][win]
            print(f"{name} {win}: short basket funding {r['short_basket_funding_ann_pct']:+.1f}%/yr "
                  f"(signal {r['short_basket_signal_funding_ann_pct']:+.1f}), long {r['long_basket_funding_ann_pct']:+.1f}%/yr "
                  f"(signal {r['long_basket_signal_funding_ann_pct']:+.1f}); delay base {pct(d['base']['total_return'])} "
                  f"sharpe {d['base']['sharpe']:+.2f}, stressed {pct(d['stressed']['total_return'])} "
                  f"sharpe {d['stressed']['sharpe']:+.2f}")
        b = v["holdout_stressed_bootstrap_annualised_return_90pct"]
        print(f"{name} bootstrap holdout stressed ann: {pct(b['p05'])} to {pct(b['p95'])}, median {pct(b['median'])}, "
              f"share positive {b['share_positive']:.2f}")
    print()
    for name, v in results["variants"].items():
        print(name, v["pass_rule"])
    print("data notes", results["data_notes"])


if __name__ == "__main__":
    main()
