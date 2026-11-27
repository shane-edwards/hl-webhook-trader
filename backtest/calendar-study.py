"""Pre-registered calendar-effects study for BTC, ETH and SOL (hourly Binance spot candles).

Run from the repo root:  python -B backtest/calendar-study.py
Writes backtest/calendar-results.json and prints markdown tables to stdout.

Everything here is fixed in advance. Hours and weekdays for variants 1 to 4 are chosen
on the TRAIN window only and then frozen. No randomness is used.
"""
import json
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data", "intraday")
OUT = os.path.join(HERE, "calendar-results.json")

COINS = ["btc", "eth", "sol"]
WINDOWS = {
    "train": ("2020-07-01", "2022-12-31"),
    "validate": ("2023-01-01", "2024-12-31"),
    "holdout": ("2025-01-01", "2026-11-22"),
}
COSTS = {"zero": 0.0, "base": 0.0013, "stressed": 0.0026}  # per round trip
FUNDING_PER_8H = 0.0001  # charged to longs, credited to shorts, only for holds over 8 hours
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
HOUR_MS = 3600 * 1000


def load():
    opens = {}
    gaps = {}
    for c in COINS:
        df = pd.read_csv(os.path.join(DATA, f"{c}-1h-v.csv"), header=None,
                         names=["t", "o", "h", "l", "c", "v"])
        df = df.drop_duplicates("t").sort_values("t")
        bad = int((df["t"] % HOUR_MS != 0).sum())
        df = df[df["t"] % HOUR_MS == 0]
        s = pd.Series(df["o"].values, index=pd.to_datetime(df["t"].values, unit="ms"))
        full = pd.date_range(s.index[0], s.index[-1], freq="h")
        missing = full.difference(s.index)
        per_window = {}
        for w, (a, b) in WINDOWS.items():
            lo, hi = pd.Timestamp(a), pd.Timestamp(b) + pd.Timedelta(days=1)
            per_window[w] = int(((missing >= lo) & (missing < hi)).sum())
        gaps[c] = {
            "first_bar": str(s.index[0]), "last_bar": str(s.index[-1]),
            "bars_present": int(len(s)), "bars_expected": int(len(full)),
            "bars_missing": int(len(missing)), "missing_by_window": per_window,
            "off_grid_rows_dropped": bad,
            "non_positive_opens": int((s <= 0).sum()),
        }
        opens[c] = s
    start = min(s.index[0] for s in opens.values())
    end = max(s.index[-1] for s in opens.values())
    grid = pd.date_range(start, end, freq="h")
    O = pd.DataFrame({c: opens[c].reindex(grid) for c in COINS}, index=grid)
    return O, gaps, {c: opens[c].index[0] for c in COINS}


def wmask(idx, w):
    a, b = WINDOWS[w]
    return (idx >= pd.Timestamp(a)) & (idx < pd.Timestamp(b) + pd.Timedelta(days=1))


def mean_t(x):
    x = np.asarray(x, dtype=float)
    x = x[~np.isnan(x)]
    n = len(x)
    if n < 2:
        return n, None, None
    m = x.mean()
    sd = x.std(ddof=1)
    t = m / (sd / np.sqrt(n)) if sd > 0 else None
    return n, m, t


def r(x, d=4):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), d)


def spearman(a, b):
    return float(pd.Series(a).rank().corr(pd.Series(b).rank()))


