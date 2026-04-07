"""Repository root (layout: ``repo/backend/src/...`` or legacy ``repo/src/...``)."""

from __future__ import annotations

from pathlib import Path


def repo_root() -> str:
    """Absolute path to the repository root (e.g. ``f1-web-local/`` or ``f1-web-server/``)."""
    here = Path(__file__).resolve().parent
    if here.parent.parent.name == "backend":
        return str(here.parent.parent.parent)
    return str(here.parent.parent)
