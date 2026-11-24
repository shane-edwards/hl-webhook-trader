"""Download Ironflow's public historical datasets and retain hourly market aggregates."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path

import pyarrow.parquet as parquet
import requests


CACHE = Path("backtest/data/intraday/hyperliquid-liquidations")
MARKETS = ["BTC-PERP", "ETH-PERP", "SOL-PERP"]
MONTHS = [f"2025-{month:02}" for month in range(5, 13)] + [f"2026-{month:02}" for month in range(1, 11)]
HOUR_SECONDS = 3600


def table(dataset, file, columns):
    url = f"https://huggingface.co/datasets/ironflow/{dataset}/resolve/main/data/{file}.parquet"
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    return parquet.read_table(BytesIO(response.content), columns=columns, filters=[("market", "in", MARKETS)]).to_pylist()


def hour_ms(timestamp):
    return int(timestamp.timestamp() // HOUR_SECONDS) * HOUR_SECONDS * 1000


def month_data(month):
    output = CACHE / f"{month}.json"
    quarters = CACHE / f"{month}-15m.json"
    if output.exists() and quarters.exists():
        return
    # Bucket each closing fill when it occurred. Read no wallet addresses or event-level totals.
    trades = table("hyperliquid-liquidations", f"fills/{month}", ["market", "timestamp", "side", "notional_usd"])
    if not quarters.exists():
        quarter_tape = {}
        for row in trades:
            time = int(row["timestamp"].timestamp() // 900) * 900_000
            values = quarter_tape.setdefault((row["market"], time), [0, 0])
            if row["side"] not in {"buy", "sell"}:
                raise ValueError(f"Unexpected liquidation side in {month}")
            values[0 if row["side"] == "sell" else 1] += row["notional_usd"]
        result = {market.removesuffix("-PERP"): [[time, *values]
                  for (coin, time), values in sorted(quarter_tape.items()) if coin == market] for market in MARKETS}
        temporary = quarters.with_suffix(".tmp")
        temporary.write_text(json.dumps(result, separators=(",", ":"), allow_nan=False), encoding="utf8")
        temporary.replace(quarters)
    if output.exists():
        return
    candles = table("hyperliquid-candles-1h", month, ["market", "timestamp", "open", "high", "low", "close", "volume"])
    funding = table("hyperliquid-funding", month, ["market", "timestamp", "funding_rate"])
    tape = {}
    for row in candles:
        key = (row["market"], hour_ms(row["timestamp"]))
        if key in tape:
            raise ValueError(f"Duplicate Hyperliquid candle {key}")
        tape[key] = [*map(row.get, ["open", "high", "low", "close", "volume"]), None, 0, 0]
    for row in funding:
        key = (row["market"], hour_ms(row["timestamp"]))
        if key in tape:
            tape[key][5] = row["funding_rate"]
    for row in trades:
        key = (row["market"], hour_ms(row["timestamp"]))
        if key in tape:
            if row["side"] not in {"buy", "sell"}:
                raise ValueError(f"Unexpected liquidation side at {key}")
            tape[key][6 if row["side"] == "sell" else 7] += row["notional_usd"]
    result = {market.removesuffix("-PERP"): [[time, *values] for (coin, time), values in sorted(tape.items()) if coin == market]
              for market in MARKETS}
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, separators=(",", ":"), allow_nan=False), encoding="utf8")
    temporary.replace(output)
    print(month, ", ".join(f"{coin} {len(rows)} hours" for coin, rows in result.items()), flush=True)


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=5) as executor:
        list(executor.map(month_data, MONTHS))