def part_a(O):
    f1 = O.shift(-1) / O - 1.0    # hour h return: open of h to open of h+1
    f24 = O.shift(-24) / O - 1.0  # UTC day return: 00:00 open to next 00:00 open
    hours = O.index.hour
    wd = O.index.weekday
    tables = {}
    for scope in COINS + ["pooled"]:
        cols = COINS if scope == "pooled" else [scope]
        tables[scope] = {}
        for w in WINDOWS:
            m = wmask(O.index, w)
            hrs = []
            for h in range(24):
                n, mu, t = mean_t(f1.loc[m & (hours == h), cols].values.ravel())
                hrs.append({"hour_utc": h, "n": n, "mean_bps": r(mu * 1e4 if mu is not None else None),
                            "t": r(t, 3)})
            days = []
            for d in range(7):
                n, mu, t = mean_t(f24.loc[m & (hours == 0) & (wd == d), cols].values.ravel())
                days.append({"weekday": WEEKDAYS[d], "n": n,
                             "mean_bps": r(mu * 1e4 if mu is not None else None), "t": r(t, 3)})
            tables[scope][w] = {"hours": hrs, "weekdays": days}
    stab = {}
    for scope in COINS + ["pooled"]:
        def vec(w, k):
            return [x["mean_bps"] for x in tables[scope][w][k]]
        def sign_agree(w1, w2, k):
            a, b = vec(w1, k), vec(w2, k)
            return int(sum(1 for x, y in zip(a, b) if (x > 0) == (y > 0)))
        stab[scope] = {
            "hours_spearman_train_validate": r(spearman(vec("train", "hours"), vec("validate", "hours")), 3),
            "hours_spearman_validate_holdout": r(spearman(vec("validate", "hours"), vec("holdout", "hours")), 3),
            "hours_spearman_train_holdout": r(spearman(vec("train", "hours"), vec("holdout", "hours")), 3),
            "hours_same_sign_train_validate_of_24": sign_agree("train", "validate", "hours"),
            "hours_same_sign_validate_holdout_of_24": sign_agree("validate", "holdout", "hours"),
            "weekdays_spearman_train_validate": r(spearman(vec("train", "weekdays"), vec("validate", "weekdays")), 3),
            "weekdays_spearman_validate_holdout": r(spearman(vec("validate", "weekdays"), vec("holdout", "weekdays")), 3),
            "weekdays_spearman_train_holdout": r(spearman(vec("train", "weekdays"), vec("holdout", "weekdays")), 3),
            "weekdays_same_sign_train_validate_of_7": sign_agree("train", "validate", "weekdays"),
            "weekdays_same_sign_validate_holdout_of_7": sign_agree("validate", "holdout", "weekdays"),
        }
    return tables, stab


def select(O):
    """TRAIN-only selection, pooled across the three coins."""
    m = wmask(O.index, "train")
    hours = O.index.hour
    wd = O.index.weekday
    f3 = O.shift(-3) / O - 1.0
    f24 = O.shift(-24) / O - 1.0
    blocks = []
    for h in range(24):
        n, mu, t = mean_t(f3.loc[m & (hours == h), COINS].values.ravel())
        blocks.append({"start_hour_utc": h, "hours_utc": [h, (h + 1) % 24, (h + 2) % 24],
                       "n": n, "mean_bps": r(mu * 1e4), "t": r(t, 3), "_m": mu})
    days = []
    for d in range(7):
        n, mu, t = mean_t(f24.loc[m & (hours == 0) & (wd == d), COINS].values.ravel())
        days.append({"weekday": WEEKDAYS[d], "weekday_index": d, "n": n, "mean_bps": r(mu * 1e4),
                     "t": r(t, 3), "_m": mu})
    best_b = max(blocks, key=lambda x: x["_m"])["start_hour_utc"]
    worst_b = min(blocks, key=lambda x: x["_m"])["start_hour_utc"]
    best_d = max(days, key=lambda x: x["_m"])["weekday_index"]
    worst_d = min(days, key=lambda x: x["_m"])["weekday_index"]
    for x in blocks + days:
        del x["_m"]
    return {"best_block_start": best_b, "worst_block_start": worst_b,
            "best_day": best_d, "worst_day": worst_d,
            "train_block_table": blocks, "train_weekday_table": days}


def build_trades(O, starts, legs):
    """legs: list of (entry_mask, hold_hours, direction). Returns one row per portfolio round trip."""
    rows = []
    listed = pd.DataFrame({c: O.index >= starts[c] for c in COINS}, index=O.index)
    for mask, hold, direction in legs:
        fwd = (O.shift(-hold) / O - 1.0)[mask]
        # only slots whose exit time is inside the data range at all
        fwd = fwd[fwd.index + pd.Timedelta(hours=hold) <= O.index[-1]]
        lst = listed.loc[fwd.index]
        valid = fwd.notna()
        gross = direction * fwd.mean(axis=1, skipna=True)
        fund = (-direction * FUNDING_PER_8H * hold / 8.0) if hold > 8 else 0.0
        rows.append(pd.DataFrame({
            "gross": gross, "funding": fund, "coins": valid.sum(axis=1),
            "skipped": (lst.values & ~valid.values).sum(axis=1), "hold": hold,
        }, index=fwd.index))
    return pd.concat(rows).sort_index(kind="stable")


