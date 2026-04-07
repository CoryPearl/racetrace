"""
FastF1 stage-2 cache: **authoritative** store is
``../f1-web-server/backend/compressed_fastf1-cache/*.ff1pkl.xz`` from ``f1-web-local/`` (override with env).

- **Reads**: Prefer LZMA stream from ``.xz``; legacy plain ``.ff1pkl`` is migrated to ``.xz`` and
  then **deleted**.
- **Writes** (after download): Only **compressed** files are kept under ``compressed_fastf1-cache``;
  any plain ``.ff1pkl`` at the FastF1 path is removed.

The live ``cache_location`` directory holds empty session folders FastF1 creates; stage-2
pickles are not kept there long-term. Raw HTTP responses are not cached (``use_requests_cache=False``).
"""
from __future__ import annotations

import functools
import inspect
import lzma
import os
import pickle
import sys

from src.lib.repo_paths import repo_root
from src.lib.settings import default_fastf1_cache_user_path, get_settings

_patch_installed = False
_logged_compressed_read = False

_LZMA_PRESET = 3


def _fastf1_offline_only() -> bool:
    """
    When True, never call FastF1 live API for stage-2 cache misses — only ``compressed_fastf1-cache``
    (and legacy plain ``.ff1pkl``). Use when the machine has a full local mirror and must not
    phone home. Set ``FASTF1_OFFLINE_ONLY=1``.
    """
    return os.environ.get("FASTF1_OFFLINE_ONLY", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _offline_or_live(func, api_path, func_kwargs, *, detail: str):
    if _fastf1_offline_only():
        raise RuntimeError(
            "FASTF1_OFFLINE_ONLY is set but no usable compressed_fastf1-cache entry for this "
            f"request ({detail}). Add the matching ``.ff1pkl.xz`` under compressed_fastf1-cache "
            "or unset FASTF1_OFFLINE_ONLY."
        )
    return func(api_path, **func_kwargs)


def _primary_compressed_root() -> str:
    """
    Default: ``../f1-web-server/backend/compressed_fastf1-cache`` (same as the server bundle).
    Override with ``COMPRESSED_FASTF1_CACHE_DIR`` or ``F1_COMPRESSED_FASTF1_REL``.
    """
    env = (os.environ.get("COMPRESSED_FASTF1_CACHE_DIR") or "").strip()
    if env:
        return os.path.normpath(os.path.expanduser(env))
    rel = (
        os.environ.get("F1_COMPRESSED_FASTF1_REL")
        or "../f1-web-server/backend/compressed_fastf1-cache"
    ).strip()
    return os.path.normpath(os.path.join(repo_root(), rel))


def abs_fastf1_cache_dir() -> str:
    """Absolute path to the FastF1 live cache (default: user profile ``.../f1-race-replay/fastf1``)."""
    env_override = (os.environ.get("FASTF1_CACHE_DIR") or "").strip()
    if env_override:
        return os.path.normpath(os.path.expanduser(env_override))
    raw = (get_settings().cache_location or "").strip()
    if not raw:
        return default_fastf1_cache_user_path()
    if os.path.isabs(raw):
        return os.path.normpath(os.path.expanduser(raw))
    return os.path.normpath(os.path.join(repo_root(), raw))


def compressed_fastf1_cache_dirs() -> list[str]:
    """
    Search roots for ``*.ff1pkl.xz`` (``scripts/compress_fastf1_cache.py`` output).

    Includes ``compressed_fastf1-cache`` under the repo and next to the live FastF1 cache dir
    (when ``cache_location`` points outside the repo).
    """
    cd = abs_fastf1_cache_dir()
    parent = os.path.dirname(cd) or repo_root()
    backend_mirror = os.path.normpath(
        os.path.join(repo_root(), "..", "f1-web-server", "backend", "compressed_fastf1-cache")
    )
    candidates = [
        _primary_compressed_root(),
        backend_mirror,
        os.path.join(parent, "compressed_fastf1-cache"),
        os.path.join(repo_root(), "compressed_fastf1-cache"),
    ]
    seen: set[str] = set()
    out: list[str] = []
    for p in candidates:
        n = os.path.normpath(p)
        if n not in seen:
            seen.add(n)
            out.append(p)
    return out


def _find_xz_for_stage2_path(cache_file_path: str, cache_dir: str) -> str | None:
    """Return path to ``.ff1pkl.xz`` if present under a compressed root."""
    try:
        rel = os.path.relpath(cache_file_path, cache_dir)
    except ValueError:
        return None
    rel_posix = rel.replace("\\", "/")
    if rel_posix.startswith(".."):
        return None
    for croot in compressed_fastf1_cache_dirs():
        xz_path = os.path.join(croot, f"{rel_posix}.xz")
        if os.path.isfile(xz_path):
            return xz_path
    return None


def _dump_stage2_to_xz(obj: object, xz_path: str) -> None:
    os.makedirs(os.path.dirname(xz_path) or ".", exist_ok=True)
    with lzma.open(
        xz_path,
        "wb",
        format=lzma.FORMAT_XZ,
        preset=_LZMA_PRESET,
    ) as f:
        pickle.dump(obj, f, protocol=pickle.HIGHEST_PROTOCOL)


def _migrate_plain_to_compressed_then_remove_plain(
    cache_file_path: str,
    cached_obj: object,
    cache_dir: str,
) -> None:
    """
    Ensure ``<repo>/compressed_fastf1-cache/<rel>.ff1pkl.xz`` exists with ``cached_obj``,
    then delete the plain ``cache_file_path`` if present.
    """
    try:
        rel = os.path.relpath(cache_file_path, cache_dir)
    except ValueError:
        return
    rel_posix = rel.replace("\\", "/")
    if rel_posix.startswith(".."):
        return
    xz_primary = os.path.join(_primary_compressed_root(), f"{rel_posix}.xz")
    if not os.path.isfile(xz_primary):
        _dump_stage2_to_xz(cached_obj, xz_primary)
    if os.path.isfile(cache_file_path):
        try:
            os.unlink(cache_file_path)
        except OSError:
            pass


def _patched_write_cache(cls, data, cache_file_path, **kwargs):
    """Write stage-2 cache only as ``.ff1pkl.xz`` under ``compressed_fastf1-cache``; drop plain."""
    new_cached = dict(
        **{"version": cls._API_CORE_VERSION, "data": data},
        **kwargs,
    )
    cache_dir = cls._CACHE_DIR
    if not cache_dir:
        return
    if os.path.isfile(cache_file_path):
        try:
            os.unlink(cache_file_path)
        except OSError:
            pass
    try:
        rel = os.path.relpath(cache_file_path, cache_dir)
    except ValueError:
        return
    rel_posix = rel.replace("\\", "/")
    if rel_posix.startswith(".."):
        return
    xz_path = os.path.join(_primary_compressed_root(), f"{rel_posix}.xz")
    _dump_stage2_to_xz(new_cached, xz_path)


def _redwrap_fastf1_api_cached_functions(fr) -> None:
    """
    FastF1 decorates ``fastf1._api`` functions with ``@Cache.api_request_wrapper`` at import
    time. Replacing ``Cache.api_request_wrapper`` on the class does not update those existing
    closures, so stage-2 cache would still use FastF1's original logic (plain ``.ff1pkl``
    only) and never read ``compressed_fastf1-cache``. Re-apply the decorator to each wrapped
    function so our wrapper (LZMA + patched write) is actually used.
    """
    if "fastf1._api" not in sys.modules:
        return
    import fastf1._api as api_module

    for name in list(api_module.__dict__):
        obj = getattr(api_module, name)
        if not inspect.isfunction(obj):
            continue
        try:
            inner = inspect.unwrap(obj)
        except (ValueError, AttributeError):
            continue
        if inner is obj:
            continue
        # Only ``@Cache.api_request_wrapper`` targets take ``(path, ...)``. Helpers such as
        # ``_align_laps`` are wrapped only by ``@soft_exceptions``; re-wrapping them breaks
        # calls like ``_align_laps(laps_df, stream_df)`` (TypeError: one arg expected).
        try:
            sig = inspect.signature(inner)
            first = next(iter(sig.parameters.values()), None)
            if first is None or first.name != "path":
                continue
        except (ValueError, TypeError):
            continue
        try:
            new_fn = fr.Cache.api_request_wrapper(inner)
        except TypeError:
            continue
        setattr(api_module, name, new_fn)


def install_fastf1_compressed_cache_patch() -> None:
    """Patch FastF1 stage-2 read/write to use LZMA under ``compressed_fastf1-cache`` only."""
    global _patch_installed, _logged_compressed_read
    if _patch_installed:
        return
    import fastf1.req as fr

    fr.Cache._write_cache = classmethod(_patched_write_cache)

    def api_request_wrapper(cls, func):
        @functools.wraps(func)
        def _cached_api_request(api_path, **func_kwargs):
            global _logged_compressed_read

            if cls._CACHE_DIR and not cls._tmp_disabled:
                func_name = str(func.__name__)
                cache_file_path = cls._get_cache_file_path(api_path, func_name)
                cache_dir = cls._CACHE_DIR

                if cls._ci_mode:
                    return func(api_path, **func_kwargs)

                # 1) Compressed mirror (stream — no plain file)
                xz_path = _find_xz_for_stage2_path(cache_file_path, cache_dir)
                if xz_path:
                    try:
                        cached = pickle.load(lzma.open(xz_path, "rb"))
                    except Exception:  # noqa: BLE001
                        cached = None
                    if cached is not None and cls._data_ok_for_use(cached):
                        if not _logged_compressed_read:
                            print(
                                "FastF1: stage-2 cache from "
                                f"compressed_fastf1-cache (e.g. {os.path.basename(xz_path)})",
                                flush=True,
                            )
                            _logged_compressed_read = True
                        fr._logger.info(f"Using compressed cache for {func_name}")
                        if os.path.isfile(cache_file_path):
                            try:
                                os.unlink(cache_file_path)
                            except OSError:
                                pass
                        return cached["data"]
                    if cached is not None and not cls._data_ok_for_use(cached):
                        fr._logger.info(f"Updating cache for {func_name}...")
                        data = _offline_or_live(
                            func,
                            api_path,
                            func_kwargs,
                            detail=f"{func_name} .ff1pkl.xz version mismatch: {xz_path}",
                        )
                        if data is not None:
                            _patched_write_cache(cls, data, cache_file_path)
                            fr._logger.info("Cache updated!")
                            return data
                        fr._logger.critical(
                            "A cache update is required but the data failed "
                            "to download. Cannot continue!\nYou may force to "
                            "ignore a cache version mismatch by using the "
                            "`ignore_version=True` keyword when enabling the "
                            "cache (not recommended)."
                        )
                        sys.exit(1)

                # 2) Legacy plain .ff1pkl — migrate to .xz, then delete plain
                if os.path.isfile(cache_file_path):
                    try:
                        cached = pickle.load(open(cache_file_path, "rb"))
                    except Exception:  # noqa: BLE001
                        cached = None
                    if cached is not None and cls._data_ok_for_use(cached):
                        fr._logger.info(f"Using cached data for {func_name}")
                        _migrate_plain_to_compressed_then_remove_plain(
                            cache_file_path,
                            cached,
                            cache_dir,
                        )
                        return cached["data"]
                    if cached is not None and not cls._data_ok_for_use(cached):
                        fr._logger.info(f"Updating cache for {func_name}...")
                        data = _offline_or_live(
                            func,
                            api_path,
                            func_kwargs,
                            detail=f"{func_name} plain .ff1pkl version mismatch: {cache_file_path}",
                        )
                        if data is not None:
                            _patched_write_cache(cls, data, cache_file_path)
                            fr._logger.info("Cache updated!")
                            return data
                        fr._logger.critical(
                            "A cache update is required but the data failed "
                            "to download. Cannot continue!\nYou may force to "
                            "ignore a cache version mismatch by using the "
                            "`ignore_version=True` keyword when enabling the "
                            "cache (not recommended)."
                        )
                        sys.exit(1)
                    # cached is None (corrupt) — fall through to download

                fr._logger.info(
                    f"No cached data found for {func_name}. Loading data..."
                )
                data = _offline_or_live(
                    func,
                    api_path,
                    func_kwargs,
                    detail=f"{func_name} miss: {cache_file_path}",
                )
                if data is not None:
                    _patched_write_cache(cls, data, cache_file_path)
                    fr._logger.info("Data has been written to cache!")
                    return data
                fr._logger.critical("Failed to load data!")
                sys.exit(1)

            else:
                if not cls._tmp_disabled:
                    cls._enable_default_cache()
                return _offline_or_live(
                    func,
                    api_path,
                    func_kwargs,
                    detail=f"{func.__name__}: cache disabled or no _CACHE_DIR",
                )

        return _cached_api_request

    fr.Cache.api_request_wrapper = classmethod(api_request_wrapper)
    _redwrap_fastf1_api_cached_functions(fr)
    _patch_installed = True
