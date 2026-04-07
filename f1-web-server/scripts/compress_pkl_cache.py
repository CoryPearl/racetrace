#!/usr/bin/env python3
"""
Compress every *.pkl under ``computed_data`` and the live FastF1 cache directory with LZMA (xz).

**Speed tips**
  - By default we use the ``xz`` CLI with ``-T0`` (all CPU cores) when available — much
    faster than Python's single-threaded ``lzma``.
  - Default preset is **3** (faster than 6; use ``--preset 6`` for smaller output).
  - For many smaller files, try ``--jobs 4`` (watch RAM with huge pickles).

Writes parallel trees:
  - computed_data/.../file.pkl     -> compressed_computed_data/.../file.pkl.xz
  - <live FastF1 cache>/.../file.pkl     -> compressed_fastf1-cache/.../file.pkl.xz
  - <live FastF1 cache>/.../file.ff1pkl  -> compressed_fastf1-cache/.../file.ff1pkl.xz

The live cache path is ``abs_fastf1_cache_dir()`` (same as the app: user profile by default).

Decompress example (restore one file):
  xz -dk file.pkl.xz   # produces file.pkl
"""
from __future__ import annotations

import argparse
import concurrent.futures
import lzma
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path


def _fmt_size(n: int) -> str:
    if n >= 1024**3:
        return f"{n / 1024**3:.2f} GiB"
    if n >= 1024**2:
        return f"{n / 1024**2:.1f} MiB"
    return f"{n / 1024:.1f} KiB"


def _xz_cli_available() -> str | None:
    return shutil.which("xz")


def _compress_with_xz_cli(src: Path, dest: Path, *, preset: int) -> None:
    """Stream through xz; does not load the whole file into Python."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    # -T0 = all cores (LZMA2 multi-threaded). Fallback if xz is too old.
    for extra in (["-T0"], []):
        cmd = ["xz", "-c", *extra, f"-{preset}", str(src)]
        try:
            with open(dest, "wb") as outf:
                subprocess.run(
                    cmd,
                    stdout=outf,
                    check=True,
                    stderr=subprocess.DEVNULL,
                )
            return
        except subprocess.CalledProcessError:
            if not extra:
                raise
            continue


def _compress_with_python_lzma(src: Path, dest: Path, *, preset: int) -> tuple[int, int]:
    """Stream compress (lower peak RAM than read_bytes + compress)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    src_bytes = 0
    with open(src, "rb") as f_in:
        f_in.seek(0, 2)
        src_bytes = f_in.tell()
    out_bytes = 0
    with (
        open(src, "rb") as f_in,
        lzma.open(
            dest,
            "wb",
            format=lzma.FORMAT_XZ,
            preset=preset,
        ) as f_out,
    ):
        shutil.copyfileobj(f_in, f_out)
    out_bytes = dest.stat().st_size
    return src_bytes, out_bytes


def compress_pkl(
    src: Path,
    dest: Path,
    *,
    preset: int,
    force: bool,
    prefer_xz_cli: bool,
) -> tuple[str, float, int, int]:
    """
    Returns (status, elapsed_s, src_bytes, out_bytes).
    status is 'skipped_exists' | 'ok' | 'error'.
    """
    if dest.exists() and not force:
        if dest.stat().st_mtime >= src.stat().st_mtime:
            return "skipped_exists", 0.0, 0, 0
    try:
        t0 = time.perf_counter()
        if prefer_xz_cli and _xz_cli_available():
            try:
                _compress_with_xz_cli(src, dest, preset=preset)
            except (OSError, subprocess.CalledProcessError):
                dest.unlink(missing_ok=True)
                src_b, out_b = _compress_with_python_lzma(src, dest, preset=preset)
            else:
                src_b = src.stat().st_size
                out_b = dest.stat().st_size
        else:
            src_b, out_b = _compress_with_python_lzma(src, dest, preset=preset)
        elapsed = time.perf_counter() - t0
        return "ok", elapsed, src_b, out_b
    except OSError as e:
        print(f"ERROR {src} -> {dest}: {e}", file=sys.stderr)
        return "error", 0.0, 0, 0