def stats(tr, w, cost_name):
    a, b = WINDOWS[w]
    years = ((pd.Timestamp(b) + pd.Timedelta(days=1)) - pd.Timestamp(a)).days / 365.25
    sub = tr[wmask(tr.index, w)]
    skipped_coin_trades = int(sub["skipped"].sum())
    sub = sub[sub["coins"] > 0]
    if cost_name == "zero":
        x = sub["gross"].values
    else:
        x = (sub["gross"] + sub["funding"] - COSTS[cost_name]).values
    n, mu, t = mean_t(x)
    eq = np.cumprod(1.0 + x)
    total = eq[-1] - 1.0
    peak = np.maximum.accumulate(np.concatenate([[1.0], eq]))
    dd = (np.concatenate([[1.0], eq]) / peak - 1.0).min()
    sd = x.std(ddof=1)
    ann = (1.0 + total) ** (1.0 / years) - 1.0 if total > -1 else -1.0
    return {
        "trades": n,
        "coin_round_trips": int(sub["coins"].sum()),
        "coin_round_trips_skipped_missing_bar": skipped_coin_trades,
        "mean_bps": r(mu * 1e4, 3),
        "t": r(t, 3),
        "win_rate": r(float((x > 0).mean()), 4),
        "total_return": r(total, 4),
        "annualised_return": r(ann, 4),
        "annualised_sharpe": r(mu / sd * np.sqrt(n / years), 3),
        "max_drawdown": r(dd, 4),
    }


