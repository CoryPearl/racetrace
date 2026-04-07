#!/usr/bin/env python3
"""
Run prefetch_all_race_telemetry.py for each championship year in a range.

Default: **2026 only** (single season). Stops with exit code 1 if any year fails.

Example:
  python3 scripts/prefetch_all_years.py
  python3 scripts/prefetch_all_years.py --refresh --workers 2
  python3 scripts/prefetch_all_years.py --start-year 2018 --end-year 2024 --no-sprint
  python3 scripts/prefetch_all_years.py --no-qualifying
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PREFETCH = Path(__file__).resolve().parent / "prefetch_all_race_telemetry.py"


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Run prefetch_all_race_telemetry.py once per year. "
            "Forwards flags to that script (see its --help)."
        ),
    )
    p.add_argument(
        "--start-year",
        type=int,
        default=2026,
        help="First season year (default: 2026).",
    )
    p.add_argument(
        "--end-year",
        type=int,
        default=2026,
        help="Last season year (default: 2026).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print commands only, do not run prefetch.",
    )
    p.add_argument(
        "--refresh",
        action="store_true",
        help="Pass --refresh to each prefetch (recompute pickles).",
    )
    p.add_argument(
        "--no-sprint",
        action="store_true",
        help="Pass --no-sprint to each prefetch (races only).",
    )
    p.add_argument(
        "--no-qualifying",
        action="store_true",
        help="Pass --no-qualifying to each prefetch (skip Q).",
    )
    p.add_argument(
        "--qualifying-only",
        action="store_true",
        help="Pass --qualifying-only to each prefetch (Q only).",
    )
    p.add_argument(
        "--include-future-rounds",
        action="store_true",
        help="Pass --include-future-rounds to each prefetch.",
    )
    p.add_argument(
        "--workers",
        type=int,
        default=None,
        metavar="N",
        help="Pass --workers N to each prefetch.",
    )
    p.add_argument(
        "--verbose",
        action="store_true",
        help="Pass --verbose to each prefetch.",
    )
    p.add_argument(
        "--start-round",
        type=int,
        default=None,
        help="Pass --start-round to each prefetch.",
    )
    p.add_argument(
        "--end-round",
        type=int,
        default=None,
        help="Pass --end-round to each prefetch.",
    )
    p.add_argument(
        "--first-n-rounds",
        type=int,
        default=None,
        metavar="N",
        help="Pass --first-n-rounds N to each prefetch (rounds 1..N only).",
    )
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    if args.no_qualifying and args.qualifying_only:
        print("--no-qualifying and --qualifying-only cannot be used together.", file=sys.stderr)
        return 2
    if args.start_year > args.end_year:
        print("start-year must be <= end-year", file=sys.stderr)
        return 2
    if args.first_n_rounds is not None and (
        args.start_round is not None or args.end_round is not None
    ):
        print(
            "Use either --first-n-rounds or --start-round/--end-round, not both.",
            file=sys.stderr,
        )
        return 2

    if not PREFETCH.is_file():
        print(f"Missing {PREFETCH}", file=sys.stderr)
        return 2

    extra: list[str] = []
    if args.refresh:
        extra.append("--refresh")
    if args.no_sprint:
        extra.append("--no-sprint")
    if args.no_qualifying:
        extra.append("--no-qualifying")
    if args.qualifying_only:
        extra.append("--qualifying-only")
    if args.include_future_rounds:
        extra.append("--include-future-rounds")
    if args.verbose:
        extra.append("--verbose")
    if args.workers is not None:
        extra.extend(["--workers", str(args.workers)])
    if args.start_round is not None:
        extra.extend(["--start-round", str(args.start_round)])
    if args.end_round is not None:
        extra.extend(["--end-round", str(args.end_round)])
    if args.first_n_rounds is not None:
        extra.extend(["--first-n-rounds", str(args.first_n_rounds)])

    failed: list[int] = []

    for year in range(args.start_year, args.end_year + 1):
        cmd = [sys.executable, str(PREFETCH), "--year", str(year), *extra]
        print(f"\n{'=' * 60}\n  Year {year}\n{'=' * 60}", flush=True)
        if args.dry_run:
            print(" ", subprocess.list2cmdline(cmd), flush=True)
            continue
        r = subprocess.run(cmd, cwd=ROOT)
        if r.returncode != 0:
            failed.append(year)

    if args.dry_run:
        return 0

    if failed:
        print(
            f"\nFinished with failures for year(s): {failed}",
            file=sys.stderr,
        )
        return 1
    print(f"\nAll years {args.start_year}–{args.end_year} completed successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
