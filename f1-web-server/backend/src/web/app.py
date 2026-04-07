"""
FastAPI backend: schedule + race replay data using the same code paths as main.py.

Development:

  ./run.sh
  PYTHONPATH=backend python3 -m uvicorn src.web.app:app --host 127.0.0.1 --port 8000

Production (single worker recommended — in-memory sessions are per process):

  export CORS_ORIGINS="https://your.domain"
  gunicorn src.web.app:app -k uvicorn.workers.UvicornWorker -w 1 -b 0.0.0.0:8000 \\
    --timeout 300 --graceful-timeout 60 --access-logfile -

For scale, prefer static replay bundles (``<static>/data/replays/``) + CDN; keep
API workers at 1 or use sticky sessions / external session store.

Disk data (same search order as ``f1-web-local``)
-----------------------------------------------
``compressed_fastf1-cache/`` (under ``f1-web-server/`` repo root) — FastF1 stage-2 ``*.ff1pkl.xz``
  (primary mirror; also ``backend/compressed_fastf1-cache`` is searched). Optional
  ``COMPRESSED_FASTF1_CACHE_DIR`` for a custom root.

``backend/compressed_computed_data/`` — LZMA telemetry pickles (``*.pkl.xz``; optional plain
``.pkl`` in the same tree). Override base dir with ``settings.json`` → ``computed_data_location``.

Environment (optional)
----------------------
CORS_ORIGINS     Comma-separated allowed browser origins (e.g. your Vercel URL). If unset, common
  local dev origins are allowed (Live Server :5500, Vite :5173) so ``fetch`` from another port works.
  Set explicitly in production. Use CORS_ORIGINS=0 to disable CORS middleware entirely.
SESSION_TTL_SECONDS   Idle time before a loaded session is dropped (default 86400).
  The client pings /meta periodically so playback from cache still refreshes TTL.
MAX_STORED_SESSIONS   Cap concurrent stored sessions (default 48).
MAX_CONCURRENT_SESSION_LOADS   Parallel POST /api/session/load (default 3).
MAX_FRAMES_PER_REQUEST   Max rows returned per GET .../frames (default 1200).
TRUSTED_HOSTS    Comma-separated Host values (e.g. example.com,*.example.com) or omit.
SERVE_FRONTEND   If 0/false/no, do not mount the static site folder (API + /data only).

STATIC_SITE_DIR  Optional absolute path to the static site root (index.html, app.js, data/).
  If unset: use ``frontend/`` when present, else ``web/public/`` (same layout as f1-web-local).

FASTF1_CACHE_DIR   FastF1 live cache (default: user profile, same as local). Used with
  ``compressed_fastf1-cache`` relpath lookup.

COMPRESSED_FASTF1_CACHE_DIR  Root folder containing the mirrored ``*.ff1pkl.xz`` tree (same layout as
  under the live cache). Searched first for reads (not only writes).

FASTF1_CACHE_IGNORE_VERSION  If 1/true/yes, load compressed/plain pickles even when their FastF1
  API core version differs (may mis-parse old data; use after upgrading FastF1 until you recompress).

PRECOMPUTED_REPLAY_LOAD_FASTF1_LAPS  Default 1: when serving from ``compressed_computed_data`` pickle,
  still load FastF1 lap timing only (uses ``compressed_fastf1-cache``) for metadata/rotation — not car
  telemetry. Set 0 to skip FastF1 entirely for that path (legacy).

PRECOMPUTED_REPLAY_TRACK_TELEMETRY  Default 1: after lap-only load, also ``load(telemetry=True)`` so
  track outline / DRS zones use dense FastF1 lap telemetry (cache-backed). Set 0 to build track from
  replay frames only (lighter, rougher).

FASTF1_OFFLINE_ONLY  If 1/true/yes, never call the live API for FastF1 stage-2 cache misses — only
  ``compressed_fastf1-cache`` (and legacy plain .ff1pkl). Requires disk cache enabled and a full mirror.

STATIC_REPLAY_FALLBACK_AFTER_MISS  Default 1: if no ``data/replays/<slug>/`` on disk under the static
  site, compute via FastF1 (``load_race_replay_payload``). Set to 0 to 404 instead.
  Alias: ``FASTF1_FALLBACK_AFTER_R2_MISS`` (deprecated name, same behavior).

Load ``backend/.env`` or repo-root ``.env`` when present (python-dotenv).
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Literal

_app = Path(__file__).resolve()
if _app.parents[2].name == "backend":
    BACKEND_ROOT = _app.parents[2]
    REPO_ROOT = _app.parents[3]
    _path_for_src = BACKEND_ROOT
else:
    BACKEND_ROOT = _app.parents[1]
    REPO_ROOT = _app.parents[2]
    _path_for_src = REPO_ROOT

for _env in (REPO_ROOT / ".env", REPO_ROOT / "backend" / ".env"):
    if _env.is_file():
        load_dotenv(_env)

if str(_path_for_src) not in sys.path:
    sys.path.insert(0, str(_path_for_src))
os.chdir(REPO_ROOT)

from src.f1_data import data_storage_paths, enable_cache, get_race_weekends_by_year

# Before payload (session loads): enable FastF1 cache + compressed_fastf1-cache LZMA patch.
enable_cache()

from src.lib.season import get_season
from src.lib.static_replay_bundle import load_static_replay_bundle, replay_slug
from src.web.payload import load_race_replay_payload
from src.web.session_store import SessionStore


def _resolve_public_dir() -> Path:
    override = os.environ.get("STATIC_SITE_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    fe = REPO_ROOT / "frontend"
    wp = REPO_ROOT / "web" / "public"
    if fe.is_dir():
        return fe
    if wp.is_dir():
        return wp
    return fe


PUBLIC_DIR = _resolve_public_dir()

# Matches app.js makeReplaySlug: {year}_r{round:02d}_{R|S|Q}
STATIC_REPLAY_SLUG_RE = re.compile(r"^\d{4}_r\d{2}_[RSQ]$")

_session_store = SessionStore(
    ttl_sec=float(os.environ.get("SESSION_TTL_SECONDS", "86400")),
    max_sessions=int(os.environ.get("MAX_STORED_SESSIONS", "48")),
)

_load_semaphore = threading.BoundedSemaphore(
    max(1, int(os.environ.get("MAX_CONCURRENT_SESSION_LOADS", "3")))
)

_MAX_FRAMES_PER_REQUEST = max(100, int(os.environ.get("MAX_FRAMES_PER_REQUEST", "1200")))


def _static_replay_fallback_after_miss() -> bool:
    """If no static replay folder, call FastF1 (default). Set STATIC_REPLAY_FALLBACK_AFTER_MISS=0 to 404."""
    v = os.environ.get(
        "STATIC_REPLAY_FALLBACK_AFTER_MISS",
        os.environ.get("FASTF1_FALLBACK_AFTER_R2_MISS", "1"),
    ).strip().lower()
    return v not in ("0", "false", "no")


def _parse_session_id(session_id: str) -> str:
    try:
        return str(uuid.UUID(session_id))
    except ValueError as e:
        raise HTTPException(status_code=400, detail="Invalid session id") from e


@asynccontextmanager
async def lifespan(_: FastAPI):
    enable_cache()
    yield
    _session_store.clear()


app = FastAPI(title="F1 Race Replay Web", lifespan=lifespan)

_th = os.environ.get("TRUSTED_HOSTS", "").strip()
if _th:
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=[h.strip() for h in _th.split(",") if h.strip()],
    )

def _cors_origins() -> list[str] | None:
    """
    Return allowed origins for CORSMiddleware, or None to skip the middleware.

    Cross-origin fetches (e.g. Live Server on :5500 calling API on :8000) need explicit origins.
    """
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    if raw in ("0", "false", "no", "off"):
        return None
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    # Default: local dev frontends on a different port than the API
    return [
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ]


_cors_list = _cors_origins()
if _cors_list is not None:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "HEAD", "OPTIONS"],
        allow_headers=["*"],
        max_age=600,
    )


@app.middleware("http")
async def production_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    p = request.url.path
    if p.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif p.startswith("/data/replays/"):
        response.headers.setdefault(
            "Cache-Control", "public, max-age=86400"
        )
    elif p.startswith("/data/"):
        response.headers.setdefault(
            "Cache-Control", "public, max-age=86400"
        )
    elif p.endswith((".js", ".css")):
        # Always revalidate (fixes stale view3d.js / app.js after deploy or local edits).
        response.headers["Cache-Control"] = "no-cache"
    elif p in ("/", "/index.html") or p.endswith(".html"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


class LoadSessionBody(BaseModel):
    year: int = Field(..., ge=1950, le=2100, description="Season year")
    round: int = Field(..., ge=1, le=35, description="Championship round number")
    session_type: Literal["R", "S", "Q"] = Field(
        "R",
        description="R = Grand Prix, S = Sprint, Q = Qualifying",
    )


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/health/data")
def health_data():
    """Resolved paths for telemetry pickles, FastF1 stage-2 LZMA cache, and static site root."""
    ds = data_storage_paths()
    return {
        "ok": True,
        "repo_root": str(REPO_ROOT),
        "public_dir": str(PUBLIC_DIR),
        "computed_data": ds["computed_data"],
        "compressed_computed_data": ds["compressed_computed_data"],
        "fastf1_live_cache": ds["fastf1_live_cache"],
        "compressed_fastf1_cache_roots": ds["compressed_fastf1_cache_roots"],
    }


@app.get("/.well-known/appspecific/com.chrome.devtools.json")
def chrome_devtools_well_known():
    """Quiet Chrome DevTools probe (otherwise StaticFiles returns 404)."""
    return JSONResponse(content={})


@app.get("/api/default-year")
def default_year():
    path = PUBLIC_DIR / "data" / "default-year.json"
    if path.is_file():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {"year": get_season()}


@app.get("/api/schedule/{year}")
def schedule(year: int):
    if year < 1950 or year > 2100:
        raise HTTPException(status_code=400, detail="year out of range")
    path = PUBLIC_DIR / "data" / "schedule" / f"{year}.json"
    if path.is_file():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    try:
        weekends = get_race_weekends_by_year(year)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    for w in weekends:
        w["year"] = year
    return {"year": year, "events": weekends}


@app.post("/api/session/load")
def load_session_route(body: LoadSessionBody):
    acquired = _load_semaphore.acquire(blocking=False)
    if not acquired:
        raise HTTPException(
            status_code=503,
            detail="Server is busy loading sessions; try again in a few seconds.",
        )
    try:
        try:
            payload = load_static_replay_bundle(
                PUBLIC_DIR, body.year, body.round, body.session_type
            )
            if payload is None:
                if not _static_replay_fallback_after_miss():
                    raise HTTPException(
                        status_code=404,
                        detail=(
                            "No static replay under "
                            f"data/replays/{replay_slug(body.year, body.round, body.session_type)!r}/ "
                            "(meta.json + frames_*.json). "
                            "Export with scripts/export_static_replay.py, or set "
                            "STATIC_REPLAY_FALLBACK_AFTER_MISS=1 to compute via FastF1."
                        ),
                    )
                payload = load_race_replay_payload(
                    body.year,
                    body.round,
                    body.session_type,
                    include_race_events=True,
                )
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

        fps = int(payload.pop("fps", 25))
        frames = payload.pop("frames")
        payload.pop("session", None)

        sid = str(uuid.uuid4())
        _session_store.put(
            sid,
            {
                "frames": frames,
                "driver_colors": payload["driver_colors"],
                "driver_teams": payload["driver_teams"],
                "track_statuses": payload["track_statuses"],
                "total_laps": payload["total_laps"],
                "max_tyre_life": payload["max_tyre_life"],
                "tyre_expected_laps": payload.get("tyre_expected_laps") or {},
                "circuit_rotation": payload["circuit_rotation"],
                "session_info": payload["session_info"],
                "track": payload["track"],
                "race_events": payload["race_events"],
            },
        )

        return {
            "session_id": sid,
            "fps": fps,
            "total_frames": len(frames),
            "driver_colors": payload["driver_colors"],
            "driver_teams": payload["driver_teams"],
            "track_statuses": payload["track_statuses"],
            "total_laps": payload["total_laps"],
            "max_tyre_life": payload["max_tyre_life"],
            "tyre_expected_laps": payload.get("tyre_expected_laps") or {},
            "circuit_rotation": payload["circuit_rotation"],
            "session_info": payload["session_info"],
            "track": payload["track"],
            "race_events": payload["race_events"],
        }
    finally:
        _load_semaphore.release()


@app.get("/api/session/{session_id}/frames")
def get_frames(session_id: str, start: int = 0, end: int | None = None):
    sid = _parse_session_id(session_id)
    data = _session_store.get(sid)
    if not data:
        raise HTTPException(status_code=404, detail="Unknown or expired session")

    frames = data["frames"]
    n = len(frames)
    if start < 0 or start >= n:
        raise HTTPException(
            status_code=400, detail=f"start out of range (0..{n - 1})"
        )
    if end is None:
        end = min(n, start + _MAX_FRAMES_PER_REQUEST)
    else:
        end = min(int(end), n)
    cap = start + _MAX_FRAMES_PER_REQUEST
    if end > cap:
        end = cap
    if end <= start:
        raise HTTPException(status_code=400, detail="end must be greater than start")

    return {
        "start": start,
        "end": end,
        "frames": frames[start:end],
    }


@app.get("/api/session/{session_id}/meta")
def get_meta(session_id: str):
    sid = _parse_session_id(session_id)
    data = _session_store.get(sid)
    if not data:
        raise HTTPException(status_code=404, detail="Unknown or expired session")
    frames = data["frames"]
    return {
        "total_frames": len(frames),
        "driver_colors": data["driver_colors"],
        "driver_teams": data.get("driver_teams") or {},
        "track_statuses": data["track_statuses"],
        "total_laps": data["total_laps"],
        "max_tyre_life": data["max_tyre_life"],
        "tyre_expected_laps": data.get("tyre_expected_laps") or {},
        "circuit_rotation": data["circuit_rotation"],
        "session_info": data["session_info"],
        "track": data["track"],
        "race_events": data["race_events"],
    }


def _load_static_replay_meta_json(slug: str) -> dict | None:
    path = PUBLIC_DIR / "data" / "replays" / slug / "meta.json"
    if path.is_file():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


@app.get("/api/static-replay-meta/{slug}")
def static_replay_meta(slug: str):
    """
    Return bundled replay meta if present (avoids client GET /data/replays/.../meta.json 404 noise).
    """
    if not STATIC_REPLAY_SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Invalid replay slug")
    meta = _load_static_replay_meta_json(slug)
    if meta is None:
        return {"available": False, "meta": None}
    return {"available": True, "meta": meta}


@app.get("/data/{path:path}")
def serve_data(path: str):
    """Precomputed JSON under ``<static>/data`` (local files only)."""
    if path.startswith(("/", "\\")) or ".." in path:
        raise HTTPException(status_code=400, detail="Invalid path")
    rel = path.replace("\\", "/").strip("/")
    local = PUBLIC_DIR / "data" / rel
    if not local.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    media, _ = mimetypes.guess_type(rel)
    return FileResponse(local, media_type=media or "application/octet-stream")


_serve_fe = os.environ.get("SERVE_FRONTEND", "1").strip().lower() not in (
    "0",
    "false",
    "no",
)

# Static site (must be after API routes)
if _serve_fe and PUBLIC_DIR.is_dir():
    app.mount(
        "/",
        StaticFiles(directory=str(PUBLIC_DIR), html=True),
        name="static",
    )
