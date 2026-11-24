"""Replay the single BTC dislocation on public Binance prints, with delayed two-sided fill proxies."""

import csv
import io
import json
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

DATE = "2026-08-19"
ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "data" / "intraday" / "basis-tape"
START = int(datetime.fromisoformat(DATE + "T15:28:00+00:00").timestamp() * 1000)
END = START + 60000
STRESS_PER_FILL = 0.0018


def events(venue):
    name = f"BTCUSDT-aggTrades-{DATE}"
    file = CACHE / venue / (name + ".zip")
    file.parent.mkdir(parents=True, exist_ok=True)
    if not file.exists():
        url = f"https://data.binance.vision/data/{venue}/daily/aggTrades/BTCUSDT/{name}.zip"
        with urlopen(url, timeout=40) as response:
            content = response.read()
        temporary = file.with_suffix(".tmp")
        temporary.write_bytes(content)
        temporary.replace(file)
    rows = []
    with ZipFile(file) as archive:
        with archive.open(name + ".csv") as stream:
            for row in csv.reader(io.TextIOWrapper(stream)):
                if not row or not row[0].isdigit():
                    continue
                time = int(row[5])
                if time > 100_000_000_000_000:
                    time //= 1000
                if time < START - 5000:
                    continue
                if time > END + 10000:
                    break
                rows.append((time, float(row[1]), float(row[2]), row[6].lower() == "true"))
    return rows


def fill(rows, time, seller_aggresses, units):
    remaining, value, last = units, 0, None
    for observed, price, amount, sell in rows:
        if observed < time or sell != seller_aggresses:
            continue
        if observed > time + 1000:
            break
        size = min(remaining, amount)
        value += size * price
        remaining -= size
        last = observed
        if remaining <= units * 1e-8:
            return value / units, last
    return None


def replay(spot, perp, delay):
    # A prior spot print fixes the coin quantity before looking at later fills.
    reference = [price for time, price, _, _ in spot if time < START][-1]
    quantity = 1000 / reference
    legs = [fill(spot, START + delay, False, quantity), fill(perp, START + delay, True, quantity),
            fill(spot, END + delay, True, quantity), fill(perp, END + delay, False, quantity)]
    if any(leg is None for leg in legs):
        return {"delayMs": delay, "matched": False}
    (buy_spot, spot_time), (short_perp, perp_time), (sell_spot, _), (buy_perp, _) = legs
    net = (sell_spot - buy_spot + short_perp - buy_perp - STRESS_PER_FILL *
           (buy_spot + sell_spot + short_perp + buy_perp)) / (2.5 * reference)
    return {"delayMs": delay, "matched": True, "entryBasis": short_perp / buy_spot - 1,
            "entryTimingDifferenceMs": abs(spot_time - perp_time), "net": net}


if __name__ == "__main__":
    spot, perp = events("spot"), events("futures/um")
    report = {"asset": "BTC", "event UTC": DATE + "T15:28:00Z",
              "sampledTrades": {"spot": len(spot), "perp": len(perp)},
              "windows": [replay(spot, perp, delay) for delay in [100, 500, 1000, 5000]]}
    (ROOT / "basis-trade-tape-results.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))
