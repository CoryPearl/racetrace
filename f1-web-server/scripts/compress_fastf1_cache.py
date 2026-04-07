#!/usr/bin/env python3
"""
Compress FastF1 session data from the **live cache directory** while preserving the tree.

That directory is the same as the app uses (``abs_fastf1_cache_dir()`` — user profile by default,
e.g. ``~/Library/Caches/f1-race-replay/fastf1`` on macOS). FastF1 stores parsed API data as
``*.ff1pkl`` under paths like::

    <live cache>/<year>/<YYYY-MM-DD_Event_Name>/<YYYY-MM-DD_SessionName>/*.ff1pkl

By default this script only compresses files under **Race**, **Qualifying**, and **Sprint*** session
folders (including ``Sprint_Qualifying``, ``Sprint_Shootout``, etc.). Practice and
other sessions are skipped so you can shrink the archive without losing replay-critical data.

Output mirrors ``compress_pkl_cache.py``::

    <live cache>/.../timing_data.ff1pkl
        -> compressed_fastf1-cache/.../timing_data.ff1pkl.xz

Restore one file::

    xz -dk path/to/file.ff1pkl.xz

Run from the project directory::

    PYTHONPATH=backend python3 scripts/compress_fastf1_cache.py --dry-run
    PYTHONPATH=backend python3 scripts/compress_fastf1_cache.py --preset 3 -j 2
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

from compress_pkl_cache import run_tree

_SESS_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}_(.+)$")


def _resolve_fastf1_cache_src(_base: Path) -> Path:
    """Same directory as the running app (``abs_fastf1_cache_dir()``)."""
    try:
        from src.lib.fastf1_compressed_cache import abs_fastf1_cache_dir

        return Path(abs_fastf1_cache_dir())
    except ImportError:
        from src.lib.settings import default_fastf1_cache_user_path

        try:
            return Path(default_fastf1_cache_user_path())
        except ImportError:
            xdg = os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))
            return Path(xdg) / "f1-race-replay" / "fastf1"


def include_race_quali_sprint(rel: Path) -> bool:
    """
    True if ``rel`` lies under a session directory whose name is
    ``YYYY-MM-DD_Race``, ``…_Qualifying``, or ``…_Sprint…``.
    """
    for part in rel.parts[:-1]:
        m = _SESS_DIR.match(part)
        if not m:
            continue
        tail = m.group(1)
        if tail in ("Race", "Qualifying"):
            return True
        if tail.startswith("Sprint"):
            return True
    return False


def main() -> int:
    default_preset = 3
    ap = argparse.ArgumentParser(
        description="LZMA-compress FastF1 live cache (Race / Qualifying / Sprint sessions).",
    )
    ap.add_argument(
        "--base",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Project root (default: parent of scripts/).",
    )
    ap.add_argument(
        "--preset",
        type=int,
        default=default_preset,
        help=f"LZMA level 0-9 (default {default_preset}).",
    )
    ap.add_argument(
        "--no-xz-cli",
        action="store_true",
        help="Use Python lzma only (single-threaded).",
    )
    ap.add_argument(
        "--jobs",
        "-j",
        type=int,
        default=1,
        metavar="N",
        help="Compress N files in parallel (default 1).",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="Recompress even if the .xz exists and looks up to date.",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned outputs without writing files.",
    )
    ap.add_argument(
        "--all-files",
        action="store_true",
        help="Compress every *.ff1pkl and *.pkl under the live FastF1 cache (include practice, etc.).",
    )
    args = ap.parse_args()
    _root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(_root / "backend"))
    base = args.base.resolve()
    if args.jobs < 1:
        print("--jobs must be >= 1.", file=sys.stderr)
        return 2

    xz_path = shutil.which("xz")
    prefer_xz_cli = not args.no_xz_cli and xz_path is not None
    if prefer_xz_cli:
        print(f"Using xz CLI ({xz_path}) with multi-threading (-T0 when supported).", flush=True)
    else:
        print(
            "Using Python lzma (single-threaded). Install xz or omit --no-xz-cli for faster runs.",
            flush=True,
        )

    src_root = _resolve_fastf1_cache_src(base)
    dest_root = base / "compressed_fastf1-cache"
    pf = None if args.all_files else include_race_quali_sprint
    mode = "all *.ff1pkl / *.pkl" if args.all_files else "Race / Qualifying / Sprint* sessions only"
    print(
        f"\n=== {src_root} -> {dest_root.name} ({mode}) ===",
        flush=True,
    )

    ok, skipped, er = run_tree(
        src_root,
        dest_root,
        preset=args.preset,
        force=args.force,
        dry_run=args.dry_run,
        prefer_xz_cli=prefer_xz_cli,
        jobs=args.jobs,
        patterns=("*.ff1pkl", "*.pkl"),
        path_filter=pf,
    )
    if not args.dry_run:
        print(
            f"  done: {ok} written, {skipped} skipped (already up to date), {er} errors",
            flush=True,
        )
    print(
        f"\nTotal: {ok} {'planned' if args.dry_run else 'written'}, "
        f"{skipped} skipped, {er} errors"
    )
    return 1 if er else 0


if __name__ == "__main__":
    raise SystemExit(main())