def iter_pattern_files(root: Path, patterns: tuple[str, ...]) -> Iterator[Path]:
    """All files under ``root`` matching any glob pattern (deduplicated)."""
    if not root.is_dir():
        return
    seen: set[Path] = set()
    for pat in patterns:
        for p in root.rglob(pat):
            if p.is_file():
                seen.add(p)
    yield from sorted(seen, key=lambda p: str(p).lower())


def iter_pkl_files(root: Path) -> Iterator[Path]:
    yield from iter_pattern_files(root, ("*.pkl",))


def run_tree(
    src_root: Path,
    dest_root: Path,
    *,
    preset: int,
    force: bool,
    dry_run: bool,
    prefer_xz_cli: bool,
    jobs: int,
    patterns: tuple[str, ...] = ("*.pkl",),
    path_filter: Callable[[Path], bool] | None = None,
) -> tuple[int, int, int]:
    """Returns (ok_count, skipped, errors).

    ``path_filter`` receives paths relative to ``src_root``; if it returns False, the file is
    skipped (not compressed).
    """
    ok, skipped, errors = 0, 0, 0
    if not src_root.is_dir():
        print(f"SKIP (missing): {src_root}", file=sys.stderr)
        return ok, skipped, errors

    print(f"  listing files {patterns}…", flush=True)
    all_files = sorted(iter_pattern_files(src_root, patterns))
    if path_filter:
        all_files = [
            f
            for f in all_files
            if path_filter(f.relative_to(src_root))
        ]
    total = len(all_files)
    print(f"  found {total} file(s).", flush=True)

    if dry_run:
        for src in all_files:
            rel = src.relative_to(src_root)
            dest = dest_root / f"{rel.as_posix()}.xz"
            print(f"would compress: {src} -> {dest}")
        return total, 0, 0

    # Build work list (index, rel, src, dest, nbytes) for files that need compression
    work: list[tuple[int, Path, Path, Path, int]] = []
    for idx, src in enumerate(all_files, 1):
        rel = src.relative_to(src_root)
        dest = dest_root / f"{rel.as_posix()}.xz"
        try:
            nbytes = src.stat().st_size
        except OSError:
            nbytes = 0

        if dest.exists() and not force:
            try:
                if dest.stat().st_mtime >= src.stat().st_mtime:
                    print(
                        f"  [{idx}/{total}] skip (up to date): {rel}",
                        flush=True,
                    )
                    skipped += 1
                    continue
            except OSError:
                pass
        work.append((idx, rel, src, dest, nbytes))

    if not work:
        return ok, skipped, errors

    print_lock = threading.Lock()

    def one(item: tuple[int, Path, Path, Path, int]) -> tuple[str, int, Path, float, int, int]:
        idx, rel, src, dest, nbytes = item
        with print_lock:
            print(
                f"  [{idx}/{total}] compressing {rel} ({_fmt_size(nbytes)})…",
                flush=True,
            )
        r, elapsed, src_b, out_b = compress_pkl(
            src, dest, preset=preset, force=force, prefer_xz_cli=prefer_xz_cli
        )
        return r, idx, rel, elapsed, src_b, out_b

    if jobs <= 1:
        for item in work:
            r, idx, rel, elapsed, src_b, out_b = one(item)
            if r == "ok":
                ok += 1
                ratio = (100.0 * out_b / src_b) if src_b else 0.0
                print(
                    f"       done in {elapsed:.1f}s → {_fmt_size(out_b)} "
                    f"({ratio:.1f}% of original)",
                    flush=True,
                )
            elif r == "skipped_exists":
                skipped += 1
            elif r == "error":
                errors += 1
    else:
        print(f"  using {jobs} parallel worker(s)", flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as ex:
            futures = {ex.submit(one, item): item for item in work}
            for fut in concurrent.futures.as_completed(futures):
                try:
                    r, idx, rel, elapsed, src_b, out_b = fut.result()
                except Exception as e:
                    with print_lock:
                        print(f"       ERROR: {e}", flush=True)
                    errors += 1
                    continue
                if r == "ok":
                    ok += 1
                    ratio = (100.0 * out_b / src_b) if src_b else 0.0
                    with print_lock:
                        print(
                            f"  [{idx}/{total}] {rel}: done in {elapsed:.1f}s → "
                            f"{_fmt_size(out_b)} ({ratio:.1f}% of original)",
                            flush=True,
                        )
                elif r == "skipped_exists":
                    skipped += 1
                elif r == "error":
                    errors += 1

    return ok, skipped, errors


def main() -> int:
    default_preset = 3
    ap = argparse.ArgumentParser(
        description="LZMA-compress all .pkl files into mirrored folder trees.",
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
        help=f"LZMA level 0-9 (default {default_preset}; lower=faster, higher=smaller).",
    )
    ap.add_argument(
        "--no-xz-cli",
        action="store_true",
        help="Use Python lzma only (single-threaded; slower).",
    )
    ap.add_argument(
        "--jobs",
        "-j",
        type=int,
        default=1,
        metavar="N",
        help="Compress N files in parallel (default 1). Raises peak RAM; use 1 for huge files.",
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
        "--computed-only",
        action="store_true",
        help="Only process computed_data -> compressed_computed_data.",
    )
    ap.add_argument(
        "--fastf1-only",
        action="store_true",
        help="Only process live FastF1 cache -> compressed_fastf1-cache.",
    )
    args = ap.parse_args()
    _root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(_root / "backend"))
    base = args.base.resolve()

    if args.computed_only and args.fastf1_only:
        print("Use at most one of --computed-only / --fastf1-only.", file=sys.stderr)
        return 2
    if args.jobs < 1:
        print("--jobs must be >= 1.", file=sys.stderr)
        return 2

    xz_path = _xz_cli_available()
    prefer_xz_cli = not args.no_xz_cli and xz_path is not None
    if prefer_xz_cli:
        print(f"Using xz CLI ({xz_path}) with multi-threading (-T0 when supported).", flush=True)
    else:
        print(
            "Using Python lzma (single-threaded). Install xz or omit --no-xz-cli for faster runs.",
            flush=True,
        )

    runs: list[tuple[Path, Path, str, tuple[str, ...]]] = []
    if not args.fastf1_only:
        runs.append(
            (
                base / "computed_data",
                base / "compressed_computed_data",
                "computed_data",
                ("*.pkl",),
            )
        )
    if not args.computed_only:
        try:
            from src.lib.fastf1_compressed_cache import abs_fastf1_cache_dir

            ff_src = Path(abs_fastf1_cache_dir())
        except ImportError:
            from src.lib.settings import default_fastf1_cache_user_path

            ff_src = Path(default_fastf1_cache_user_path())
        runs.append(
            (
                ff_src,
                base / "compressed_fastf1-cache",
                "live FastF1 cache",
                ("*.pkl", "*.ff1pkl"),
            )
        )

    total_ok = total_skip = total_err = 0
    for src_root, dest_root, label, patterns in runs:
        print(f"\n=== {label} -> {dest_root.name} ===")
        ok, skipped, er = run_tree(
            src_root,
            dest_root,
            preset=args.preset,
            force=args.force,
            dry_run=args.dry_run,
            prefer_xz_cli=prefer_xz_cli,
            jobs=args.jobs,
            patterns=patterns,
        )
        total_ok += ok
        total_skip += skipped
        total_err += er
        if not args.dry_run:
            print(
                f"  done: {ok} written, {skipped} skipped (already up to date), {er} errors"
            )

    print(
        f"\nTotal: {total_ok} {'planned' if args.dry_run else 'written'}, "
        f"{total_skip} skipped, {total_err} errors"
    )
    return 1 if total_err else 0


if __name__ == "__main__":
    raise SystemExit(main())
