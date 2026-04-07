"""Load static replay JSON (meta + frames_*.json) from disk under ``<static>/data/replays/``."""

from __future__ import annotations

import json
from pathlib import Path

# Must match scripts/export_static_replay.py and frontend/app.js CHUNK_SIZE
CHUNK_SIZE = 600


def replay_slug(year: int, round_number: int, session_type: str) -> str:
    return f"{year}_r{int(round_number):02d}_{session_type}"


def load_static_replay_bundle(
    public_dir: Path, year: int, round_number: int, session_type: str
) -> dict | None:
    """
    Load ``data/replays/<slug>/meta.json`` and ``frames_<n>.json`` from ``public_dir``.

    Returns a dict compatible with ``load_race_replay_payload`` output (no ``session`` key),
    or None if missing or incomplete.
    """
    slug = replay_slug(year, round_number, session_type)
    base = public_dir / "data" / "replays" / slug
    meta_path = base / "meta.json"
    if not meta_path.is_file():
        return None
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    total = int(meta.get("total_frames") or 0)
    if total < 1:
        return None
    frames: list = []
    for start in range(0, total, CHUNK_SIZE):
        chunk_path = base / f"frames_{start}.json"
        if not chunk_path.is_file():
            return None
        chunk = json.loads(chunk_path.read_text(encoding="utf-8"))
        frames.extend(chunk.get("frames") or [])
    return {
        "fps": meta.get("fps") or 25,
        "frames": frames,
        "driver_colors": meta["driver_colors"],
        "driver_teams": meta.get("driver_teams") or {},
        "track_statuses": meta["track_statuses"],
        "total_laps": meta["total_laps"],
        "max_tyre_life": meta.get("max_tyre_life") or {},
        "tyre_expected_laps": meta.get("tyre_expected_laps") or {},
        "circuit_rotation": meta["circuit_rotation"],
        "session_info": meta["session_info"],
        "track": meta["track"],
        "race_events": meta.get("race_events") or [],
    }
