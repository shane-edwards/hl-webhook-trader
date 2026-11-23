"""Download 5-minute USDT perp candles for the scalp study (Python 3, no packages)."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from io import BytesIO
from pathlib import Path
import csv
import sys
from urllib.request import urlopen
from zipfile import ZipFile


def download(task):
    symbol, month, folder = task
    name = f"{symbol}-5m-{month}"
    output = folder / f"{name}.csv"
    if output.exists():
        return
    url = f"https://data.binance.vision/data/futures/um/monthly/klines/{symbol}/5m/{name}.zip"
    with urlopen(url, timeout=30) as response:
        archive = response.read()
    with ZipFile(BytesIO(archive)) as zipped:
        rows = zipped.read(f"{name}.csv").decode("utf-8").splitlines()
    candles = [row[:6] for row in csv.reader(rows) if row and row[0].isdigit()]
    if not candles:
        raise ValueError(f"No candles in {name}")
    temporary = output.with_suffix(".tmp")
    temporary.write_text("\n".join(",".join(row) for row in candles) + "\n", encoding="utf-8")
    temporary.replace(output)


if __name__ == "__main__":
    last = date.fromisoformat((sys.argv[1] if len(sys.argv) > 1 else "2026-10") + "-01")
    folder = Path(__file__).parent / "data" / "intraday" / "scalp-perps"
    folder.mkdir(parents=True, exist_ok=True)
    months = [f"{year}-{month:02}" for year in range(2024, last.year + 1)
              for month in range(1, 13) if date(year, month, 1) <= last]
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(download, [(coin + "USDT", month, folder) for coin in ("BTC", "ETH", "SOL") for month in months]))
    print(f"Cached {len(months)} months for each of BTC, ETH, and SOL")
