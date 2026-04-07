"""
In-memory replay session storage with TTL and LRU eviction.

Production notes
----------------
This store is **per process**. With Gunicorn/Uvicorn, use **--workers 1** unless you
add sticky sessions (same client always hits the same worker) or move storage to
Redis/object storage. Prefer **static replay bundles** under frontend/data/replays/
and a CDN for heavy traffic so the API only serves small JSON metadata.
"""

from __future__ import annotations

import threading
import time
from typing import Any


class SessionStore:
    """Thread-safe sessions keyed by UUID; evict by idle TTL and max count (LRU)."""

    def __init__(self, ttl_sec: float, max_sessions: int) -> None:
        self._ttl = max(60.0, float(ttl_sec))
        self._max = max(1, int(max_sessions))
        self._lock = threading.RLock()
        self._sessions: dict[str, dict[str, Any]] = {}
        # session_id -> (created_monotonic, last_access_monotonic)
        self._meta: dict[str, tuple[float, float]] = {}

    def _now(self) -> float:
        return time.monotonic()

    def _drop(self, sid: str) -> None:
        self._sessions.pop(sid, None)
        self._meta.pop(sid, None)

    def _purge_expired(self) -> None:
        now = self._now()
        for sid in list(self._meta.keys()):
            _, last = self._meta[sid]
            if now - last > self._ttl:
                self._drop(sid)

    def _evict_lru_one(self) -> None:
        if not self._meta:
            return
        sid = min(self._meta.items(), key=lambda x: x[1][1])[0]
        self._drop(sid)

    def get(self, sid: str) -> dict[str, Any] | None:
        with self._lock:
            self._purge_expired()
            if sid not in self._sessions:
                return None
            created, _ = self._meta[sid]
            self._meta[sid] = (created, self._now())
            return self._sessions[sid]

    def put(self, sid: str, data: dict[str, Any]) -> None:
        with self._lock:
            self._purge_expired()
            while len(self._sessions) >= self._max:
                self._evict_lru_one()
            now = self._now()
            self._sessions[sid] = data
            self._meta[sid] = (now, now)

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()
            self._meta.clear()

    def delete(self, sid: str) -> bool:
        """Remove a session immediately (e.g. client navigated away). Returns True if it existed."""
        with self._lock:
            if sid not in self._sessions:
                return False
            self._drop(sid)
            return True

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {"sessions": len(self._sessions)}
