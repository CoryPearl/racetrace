#!/usr/bin/env python3
"""
Export one session to static JSON under frontend/data/replays/<slug>/ so the
browser can load replay data without POST /api/session/load (meta.json + frames_0.json, …).

Slug format (must match client): {year}_r{round:02d}_{R|S|Q}
Example: 2026_r01_R

Run from repo root:
    PYTHONPATH=backend python3 scripts/export_static_replay.py --year 2026 --round 1 --session-type R
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = ROOT / "backend"

# Must match frontend/app.js CHUNK_SIZE
CHUNK_SIZE = 600


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--year", type=int, required=True)
    p.add_argument("--round", type=int, required=True, help="Championship round (1–24)")
    p.add_argument(
        "--session-type",
        choices=("R", "S", "Q"),
        default="R",
        help="R = GP, S = Sprint, Q = Qualifying",
    )
    return p.parse_args()


def make_slug(year: int, round_num: int, session_type: str) -> str:
    return f"{year}_r{int(round_num):02d}_{session_type}"


def main() -> int:
    args = _parse_args()
    sys.path.insert(0, str(BACKEND_ROOT))
    os.chdir(ROOT)

    from fastapi.encoders import jsonable_encoder

    from src.web.payload import load_race_replay_payload

    slug = make_slug(args.year, args.round, args.session_type)
    out_dir = ROOT / "frontend" / "data" / "replays" / slug
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading session {args.year} R{args.round} {args.session_type}…")
    payload = load_race_replay_payload(
        args.year,
        args.round,
        args.session_type,
        prefer_quali_for_track_geometry=True,
    )
    frames = payload.pop("frames")
    payload.pop("session", None)

    meta = {
        "fps": 25,
        "total_frames": len(frames),
        "driver_colors": payload["driver_colors"],
        "driver_teams": payload["driver_teams"],
        "track_statuses": payload["track_statuses"],
        "total_laps": payload["total_laps"],
        "max_tyre_life": payload.get("max_tyre_life") or {},
        "tyre_expected_laps": payload.get("tyre_expected_laps") or {},
        "circuit_rotation": payload["circuit_rotation"],
        "session_info": payload["session_info"],
        "track": payload["track"],
        "race_events": payload["race_events"],
    }
    meta = jsonable_encoder(meta)

    meta_path = out_dir / "meta.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"Wrote {meta_path.relative_to(ROOT)} ({len(frames)} frames)")

    for start in range(0, len(frames), CHUNK_SIZE):
        end = min(start + CHUNK_SIZE, len(frames))
        chunk = {
            "start": start,
            "end": end,
            "frames": jsonable_encoder(frames[start:end]),
        }
        chunk_path = out_dir / f"frames_{start}.json"
        with open(chunk_path, "w", encoding="utf-8") as f:
            json.dump(chunk, f, separators=(",", ":"))
        print(f"  chunk {start}..{end - 1} -> {chunk_path.name}")

    print(f"Done. Client URL base: /data/replays/{slug}/")
    print("Load session in the app: same year/round/type — static bundle is used if present.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