def main():
    O, gaps, starts = load()
    tables, stab = part_a(O)
    sel = select(O)
    hours = O.index.hour
    wd = O.index.weekday
    variants = {
        "best_hours_long": [(hours == sel["best_block_start"], 3, +1)],
        "worst_hours_short": [(hours == sel["worst_block_start"], 3, -1)],
        "best_day_long": [((hours == 0) & (wd == sel["best_day"]), 24, +1)],
        "worst_day_short": [((hours == 0) & (wd == sel["worst_day"]), 24, -1)],
        "weekend_long": [((hours == 0) & (wd == 5), 48, +1)],
        "pre_funding_fade": [(np.isin(hours, [23, 7, 15]), 1, -1), (np.isin(hours, [0, 8, 16]), 1, +1)],
    }
    def blk(h):
        return f"{h:02d}:00 to {(h + 3) % 24:02d}:00 UTC"
    selected = {
        "best_hours_long": blk(sel["best_block_start"]),
        "worst_hours_short": blk(sel["worst_block_start"]),
        "best_day_long": WEEKDAYS[sel["best_day"]],
        "worst_day_short": WEEKDAYS[sel["worst_day"]],
        "weekend_long": "Sat 00:00 to Mon 00:00 UTC (no selection)",
        "pre_funding_fade": "short 23-00, 07-08, 15-16; long 00-01, 08-09, 16-17 UTC (no selection)",
    }
    results, verdicts = {}, {}
    for name, legs in variants.items():
        tr = build_trades(O, starts, legs)
        results[name] = {w: {c: stats(tr, w, c) for c in COSTS} for w in WINDOWS}
        R = results[name]
        passes = bool(R["validate"]["stressed"]["mean_bps"] > 0 and R["holdout"]["stressed"]["mean_bps"] > 0
                      and R["holdout"]["stressed"]["t"] >= 2)
        gross_real = bool(all(R[w]["zero"]["mean_bps"] > 0 for w in WINDOWS) and R["holdout"]["zero"]["t"] >= 2)
        verdicts[name] = {"passes": passes, "real_but_not_tradable": bool(gross_real and not passes)}

    out = {
        "spec": {
            "coins": COINS, "windows": WINDOWS, "costs_per_round_trip": COSTS,
            "funding_assumption": "0.01% per 8 hours held, charged to longs and credited to shorts, only for holds "
                                  "longer than 8 hours, applied at base and stressed cost. Zero cost is gross of "
                                  "both fees and funding.",
            "trade_definition": "One trade is one portfolio round trip: the equal-weight mean of the coins with "
                                "valid entry and exit bars. Trades are assigned to a window by entry time.",
            "hourly_return": "open of hour h to open of hour h+1",
            "daily_return": "00:00 UTC open to next 00:00 UTC open",
            "block_selection": "24 candidate 3-hour blocks (wrap past midnight allowed), ranked by pooled TRAIN "
                               "mean of the 3-hour open-to-open return",
            "sharpe": "per-trade mean / std * sqrt(trades per year)",
            "pass_rule": "stressed-cost mean > 0 in validate and holdout, holdout stressed t >= 2",
            "real_but_not_tradable_rule": "zero-cost mean > 0 in all three windows, holdout zero-cost t >= 2, "
                                          "and fails the pass rule",
        },
        "data_gaps": gaps,
        "part_a": {"tables": tables, "stability": stab},
        "selection_train_only": sel,
        "selected": selected,
        "part_b": results,
        "verdicts": verdicts,
    }
    with open(OUT, "w", newline="\n") as f:
        json.dump(out, f, indent=1)

    # ---- markdown tables to stdout (pasted into CALENDAR.md) ----
    p = print
    p("## gaps")
    for c in COINS:
        p(c, json.dumps(gaps[c]))
    p("\n## selected")
    for k, v in selected.items():
        p(f"- `{k}`: {v}")
    p("\n## stability")
    p("| Scope | Hours: train vs validate | Hours: validate vs holdout | Hours: train vs holdout | Days: train vs validate | Days: validate vs holdout | Days: train vs holdout |")
    p("|---|---|---|---|---|---|---|")
    for s, v in stab.items():
        p(f"| {s} | {v['hours_spearman_train_validate']:.3f} | {v['hours_spearman_validate_holdout']:.3f} | {v['hours_spearman_train_holdout']:.3f} | "
          f"{v['weekdays_spearman_train_validate']:.3f} | {v['weekdays_spearman_validate_holdout']:.3f} | {v['weekdays_spearman_train_holdout']:.3f} |")
    p("\nsame sign counts:", {s: (v["hours_same_sign_train_validate_of_24"], v["hours_same_sign_validate_holdout_of_24"],
                                 v["weekdays_same_sign_train_validate_of_7"], v["weekdays_same_sign_validate_holdout_of_7"])
                             for s, v in stab.items()})
    p("\n## pooled hourly means (bps, t)")
    p("| Hour UTC | Train | Validate | Holdout |")
    p("|---|---|---|---|")
    for h in range(24):
        cells = [f"{tables['pooled'][w]['hours'][h]['mean_bps']:+.2f} ({tables['pooled'][w]['hours'][h]['t']:+.2f})" for w in WINDOWS]
        p(f"| {h:02d} | " + " | ".join(cells) + " |")
    p("\n## pooled weekday means (bps, t)")
    p("| Day | Train | Validate | Holdout |")
    p("|---|---|---|---|")
    for d in range(7):
        cells = [f"{tables['pooled'][w]['weekdays'][d]['mean_bps']:+.1f} ({tables['pooled'][w]['weekdays'][d]['t']:+.2f})" for w in WINDOWS]
        p(f"| {WEEKDAYS[d]} | " + " | ".join(cells) + " |")
    for w in WINDOWS:
        p(f"\n## results: {w}")
        p("| Variant | Cost | Trades | Mean bps | t | Win rate | Total return | Annualised | Sharpe | Max drawdown |")
        p("|---|---|---|---|---|---|---|---|---|---|")
        for name in variants:
            for c in COSTS:
                s = results[name][w][c]
                p(f"| `{name}` | {c} | {s['trades']} | {s['mean_bps']:+.2f} | {s['t']:+.2f} | {s['win_rate']*100:.1f}% | "
                  f"{s['total_return']*100:+.1f}% | {s['annualised_return']*100:+.1f}% | {s['annualised_sharpe']:+.2f} | {s['max_drawdown']*100:.1f}% |")
    p("\n## verdicts")
    for k, v in verdicts.items():
        p(k, v)
    p("\nskipped coin round trips:", {n: {w: results[n][w]['zero']['coin_round_trips_skipped_missing_bar'] for w in WINDOWS} for n in variants})


if __name__ == "__main__":
    sys.exit(main())
