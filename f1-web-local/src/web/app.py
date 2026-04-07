"""
FastAPI backend: schedule + race replay data using the same code paths as main.py.

Development:

  ./run.sh
  PYTHONPATH=. python3 -m uvicorn src.web.app:app --host 127.0.0.1 --port 8000

Production (single worker recommended — in-memory sessions are per process):

  export CORS_ORIGINS="https://your.domain"
  gunicorn src.web.app:app -k uvicorn.workers.UvicornWorker -w 1 -b 0.0.0.0:8000 \\
    --timeout 300 --graceful-timeout 60 --access-logfile -

For scale, prefer static replay bundles (web/public/data/replays/) + CDN; keep
API workers at 1 or use sticky sessions / external session store.

Environment (optional)
----------------------
CORS_ORIGINS     Comma-separated list; if unset, CORS middleware is disabled (fine for same-origin).
SESSION_TTL_SECONDS   Idle time before a loaded session is dropped (default 86400).
  The client pings /meta periodically so playback from cache still refreshes TTL.
MAX_STORED_SESSIONS   Cap concurrent stored sessions (default 48).
MAX_CONCURRENT_SESSION_LOADS   Parallel POST /api/session/load (default 3).
MAX_FRAMES_PER_REQUEST   Max rows returned per GET .../frames (default 1200).
TRUSTED_HOSTS    Comma-separated Host values (e.g. example.com,*.example.com) or omit.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Literal

# Repository root (parent of src/)
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

from src.f1_data import enable_cache, get_race_weekends_by_year
from src.lib.season import get_season
from src.web.payload import load_race_replay_payload
from src.web.session_store import SessionStore

PUBLIC_DIR = ROOT / "web" / "public"

# Matches web/public/app.js makeReplaySlug: {year}_r{round:02d}_{R|S|Q}
STATIC_REPLAY_SLUG_RE = re.compile(r"^\d{4}_r\d{2}_[RSQ]$")

_session_store = SessionStore(
    ttl_sec=float(os.environ.get("SESSION_TTL_SECONDS", "86400")),
    max_sessions=int(os.environ.get("MAX_STORED_SESSIONS", "48")),
)

_load_semaphore = threading.BoundedSemaphore(
    max(1, int(os.environ.get("MAX_CONCURRENT_SESSION_LOADS", "3")))
)

_MAX_FRAMES_PER_REQUEST = max(100, int(os.environ.get("MAX_FRAMES_PER_REQUEST", "1200")))


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

_cors = os.environ.get("CORS_ORIGINS", "").strip()
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in _cors.split(",") if o.strip()],
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


@app.get("/.well-known/appspecific/com.chrome.devtools.json")
def chrome_devtools_well_known():
    """Quiet Chrome DevTools probe (otherwise StaticFiles returns 404)."""
    return JSONResponse(content={})


@app.get("/api/default-year")
def default_year():
    return {"year": get_season()}


@app.get("/api/schedule/{year}")
def schedule(year: int):
    if year < 1950 or year > 2100:
        raise HTTPException(status_code=400, detail="year out of range")
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
            payload = load_race_replay_payload(
                body.year,
                body.round,
                body.session_type,
                include_race_events=True,
            )
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

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
            "fps": 25,
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


@app.get("/api/static-replay-meta/{slug}")
def static_replay_meta(slug: str):
    """
    Return bundled replay meta if present (avoids client GET /data/replays/.../meta.json 404 noise).
    """
    if not STATIC_REPLAY_SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Invalid replay slug")
    path = PUBLIC_DIR / "data" / "replays" / slug / "meta.json"
    if not path.is_file():
        return {"available": False, "meta": None}
    with open(path, encoding="utf-8") as f:
        meta = json.load(f)
    return {"available": True, "meta": meta}


# Static site (must be after API routes)
if PUBLIC_DIR.is_dir():
    app.mount(
        "/",
        StaticFiles(directory=str(PUBLIC_DIR), html=True),
        name="static",
    )
