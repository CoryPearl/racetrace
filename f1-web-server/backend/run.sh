#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONPATH="$(pwd)/backend"
# Dev: single uvicorn process (serves API + optional local frontend/ — see src/web/app.py).
#
# Production (many users): use gunicorn with 1 worker unless you add sticky
# sessions or external session storage — see backend/src/web/app.py module docstring.
# Example:
#   export CORS_ORIGINS="https://your.domain"
#   exec gunicorn src.web.app:app -k uvicorn.workers.UvicornWorker -w 1 \\
#     -b 0.0.0.0:8000 --timeout 300 --graceful-timeout 60 --access-logfile -
exec python3 -m uvicorn src.web.app:app --host 127.0.0.1 --port 8000 "$@"
