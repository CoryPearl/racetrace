# F1 Race Replay — web server bundle

This folder contains what you need to run the FastAPI + JavaScript replay. It does **not** include the desktop app (Arcade / PySide6), GUI assets, or caches.

## Setup

```bash
python3 -m pip install -r requirements.txt
```

CLI utilities live in `scripts/` (compress caches, prefetch pickles, export static JSON). Run them from the **repository root** with `PYTHONPATH=backend` so `import src.…` resolves (some scripts also adjust `sys.path` themselves).

## Run

```bash
./run.sh
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000) in a browser.

Equivalent (what `run.sh` does):

```bash
export PYTHONPATH="$(pwd)/backend"
python3 -m uvicorn src.web.app:app --host 127.0.0.1 --port 8000
```

For production (many users), prefer **gunicorn** with a single worker unless you add sticky sessions or external session storage — see the module docstring in `backend/src/web/app.py` and comments in `run.sh`. Copy `backend/.env.example` to `backend/.env` and set **Cloudflare R2** credentials if the API should read precomputed JSON from R2 instead of (or in addition to) local `frontend/data/`.

## Caches (created at runtime; not shipped in the repo)

- **FastF1 live cache** — Default is under your user cache (macOS: `~/Library/Caches/f1-race-replay/fastf1`). Override with `cache_location` in `~/.config/f1-race-replay/settings.json` (absolute path, or a path relative to the repo if you use a custom layout). **Stage-2** API pickles can be read from the repo’s **`compressed_fastf1-cache/`** (LZMA) without duplicating plain `.ff1pkl` files next to the live cache.
- **`computed_data/`** — Precomputed telemetry pickles (optional; speeds up loads). You can copy an existing tree if you want.

## Client-side replay bundles (no server-side session memory)

Precompute telemetry with FastF1 as usual (pickles in `computed_data/`), then export JSON the browser can load directly:

```bash
PYTHONPATH=backend python3 scripts/export_static_replay.py --year 2026 --round 1 --session-type R
```

This writes `frontend/data/replays/<slug>/` (`meta.json`, `frames_0.json`, …).

**Slug format:** `{year}_r{round:02d}_{R|S|Q}` — e.g. `2026_r01_R`.

When you choose **Load session** for the same year / round / session type, the app fetches `/data/replays/<slug>/meta.json` and chunk files — no `POST /api/session/load`. If no bundle exists, it falls back to the API (server loads frames into memory).

Large JSON files are gitignored; keep bundles local or ship them separately.

## Prefetch pickles for a whole season (Python only)

This project targets **2026** by default. Precompute telemetry pickles for that season.

**Only the first three races** (rounds 1–3):

```bash
PYTHONPATH=backend python3 scripts/prefetch_all_race_telemetry.py --year 2026 --first-n-rounds 3 --workers 4
```

Same thing as `--start-round 1 --end-round 3`. Omit `--first-n-rounds` to prefetch the full calendar (subject to future-weekend skipping).

**Full season** (all rounds that have happened):

```bash
PYTHONPATH=backend python3 scripts/prefetch_all_race_telemetry.py --year 2026 --workers 4
```

Race + sprint (where applicable) + **qualifying** by default.

```bash
PYTHONPATH=backend python3 scripts/prefetch_all_race_telemetry.py --year 2026 --no-qualifying
```

Skip Q if you only need race/sprint.

```bash
PYTHONPATH=backend python3 scripts/prefetch_all_race_telemetry.py --year 2026 --qualifying-only
```

Only Q pickles — use when race/sprint data is already computed.

For an **incomplete season** (e.g. current year), the script **skips weekends whose `EventDate` is still in the future** — there is no telemetry yet, so those jobs would fail. Use `--include-future-rounds` only if you intentionally want to attempt them.

`prefetch_all_years.py` runs **one season per invocation**; by default it only runs **2026** (see `--start-year` / `--end-year` to prefetch multiple years):

```bash
PYTHONPATH=backend python3 scripts/prefetch_all_years.py --workers 2
```
