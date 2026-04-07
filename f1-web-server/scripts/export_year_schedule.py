#!/usr/bin/env python3
"""
Export one season calendar to static JSON for the browser (no /api/schedule call).

Writes frontend/data/schedule/{year}.json — same shape as GET /api/schedule/{year}.

Run from repo root:
  PYTHONPATH=backend python3 scripts/export_year_schedule.py --year 2024
  PYTHONPATH=backend python3 scripts/export_year_schedule.py --year 2024 --write-default-year
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = ROOT / "backend"


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--year", type=int, required=True)
    p.add_argument(
        "--write-default-year",
        action="store_true",
        help="Also write frontend/data/default-year.json for static-only hosting",
    )
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    sys.path.insert(0, str(BACKEND_ROOT))
    os.chdir(ROOT)

    from fastapi.encoders import jsonable_encoder

    from src.f1_data import enable_cache, get_race_weekends_by_year

    enable_cache()
    year = args.year
    weekends = get_race_weekends_by_year(year)
    for w in weekends:
        w["year"] = year

    payload = jsonable_encoder({"year": year, "events": weekends})

    sched_dir = ROOT / "frontend" / "data" / "schedule"
    sched_dir.mkdir(parents=True, exist_ok=True)
    out_path = sched_dir / f"{year}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))

    print(f"Wrote {out_path.relative_to(ROOT)} ({len(weekends)} events)")

    if args.write_default_year:
        default_path = ROOT / "frontend" / "data" / "default-year.json"
        default_path.parent.mkdir(parents=True, exist_ok=True)
        with open(default_path, "w", encoding="utf-8") as f:
            json.dump({"year": year}, f, separators=(",", ":"))
        print(f"Wrote {default_path.relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
