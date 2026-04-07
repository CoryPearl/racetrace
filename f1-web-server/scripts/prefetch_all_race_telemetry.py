#!/usr/bin/env python3
"""
Precompute and save race, sprint, and qualifying telemetry for every round in a season.

Uses load_session + get_race_telemetry from src/f1_data.py; writes the same
pickles the replay uses under computed_data/ (race, sprint, quali_replay).

Parallelism uses **processes** (--workers > 1) for different *sessions*. Inside each
worker, driver telemetry is processed **sequentially** (``F1_TELEMETRY_NO_POOL=1``):
nested multiprocessing (spawned prefetch workers + fork-based driver pool) breaks
FastF1's loaded ``Session`` with ``DataNotLoadedError``.

Chdir to repo root before running so paths match main.py.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime, timezone
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = ROOT / "backend"


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Precompute and save race, sprint, and qualifying telemetry pickles for every "
            "round in a season. Output matches get_race_telemetry in src/f1_data.py: "
            "computed_data/<event>_{race|sprint|quali_replay}_telemetry.pkl. "
            "Run from anywhere; cwd is set to the repo root."
        ),
        epilog=(
            "Examples:\n"
            "  python3 scripts/prefetch_all_race_telemetry.py --year 2026\n"
            "  python3 scripts/prefetch_all_race_telemetry.py --year 2026 --refresh\n"
            "  python3 scripts/prefetch_all_race_telemetry.py --year 2026 --workers 2\n"
            "  python3 scripts/prefetch_all_race_telemetry.py --year 2026 --no-qualifying\n"
            "  python3 scripts/prefetch_all_race_telemetry.py --year 2026 --qualifying-only\n"
            "  python3 scripts/prefetch_all_race_telemetry.py --year 2026 --first-n-rounds 3\n"
            "  python3 scripts/prefetch_all_race_telemetry.py --year 2026 --include-future-rounds"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--year",
        type=int,
        required=True,
        help="Championship year (e.g. 2026).",
    )
    p.add_argument(
        "--refresh",
        action="store_true",
        help="Recompute even when a pickle already exists (same as --refresh-data on main).",
    )
    p.add_argument(
        "--no-sprint",
        action="store_true",
        help="Only process grand prix races (session R), not sprints (session S).",
    )
    p.add_argument(
        "--no-qualifying",
        action="store_true",
        help="Skip qualifying (Q); default is to precompute Q for every round.",
    )
    p.add_argument(
        "--qualifying-only",
        action="store_true",
        help=(
            "Only precompute qualifying (Q) for each round — skip race and sprint. "
            "Use when *_race_telemetry.pkl / *_sprint_telemetry.pkl are already built."
        ),
    )
    p.add_argument(
        "--start-round",
        type=int,
        default=None,
        help="Only rounds with RoundNumber >= this value.",
    )
    p.add_argument(
        "--end-round",
        type=int,
        default=None,
        help="Only rounds with RoundNumber <= this value.",
    )
    p.add_argument(
        "--first-n-rounds",
        type=int,
        default=None,
        metavar="N",
        help="Only championship rounds 1 through N (equivalent to --start-round 1 --end-round N).",
    )
    p.add_argument(
        "--workers",
        type=int,
        default=None,
        metavar="N",
        help=(
            "Number of parallel prefetch jobs (processes). "
            "Default: 1 (sequential; safest for FastF1 session state). "
            "Increase for throughput if stable. "
            "Each job loads FastF1 and may fork worker processes for drivers."
        ),
    )
    p.add_argument(
        "--verbose",
        action="store_true",
        help="Show FastF1 log output (default: suppress).",
    )
    p.add_argument(
        "--include-future-rounds",
        action="store_true",
        help=(
            "Prefetch every row on the calendar, including weekends that have not happened yet "
            "(those jobs usually fail — no telemetry). Default is to skip future weekends."
        ),
    )
    args = p.parse_args()
    if args.qualifying_only and args.no_qualifying:
        p.error("--qualifying-only and --no-qualifying cannot be used together.")
    if args.first_n_rounds is not None:
        if args.start_round is not None or args.end_round is not None:
            p.error("Use either --first-n-rounds or --start-round/--end-round, not both.")
        if args.first_n_rounds < 1:
            p.error("--first-n-rounds must be >= 1.")
        args.start_round = 1
        args.end_round = args.first_n_rounds
    return args


def _event_weekend_is_future(event) -> bool:
    """
    True if the event's EventDate is after UTC today. FastF1 still lists full-season
    calendars; rounds that have not occurred have no session data — prefetch would fail.
    """
    d = event.get("EventDate")
    if d is None or pd.isna(d):
        return False
    try:
        ev = pd.Timestamp(d)
    except Exception:
        return False
    if ev.tzinfo is not None:
        ev = ev.tz_convert("UTC")
    today = datetime.now(timezone.utc).date()
    return ev.date() > today


def _event_has_sprint_weekend(year: int, event_format: str) -> bool:
    """
    True if this weekend includes a Sprint session (session type S).
    Matches the EventFormat strings FastF1 uses (see list_sprints in f1_data.py).
    """
    ev = (event_format or "").strip().lower()
    if not ev:
        return False
    if year in (2021, 2022):
        return ev == "sprint"
    if year == 2023:
        return ev == "sprint_shootout"
    # 2024+ typically "sprint_qualifying"; keep substring fallback for future formats
    return "sprint" in ev


def _prefetch_one_job(
    payload: tuple[int, int, str, bool, str, bool],
) -> tuple[bool, str, str | None]:
    """
    Run one session prefetch. Top-level for multiprocessing pickling.

    payload: (year, round_no, session_type, force_refresh, event_name, verbose)
    """
    year, round_no, session_type, force_refresh, event_name, verbose = payload
    label = f"{year} R{round_no} {event_name} [{session_type}]"
    # Repo root (not scripts/). Wrong cwd breaks computed_data paths and imports.
    sys.path.insert(0, str(BACKEND_ROOT))
    os.chdir(ROOT)
    # Prefetch workers are spawned; a second fork-based driver pool breaks FastF1 Session
    # (DataNotLoadedError). Process drivers sequentially in the same worker — see f1_data._fork_pool_map.
    os.environ.setdefault("F1_TELEMETRY_NO_POOL", "1")
    if not verbose:
        logging.getLogger("fastf1").setLevel(logging.CRITICAL)

    from src.f1_data import enable_cache, get_race_telemetry, load_session

    enable_cache()
    try:
        session = load_session(year, round_no, session_type)
        get_race_telemetry(
            session,
            session_type=session_type,
            force_refresh=force_refresh,
        )
        return True, label, None
    except Exception as e:
        return False, label, f"{type(e).__name__}: {e}"


def main() -> int:
    args = _parse_args()
    sys.path.insert(0, str(BACKEND_ROOT))
    os.chdir(ROOT)
    # Same as _prefetch_one_job: avoid nested multiprocessing + FastF1 Session (see module doc above).
    os.environ.setdefault("F1_TELEMETRY_NO_POOL", "1")

    if not args.verbose:
        logging.getLogger("fastf1").setLevel(logging.CRITICAL)

    from src.f1_data import enable_cache

    enable_cache()

    os.makedirs("computed_data", exist_ok=True)

    import fastf1

    try:
        schedule = fastf1.get_event_schedule(args.year)
    except Exception as e:
        print(f"Failed to load schedule for {args.year}: {e}", file=sys.stderr)
        return 2

    jobs: list[tuple[int, str, str]] = []
    skipped_future = 0

    for _, event in schedule.iterrows():
        if event.is_testing():
            continue
        if not args.include_future_rounds and _event_weekend_is_future(event):
            skipped_future += 1
            continue
        rnd = event["RoundNumber"]
        if pd.isna(rnd):
            continue
        rnd = int(rnd)
        if args.start_round is not None and rnd < args.start_round:
            continue
        if args.end_round is not None and rnd > args.end_round:
            continue

        name = str(event["EventName"])
        ev_fmt = str(event.get("EventFormat") or "")
        if args.qualifying_only:
            jobs.append((rnd, name, "Q"))
        else:
            jobs.append((rnd, name, "R"))
            if not args.no_sprint and _event_has_sprint_weekend(args.year, ev_fmt):
                jobs.append((rnd, name, "S"))
            if not args.no_qualifying:
                jobs.append((rnd, name, "Q"))

    workers = args.workers if args.workers is not None else 1

    payloads: list[tuple[int, int, str, bool, str, bool]] = [
        (args.year, rnd, st, args.refresh, name, args.verbose)
        for rnd, name, st in jobs
    ]

    ok = 0
    failed = 0

    if skipped_future:
        print(
            f"Skipped {skipped_future} future weekend(s) (no telemetry yet). "
            f"Use --include-future-rounds to try them anyway.",
            flush=True,
        )
    if not jobs:
        print(
            "No prefetch jobs: nothing left after filters (e.g. entire season is still "
            "in the future, or only testing rounds).",
            file=sys.stderr,
        )
        return 0
    print(
        f"Prefetching {len(jobs)} job(s) with "
        f"{workers} worker process(es) (sequential if workers==1).",
        flush=True,
    )

    if workers == 1:
        for p in payloads:
            success, label, err = _prefetch_one_job(p)
            if success:
                print(f"OK {label}")
                ok += 1
            else:
                print(f"FAILED {label}: {err}", file=sys.stderr)
                failed += 1
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            future_map = {pool.submit(_prefetch_one_job, p): p for p in payloads}
            for fut in as_completed(future_map):
                success, label, err = fut.result()
                if success:
                    print(f"OK {label}")
                    ok += 1
                else:
                    print(f"FAILED {label}: {err}", file=sys.stderr)
                    failed += 1

    print(f"Done. Succeeded: {ok}, failed: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
