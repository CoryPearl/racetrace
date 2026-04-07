/**
 * Browser race replay — mirrors src/interfaces/race_replay.py timing (25 FPS).
 */

const FPS = 25;
const PLAYBACK_SPEEDS = [0.1, 0.2, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];

/**
 * Backend origin for `/api/*` only (see config.js).
 * `/data/*` JSON (schedule, default-year, static replay chunks) is served from the
 * same origin as this page — e.g. Vercel `frontend/data/` — not from the API host.
 */
function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  if (p.startsWith('/data/')) return p;
  const base =
    typeof window !== 'undefined' && window.__API_BASE__ != null
      ? String(window.__API_BASE__).replace(/\/$/, '')
      : '';
  return base ? `${base}${p}` : p;
}

/** Merge ngrok header into fetch init (skips interstitial on tunneled API responses). */
function defaultFetchInit(init) {
  const ngrok = { 'ngrok-skip-browser-warning': 'true' };
  if (init == null || typeof init !== 'object') {
    return { headers: { ...ngrok } };
  }
  const merged = { ...init };
  if (init.headers instanceof Headers) {
    const h = new Headers(init.headers);
    h.set('ngrok-skip-browser-warning', 'true');
    merged.headers = h;
  } else {
    merged.headers = { ...ngrok, ...(init.headers || {}) };
  }
  return merged;
}

const CHUNK_SIZE = 600;
/** How many chunk files to warm ahead of the playhead (scaled by playback speed). */
const PREFETCH_MIN_CHUNKS_AHEAD = 2;
const PREFETCH_MAX_CHUNKS_AHEAD = 5;
/** Fallback if meta.json lacks tyre_expected_laps (must match src/lib/tyres.py) */
const DEFAULT_TYRE_EXPECTED_LAPS = { 0: 22, 1: 35, 2: 55, 3: 28, 4: 38 };
/** @returns {{ left: number, right: number }} Horizontal insets so the 2D track sits in the visible map column (measured; no fixed px). */
function getTrackUiMarginsPx() {
  if (typeof window === 'undefined') return { left: 0, right: 0 };
  if (window.matchMedia('(max-width: 900px)').matches) {
    return { left: 0, right: 0 };
  }
  const sidebar = document.querySelector('#app > .sidebar');
  const lb = document.getElementById('leaderboard');
  let left = 0;
  let right = 0;
  if (sidebar) left = Math.round(sidebar.getBoundingClientRect().width);
  if (lb) right = Math.round(lb.getBoundingClientRect().width);
  return { left, right };
}

/** Track outline by session status — grayscale only */
const STATUS_COLORS = {
  GREEN: [145, 145, 145],
  YELLOW: [175, 175, 165],
  STOPPED: [88, 88, 88],
  VSC: [125, 125, 125],
  SC: [105, 105, 105],
};

const TYRE_LABELS = ['SOFT', 'MEDIUM', 'HARD', 'INTER', 'WET'];

function tyreCompoundName(t) {
  const i = Math.round(Number(t));
  if (i < 0 || i >= TYRE_LABELS.length) return '—';
  return TYRE_LABELS[i];
}

/** FastF1 DRS: 8/10+ = open (green ON); anything else = OFF (red). */
function applyTelDrs(el, drs) {
  if (!el) return;
  const v = Number(drs);
  if (!Number.isFinite(v)) {
    el.textContent = '—';
    el.classList.remove('tel-drs-on', 'tel-drs-off');
    return;
  }
  const on = v >= 8;
  el.textContent = on ? 'ON' : 'OFF';
  el.classList.toggle('tel-drs-on', on);
  el.classList.toggle('tel-drs-off', !on);
}

/** Meteorological wind direction (degrees) → 16-point compass */
const WIND_COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

function celsiusToFahrenheit(c) {
  return (c * 9) / 5 + 32;
}

/** Track / air temps from session data (°C) with matching °F */
function formatTempCelsiusFahrenheit(c) {
  if (c == null || !Number.isFinite(Number(c))) return '—';
  const cNum = Number(c);
  const f = celsiusToFahrenheit(cNum);
  return `${cNum.toFixed(1)}°C · ${f.toFixed(1)}°F`;
}

function formatHumidityPct(h) {
  if (h == null || !Number.isFinite(Number(h))) return '—';
  return `${Number(h).toFixed(1)}%`;
}

function windCompassFromDeg(deg) {
  if (deg == null || !Number.isFinite(Number(deg))) return '';
  const d = ((Number(deg) % 360) + 360) % 360;
  const i = Math.round(d / 22.5) % 16;
  return WIND_COMPASS[i];
}

/** Wind speed from FastF1 weather (m/s); direction = degrees (from) */
function formatWindLine(speedMps, directionDeg) {
  const from = windCompassFromDeg(directionDeg);
  if (speedMps == null || !Number.isFinite(Number(speedMps))) {
    return from ? `— (${from})` : '—';
  }
  const mps = Number(speedMps);
  const mph = mps * 2.2369362920544;
  const dirPart = from ? ` · ${from}` : '';
  return `${mps.toFixed(1)} m/s · ${mph.toFixed(1)} mph${dirPart}`;
}

/** Throttle/brake: FastF1 uses 0–1 or 0–100; show as 0–100% */
function pct(x) {
  let n = Number(x);
  if (!Number.isFinite(n)) return '—';
  if (n > 0 && n <= 1) n *= 100;
  const r = Math.round(n);
  return `${Math.min(100, Math.max(0, r))}%`;
}

/** 0–100 for throttle / brake bar width */
function inputPct01(x) {
  let n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n <= 1) n *= 100;
  return Math.min(100, Math.max(0, n));
}

/** @type {string | null} */
let sessionId = null;
/** @type {any} */
let sessionMeta = null;
let totalFrames = 0;
/** @type {Map<number, any[]>} chunkStart -> frames */
const chunkCache = new Map();
/** @type {Map<number, Promise<void>>} in-flight chunk fetches (dedupe parallel loads) */
const chunkInflight = new Map();

let frameIndex = 0;
let paused = true;
let playbackSpeed = 1;
let lastTs = 0;
/** Telemetry sample rate for this session (matches chunk spacing / blend). */
let sessionFps = FPS;

/** 2D map only: avoid recomputing bounds scan every rAF frame. */
let cachedScreenTransform = null;
let cachedScreenTransformKey = '';

/** Refreshes server session TTL while tab plays from cached chunks (no /frames calls). */
let lastSessionKeepaliveMs = 0;
const SESSION_KEEPALIVE_MS = 4 * 60 * 1000;
let sessionGoneHandled = false;

const canvas = document.getElementById('track-canvas');
const ctx = canvas.getContext('2d');

/**
 * Bump this when editing view3d.js so `import()` uses a new URL (separate module cache entry).
 * Server also sends Cache-Control: no-cache for .js — restart uvicorn after changing app.py.
 */
const VIEW3D_MODULE_VER = '102';

/** @type {Awaited<ReturnType<typeof import('./view3d.js').createTrackView3D>> | null} */
let trackView3d = null;
/** @type {Promise<NonNullable<typeof trackView3d>> | null} */
let trackView3dPromise = null;
/** @type {any} */
let metaBuiltFor3d = null;

const elYear = document.getElementById('year-input');
const scheduleStatus = document.getElementById('schedule-status');
const eventSelect = document.getElementById('event-select');
const sessionPanel = document.getElementById('session-panel');
const btnLoad = document.getElementById('btn-load');
const loadStatus = document.getElementById('load-status');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const sessionBanner = document.getElementById('session-banner');
const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const speedSelect = document.getElementById('speed-select');
const scrub = document.getElementById('scrub');
const scrubMarkersEl = document.getElementById('scrub-markers');
const timeReadout = document.getElementById('time-readout');
const btnCopyReplayLink = document.getElementById('btn-copy-replay-link');
const scrubHoverTip = document.getElementById('scrub-hover-tip');
const lbList = document.getElementById('lb-list');
const lbSessionTime = document.getElementById('lb-session-time');
const leaderboardEl = document.getElementById('leaderboard');
const telemetryPanel = document.getElementById('telemetry-panel');
const telemetryInner = document.getElementById('telemetry-inner');
const telChip = document.getElementById('tel-chip');
const telCode = document.getElementById('tel-code');
const telPos = document.getElementById('tel-pos');
const telSpeed = document.getElementById('tel-speed');
const telGear = document.getElementById('tel-gear');
const telThrottle = document.getElementById('tel-throttle');
const telBrake = document.getElementById('tel-brake');
const telDrs = document.getElementById('tel-drs');
const telTyre = document.getElementById('tel-tyre');
const telTyreLife = document.getElementById('tel-tyre-life');
const telTyreStint = document.getElementById('tel-tyre-stint');
const telLap = document.getElementById('tel-lap');
const telDist = document.getElementById('tel-dist');
const telThrottleBar = document.getElementById('tel-throttle-bar');
const telBrakeBar = document.getElementById('tel-brake-bar');

const driverViewHud = document.getElementById('driver-view-hud');
const driverPovMeta = document.getElementById('driver-pov-meta');
const driverHudInner = document.getElementById('driver-view-hud-inner');
const driverHudChip = document.getElementById('driver-hud-chip');
const driverHudCode = document.getElementById('driver-hud-code');
const driverHudSub = document.getElementById('driver-hud-sub');
const driverHudSpeedKmh = document.getElementById('driver-hud-speed-kmh');
const driverHudSpeedMph = document.getElementById('driver-hud-speed-mph');
const driverHudGear = document.getElementById('driver-hud-gear');
const driverHudGearStrip = document.getElementById('driver-hud-gear-strip');
const driverHudTyre = document.getElementById('driver-hud-tyre');
const driverHudShiftLeds = document.getElementById('driver-hud-shift-leds');
const driverHudThrottleBar = document.getElementById('driver-hud-throttle-bar');
const driverHudBrakeBar = document.getElementById('driver-hud-brake-bar');
const driverHudThrottlePct = document.getElementById('driver-hud-throttle-pct');
const driverHudBrakePct = document.getElementById('driver-hud-brake-pct');
const driverHudDrs = document.getElementById('driver-hud-drs');
const driverHudClose = document.getElementById('driver-hud-close');
const telemetryClose = document.getElementById('telemetry-close');
const weatherPanel = document.getElementById('weather-panel');
const wxTrack = document.getElementById('wx-track');
const wxAir = document.getElementById('wx-air');
const wxHumidity = document.getElementById('wx-humidity');
const wxWind = document.getElementById('wx-wind');
const wxRain = document.getElementById('wx-rain');
const welcomeOverlay = document.getElementById('welcome-overlay');
const welcomeStart = document.getElementById('welcome-start');
const canvasHint = document.getElementById('canvas-hint');
const canvas3dOverlay = document.getElementById('canvas-3d-overlay');
const cameraModeWrap = document.getElementById('camera-mode-wrap');
const cameraModeSelect = document.getElementById('camera-mode-select');

/** True for phones/tablets with finger input (not stylus precision). */
function isCoarsePointer() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );
}

function set3dHintText() {
  const el = document.getElementById('canvas-3d-hint-text');
  if (!el) return;
  if (cameraModeSelect?.value === 'driver_pov') {
    el.textContent =
      'Driver view: pick a driver in the leaderboard — onboard camera & broadcast HUD.';
    return;
  }
  el.textContent = isCoarsePointer()
    ? 'Pinch: zoom · One finger: orbit · Two fingers: pan & zoom'
    : 'Scroll: zoom · Left drag: orbit · Right drag: pan';
}

function setViewModeSliderTitle() {
  const viewModeSlider = document.getElementById('view-mode-slider');
  if (!viewModeSlider) return;
  const is3d = viewModeSlider.value === '1';
  viewModeSlider.title = is3d
    ? isCoarsePointer()
      ? '3D: pinch to zoom, one finger to orbit, two fingers to pan'
      : '3D: scroll to zoom, left-drag to orbit, right-drag to pan'
    : '2D track map';
}

/** @type {any | null} */
let selectedEvent = null;
/** @type {any[]} */
let calendarEvents = [];

/** @type {string | null} */
let selectedDriverCode = null;

/**
 * Once per loaded session: if the user has not chosen anyone yet, pick the leader (P1)
 * so the telemetry HUD is visible without requiring a leaderboard click.
 */
let autoPickLeaderDone = false;

let lastReplayHashSyncMs = 0;

/**
 * Same ordering as the sidebar leaderboard (stable sort on position; missing → 99).
 * @param {Record<string, any>} drivers
 * @returns {{ code: string, pos: number }[]}
 */
function leaderboardSortRows(drivers) {
  if (!drivers || typeof drivers !== 'object') return [];
  return Object.entries(drivers)
    .map(([code, d]) => ({ code, pos: d.position ?? 99 }))
    .sort((a, b) => a.pos - b.pos);
}

function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/** @param {string} code */
function driverTeamLabel(code) {
  const m = sessionMeta?.driver_teams;
  if (!m || typeof m !== 'object') return '';
  const t = m[code];
  return typeof t === 'string' && t.trim() ? t.trim() : '';
}

/** Top row of the leaderboard — gold ring on map matches this driver, not raw P1. */
function leaderCodeFromFrame(frame) {
  const rows = leaderboardSortRows(frame?.drivers || {});
  return rows[0]?.code ?? null;
}

function sync3dCanvasHint() {
  const seen = document.documentElement.classList.contains('welcome-seen');
  const in3d = isViewMode3d();
  if (canvas3dOverlay) {
    canvas3dOverlay.hidden = !seen || !in3d;
  }
  if (cameraModeWrap) {
    cameraModeWrap.hidden = !seen || !in3d || !sessionId;
  }
  set3dHintText();
}

function updateCanvasHint() {
  const seen = document.documentElement.classList.contains('welcome-seen');
  const idle = loadingOverlay.hidden;
  if (canvasHint) {
    const show = seen && !sessionId && idle;
    canvasHint.hidden = !show;
  }
  sync3dCanvasHint();
}

function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.hidden = false;
  updateCanvasHint();
}

function hideLoading() {
  loadingOverlay.hidden = true;
  updateCanvasHint();
}

async function apiJson(url, opts) {
  const r = await fetch(apiUrl(url), defaultFetchInit(opts));
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || r.statusText);
  }
  return r.json();
}

/** GET JSON when status is ok; otherwise null (404 / missing file — no throw). */
async function fetchJsonIfOk(url) {
  const r = await fetch(apiUrl(url), defaultFetchInit());
  if (!r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Yearly calendar from static assets only (browser GET `/data/schedule/{year}.json` — no `/api/schedule`).
 * @param {number} year
 */
async function loadScheduleForYear(year) {
  const data = await fetchJsonIfOk(`/data/schedule/${year}.json`);
  if (data && Array.isArray(data.events)) {
    return data;
  }
  throw new Error(
    `Missing frontend/data/schedule/${year}.json — run: PYTHONPATH=backend python3 scripts/export_year_schedule.py --year ${year}`,
  );
}

/**
 * Match a driver code against map keys (exact, then case-insensitive).
 * @param {Record<string, unknown> | null | undefined} map
 * @param {string | null | undefined} code
 * @returns {string | null}
 */
function getDriverKeyFromMap(map, code) {
  if (!map || code == null || code === '') return null;
  const s = String(code).trim();
  if (Object.prototype.hasOwnProperty.call(map, s)) return s;
  const lc = s.toLowerCase();
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === lc) return k;
  }
  return null;
}

function normalizeHex(hex) {
  if (!hex || typeof hex !== 'string') return '#888888';
  let h = hex.replace('#', '').trim();
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]+$/.test(h)) return '#888888';
  return `#${h}`;
}

function hexToRgb(hex) {
  const h = normalizeHex(hex).replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** @param {any} ev */
function eventHasSprint(ev) {
  return (ev?.type || '').toLowerCase().includes('sprint');
}

/** @param {any} ev */
function eventHasQualifying(ev) {
  const sd = ev?.session_dates;
  if (!sd || typeof sd !== 'object') return true;
  const keys = Object.keys(sd);
  if (keys.length === 0) return true;
  return keys.some((k) => {
    const u = k.toUpperCase();
    if (u === 'SQ' || u.includes('SPRINT QUAL')) return false;
    return u === 'Q' || (k.includes('Qualifying') && !k.includes('Sprint'));
  });
}

function updateSessionTypeOptions() {
  const sprintIn = document.getElementById('input-sprint');
  const qualiIn = document.getElementById('input-quali');
  const gpIn = document.querySelector('input[name="stype"][value="R"]');
  if (!sprintIn || !qualiIn || !gpIn || !selectedEvent) return;
  sprintIn.disabled = !eventHasSprint(selectedEvent);
  qualiIn.disabled = !eventHasQualifying(selectedEvent);
  if (sprintIn.disabled && sprintIn.checked) gpIn.checked = true;
  if (qualiIn.disabled && qualiIn.checked) gpIn.checked = true;
}

/** ISO time for the selected session from static schedule (`session_dates`), or null if unknown. */
function getSessionScheduledIso(ev, sessionType) {
  const sd = ev?.session_dates;
  if (!sd || typeof sd !== 'object') return null;
  const key =
    sessionType === 'S'
      ? 'Sprint'
      : sessionType === 'Q'
        ? 'Qualifying'
        : 'Race';
  const iso = sd[key];
  if (typeof iso !== 'string' || !iso.trim()) return null;
  return iso.trim();
}

/** True when the calendar lists a start time in the future (session has not begun). */
function isSessionScheduledInFuture(ev, sessionType) {
  const iso = getSessionScheduledIso(ev, sessionType);
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() < t;
}

function resizeCanvas() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function isViewMode3d() {
  const el = document.getElementById('view-mode-slider');
  return !!(el && el.value === '1');
}

async function ensureTrackView3d() {
  if (trackView3d) return trackView3d;
  if (!trackView3dPromise) {
    const wrap = canvas.parentElement;
    if (!wrap) throw new Error('track canvas wrap missing');
    trackView3dPromise = import(`./view3d.js?v=${VIEW3D_MODULE_VER}`).then(
      ({ createTrackView3D }) => createTrackView3D(wrap),
    );
  }
  trackView3d = await trackView3dPromise;
  return trackView3d;
}

function resizeTrackViews() {
  resizeCanvas();
  const wrap = canvas.parentElement;
  if (wrap && trackView3d) {
    trackView3d.resize(wrap.clientWidth, wrap.clientHeight);
  }
}

function applyViewModeVisibility() {
  const is3d = isViewMode3d();
  canvas.style.display = is3d ? 'none' : 'block';
  if (!is3d) {
    trackView3d?.setCameraMode('free');
    trackView3d?.setActive(false);
    sync3dCanvasHint();
    return;
  }
  void ensureTrackView3d()
    .then((v) => {
      v.setActive(true);
      const wrap = canvas.parentElement;
      if (wrap) v.resize(wrap.clientWidth, wrap.clientHeight);
      /* Build track before camera mode so rebuildTrack's default pose is not
       * overwritten by setCameraMode, then replaced again (felt like a reset). */
      if (sessionMeta?.track) {
        if (metaBuiltFor3d !== sessionMeta) {
          v.rebuildTrack(sessionMeta);
          metaBuiltFor3d = sessionMeta;
        }
      } else if (metaBuiltFor3d != null) {
        v.rebuildTrack(null);
        metaBuiltFor3d = null;
      }
      v.setCameraMode(
        /** @type {'free'|'follow'|'driver_pov'} */ (
          cameraModeSelect?.value || 'free'
        ),
      );
    })
    .catch(() => {
      /* Three.js failed to load */
    });
  sync3dCanvasHint();
}

function computeTransform(
  track,
  circuitRotation,
  screenW,
  screenH,
  leftUi,
  rightUi,
) {
  const b = track.bounds;
  const cx = (b.x_min + b.x_max) / 2;
  const cy = (b.y_min + b.y_max) / 2;
  const rot = (circuitRotation * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  function rotPt(x, y) {
    const tx = x - cx;
    const ty = y - cy;
    return {
      x: tx * cos - ty * sin + cx,
      y: tx * sin + ty * cos + cy,
    };
  }

  let wxMin = Infinity;
  let wxMax = -Infinity;
  let wyMin = Infinity;
  let wyMax = -Infinity;
  const addPts = (xs, ys) => {
    for (let i = 0; i < xs.length; i++) {
      const p = rotPt(xs[i], ys[i]);
      wxMin = Math.min(wxMin, p.x);
      wxMax = Math.max(wxMax, p.x);
      wyMin = Math.min(wyMin, p.y);
      wyMax = Math.max(wyMax, p.y);
    }
  };
  addPts(track.inner.x, track.inner.y);
  addPts(track.outer.x, track.outer.y);

  const worldW = Math.max(1, wxMax - wxMin);
  const worldH = Math.max(1, wyMax - wyMin);
  const worldCx = (wxMin + wxMax) / 2;
  const worldCy = (wyMin + wyMax) / 2;

  const innerW = Math.max(1, screenW - leftUi - rightUi);
  const pad = 0.05;
  const usableW = innerW * (1 - 2 * pad);
  const usableH = screenH * (1 - 2 * pad);
  const scale = Math.min(usableW / worldW, usableH / worldH);
  const screenCx = leftUi + innerW / 2;
  const screenCy = screenH / 2;
  const tx = screenCx - scale * worldCx;
  const ty = screenCy - scale * worldCy;

  return { cx, cy, cos, sin, scale, tx, ty, screenW, screenH };
}

function getCachedScreenTransform(track, circuitRotation, w, h) {
  const { left: leftUi, right: rightUi } = getTrackUiMarginsPx();
  const key = `${sessionId}|${w}|${h}|${circuitRotation}|${leftUi}|${rightUi}`;
  if (cachedScreenTransformKey === key && cachedScreenTransform) {
    return cachedScreenTransform;
  }
  cachedScreenTransformKey = key;
  cachedScreenTransform = computeTransform(
    track,
    circuitRotation,
    w,
    h,
    leftUi,
    rightUi,
  );
  return cachedScreenTransform;
}

function worldToScreen(xw, yw, T) {
  const tx = xw - T.cx;
  const ty = yw - T.cy;
  const rx = tx * T.cos - ty * T.sin + T.cx;
  const ry = tx * T.sin + ty * T.cos + T.cy;
  return [T.scale * rx + T.tx, T.scale * ry + T.ty];
}

function drawPolyline(xs, ys, rgb, lineWidth, T) {
  if (xs.length < 2) return;
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    const [sx, sy] = worldToScreen(xs[i], ys[i], T);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.strokeStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/** Start/finish from meta, or approximate from centerline for older bundles */
function finishLineFromTrack(track) {
  if (track.finish_line?.start && track.finish_line?.end)
    return track.finish_line;
  const cx = track.centerline?.x;
  const cy = track.centerline?.y;
  if (!cx || !cy || cx.length < 2) return null;
  const x0 = cx[0];
  const y0 = cy[0];
  const x1 = cx[1];
  const y1 = cy[1];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const half = 100;
  return {
    start: { x: x0 + nx * half, y: y0 + ny * half },
    end: { x: x0 - nx * half, y: y0 - ny * half },
  };
}

/** Checkered strip along inner→outer segment (start/finish line across track) */
function drawFinishLineStrip(ctx, T, fl) {
  if (!fl?.start || !fl?.end) return;
  const [sx, sy] = worldToScreen(fl.start.x, fl.start.y, T);
  const [ex, ey] = worldToScreen(fl.end.x, fl.end.y, T);
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const halfW = Math.max(2.2, Math.min(5, len * 0.014));
  const stripes = Math.max(10, Math.min(28, Math.round(len / 12)));
  const seg = len / stripes;
  for (let i = 0; i < stripes; i++) {
    const t0 = i * seg;
    const t1 = (i + 1) * seg;
    ctx.fillStyle = i % 2 === 0 ? '#ececec' : '#0c0c0c';
    ctx.beginPath();
    ctx.moveTo(sx + ux * t0 + px * halfW, sy + uy * t0 + py * halfW);
    ctx.lineTo(sx + ux * t1 + px * halfW, sy + uy * t1 + py * halfW);
    ctx.lineTo(sx + ux * t1 - px * halfW, sy + uy * t1 - py * halfW);
    ctx.lineTo(sx + ux * t0 - px * halfW, sy + uy * t0 - py * halfW);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
}

function currentTrackStatus(frame, trackStatuses) {
  const t = frame.t;
  let st = '1';
  for (const s of trackStatuses) {
    const end = s.end_time == null ? Infinity : s.end_time;
    if (t >= s.start_time && t < end) {
      st = String(s.status);
      break;
    }
  }
  return st;
}

function trackColorForStatus(code) {
  if (code === '2') return STATUS_COLORS.YELLOW;
  if (code === '4') return STATUS_COLORS.SC;
  if (code === '5') return STATUS_COLORS.STOPPED;
  if (code === '6' || code === '7') return STATUS_COLORS.VSC;
  return STATUS_COLORS.GREEN;
}

/** Matches scripts/export_static_replay.py slug: {year}_r{round}{sessionType} */
function makeReplaySlug(year, round, sessionType) {
  return `${year}_r${String(round).padStart(2, '0')}_${sessionType}`;
}

function isStaticSessionId(id) {
  return typeof id === 'string' && id.startsWith('static:');
}

/** `#y=2024&r=1&s=R&f=12345` — shareable replay position (f = frame index). */
function parseReplayHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const y = Number(p.get('y'));
  const r = Number(p.get('r'));
  const s = p.get('s');
  const fRaw = p.get('f');
  if (!Number.isFinite(y) || !Number.isFinite(r) || !s) return null;
  if (!['R', 'S', 'Q'].includes(s)) return null;
  const f =
    fRaw != null && fRaw !== '' && Number.isFinite(Number(fRaw))
      ? Math.max(0, Math.floor(Number(fRaw)))
      : null;
  return { y: Math.round(y), r: Math.round(r), s, f };
}

function buildReplayHashParams() {
  if (!sessionMeta || !selectedEvent || !totalFrames) return null;
  const st = document.querySelector('input[name="stype"]:checked')?.value;
  if (!st) return null;
  const y = parseInt(elYear.value, 10);
  const r = selectedEvent.round_number;
  const f = Math.min(Math.max(0, Math.floor(frameIndex)), totalFrames - 1);
  const p = new URLSearchParams();
  p.set('y', String(y));
  p.set('r', String(r));
  p.set('s', st);
  p.set('f', String(f));
  return p;
}

function syncReplayHash() {
  const p = buildReplayHashParams();
  if (!p) return;
  const next = `#${p.toString()}`;
  if (location.hash !== next) {
    history.replaceState(
      null,
      '',
      `${location.pathname}${location.search}${next}`,
    );
  }
}

/** Full URL with `#y=&r=&s=&f=` for sharing (same shape as `parseReplayHash`). */
function getReplayShareUrl() {
  const p = buildReplayHashParams();
  if (!p) return null;
  return `${location.origin}${location.pathname}${location.search}#${p.toString()}`;
}

function updateCopyReplayLinkButton() {
  if (!btnCopyReplayLink) return;
  btnCopyReplayLink.disabled = buildReplayHashParams() == null;
}

async function copyReplayLinkToClipboard() {
  const url = getReplayShareUrl();
  if (!url) return;
  const btn = btnCopyReplayLink;
  const label = 'Copy link';
  try {
    await navigator.clipboard.writeText(url);
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = label;
      }, 1600);
    }
  } catch (_) {
    if (btn) {
      btn.textContent = 'Failed';
      setTimeout(() => {
        btn.textContent = label;
      }, 2000);
    }
  }
}

function jumpToFrame(f) {
  if (!totalFrames) return;
  const n = Math.min(Math.max(0, Math.floor(Number(f))), totalFrames - 1);
  frameIndex = n;
  if (scrub) scrub.value = String(n);
  paused = true;
  void prefetchNearby();
}

function clearScrubMarkers() {
  if (scrubMarkersEl) scrubMarkersEl.innerHTML = '';
}

/**
 * Human-readable text for a timeline marker (`race_events` entry).
 * @param {Record<string, unknown>} ev
 */
function formatRaceEventDescription(ev) {
  const raw = ev.description;
  if (raw != null && String(raw).trim() !== '') {
    return String(raw).trim();
  }
  const t = ev.type;
  if (t === 'dnf') {
    const who = ev.label || 'Driver';
    const lap = ev.lap != null && ev.lap !== '' ? ` · Lap ${ev.lap}` : '';
    return `DNF — ${who}${lap}`;
  }
  if (t === 'safety_car') return 'Safety car period';
  if (t === 'vsc') return 'Virtual safety car';
  if (t === 'yellow_flag') return 'Yellow flag period';
  if (t === 'red_flag') return 'Red flag period';
  return typeof t === 'string' ? t.replace(/_/g, ' ') : 'Event';
}

/**
 * Tooltip / title text: description plus time (DNF) or start–end (bar periods).
 * @param {Record<string, unknown>} ev
 */
function formatRaceEventTooltipText(ev) {
  const desc = formatRaceEventDescription(ev);
  const fps =
    Number.isFinite(Number(sessionFps)) && sessionFps > 0 ? sessionFps : FPS;
  const t = ev.type;
  if (t === 'dnf') {
    const fr = Number(ev.frame);
    const tSec = Number.isFinite(fr) ? fr / fps : 0;
    return `${desc}\n${formatTime(tSec)}`;
  }
  if (
    t === 'safety_car' ||
    t === 'vsc' ||
    t === 'yellow_flag' ||
    t === 'red_flag'
  ) {
    const fr = Number(ev.frame);
    const e0 = ev.end_frame != null ? Number(ev.end_frame) : fr + 1;
    const a = Math.min(fr, e0);
    const b = Math.max(fr, e0);
    const t0 = formatTime(Math.max(0, a) / fps);
    const t1 = formatTime(Math.max(0, b) / fps);
    return `${desc}\n${t0} – ${t1}`;
  }
  const fr = Number(ev.frame);
  const tSec = Number.isFinite(fr) ? fr / fps : 0;
  return `${desc}\n${formatTime(tSec)}`;
}

/**
 * @param {Record<string, unknown>} ev
 */
function bindScrubMarkerHover(el, ev) {
  const show = (e) => {
    showScrubMarkerEventTip(e.clientX, e.clientY, ev);
  };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', show);
  el.addEventListener('mouseleave', hideScrubHoverTip);
}

function buildScrubMarkers() {
  clearScrubMarkers();
  if (!scrubMarkersEl || !sessionMeta || !totalFrames) return;
  const span = Math.max(1, totalFrames - 1);
  const events = sessionMeta.race_events || [];
  for (const ev of events) {
    const t = ev.type;
    const fr = ev.frame;
    if (fr == null || !Number.isFinite(Number(fr))) continue;
    const tip = formatRaceEventTooltipText(ev);
    if (t === 'dnf') {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'scrub-marker scrub-marker--dnf';
      tick.style.left = `${(Number(fr) / span) * 100}%`;
      tick.title = tip;
      tick.setAttribute('aria-label', tip);
      bindScrubMarkerHover(tick, ev);
      tick.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        jumpToFrame(fr);
      });
      scrubMarkersEl.appendChild(tick);
    } else if (
      t === 'safety_car' ||
      t === 'vsc' ||
      t === 'yellow_flag' ||
      t === 'red_flag'
    ) {
      const e0 = ev.end_frame != null ? Number(ev.end_frame) : Number(fr) + 1;
      const a = Math.min(Number(fr), e0);
      const b = Math.max(Number(fr), e0);
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = `scrub-marker scrub-marker--bar scrub-marker--${t}`;
      seg.style.left = `${(a / span) * 100}%`;
      seg.style.width = `${Math.max(((b - a) / span) * 100, 0.15)}%`;
      seg.title = tip;
      seg.setAttribute('aria-label', tip);
      bindScrubMarkerHover(seg, ev);
      seg.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        jumpToFrame(fr);
      });
      scrubMarkersEl.appendChild(seg);
    }
  }
}

/** Server dropped the session (TTL, restart, eviction) — stop retry spam and ask user to reload. */
function handleSessionGone() {
  if (!sessionId || isStaticSessionId(sessionId)) return;
  if (sessionGoneHandled) return;
  sessionGoneHandled = true;
  paused = true;
  sessionId = null;
  sessionMeta = null;
  totalFrames = 0;
  sessionFps = FPS;
  cachedScreenTransformKey = '';
  cachedScreenTransform = null;
  chunkCache.clear();
  chunkInflight.clear();
  frameIndex = 0;
  if (lbList) lbList.innerHTML = '';
  hideScrubHoverTip();
  selectedDriverCode = null;
  autoPickLeaderDone = false;
  if (sessionBanner) sessionBanner.hidden = true;
  if (loadStatus) {
    loadStatus.classList.remove('load-status--ready');
    loadStatus.classList.add('load-status--error');
    loadStatus.textContent =
      'Session expired or the server restarted. Click Load session again.';
  }
  if (btnPlay) btnPlay.disabled = true;
  if (btnPause) btnPause.disabled = true;
  if (scrub) {
    scrub.disabled = true;
    scrub.value = '0';
  }
  if (speedSelect) speedSelect.disabled = true;
  clearScrubMarkers();
  updateCopyReplayLinkButton();
  if (location.hash) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  hideLoading();
}

async function ensureChunkForFrame(idx) {
  if (!sessionId || idx < 0 || idx >= totalFrames) return;
  const start = Math.floor(idx / CHUNK_SIZE) * CHUNK_SIZE;
  if (chunkCache.has(start)) return;

  let p = chunkInflight.get(start);
  if (p) {
    await p;
    return;
  }

  p = (async () => {
    try {
      let url;
      if (isStaticSessionId(sessionId)) {
        const slug = sessionId.slice('static:'.length);
        url = `/data/replays/${encodeURIComponent(slug)}/frames_${start}.json`;
        const r = await fetch(apiUrl(url), defaultFetchInit());
        if (!r.ok) {
          throw new Error(`Static chunk ${start}: ${r.status}`);
        }
        const j = await r.json();
        chunkCache.set(start, j.frames);
      } else {
        url = `/api/session/${encodeURIComponent(sessionId)}/frames?start=${start}&end=${start + CHUNK_SIZE}`;
        const r = await fetch(apiUrl(url), defaultFetchInit());
        if (r.status === 404) {
          handleSessionGone();
          throw new Error('Session no longer on server.');
        }
        if (!r.ok) {
          const t = await r.text();
          throw new Error(t || r.statusText);
        }
        const data = await r.json();
        chunkCache.set(start, data.frames);
      }
    } finally {
      chunkInflight.delete(start);
    }
  })();

  chunkInflight.set(start, p);
  await p;
}

/** Start loading chunks after `idx` (and one before) without blocking the frame loop. */
function prefetchChunksAround(idx, speedFactor = 1) {
  if (!sessionId || !totalFrames) return;
  const n = Math.min(
    PREFETCH_MAX_CHUNKS_AHEAD,
    Math.max(PREFETCH_MIN_CHUNKS_AHEAD, Math.ceil(Number(speedFactor) || 1)),
  );
  for (let k = 1; k <= n; k++) {
    void ensureChunkForFrame(idx + k * CHUNK_SIZE).catch(() => {});
  }
  void ensureChunkForFrame(idx - CHUNK_SIZE).catch(() => {});
}

function getFrameAt(i) {
  const idx = Math.min(Math.max(0, Math.floor(i)), totalFrames - 1);
  const start = Math.floor(idx / CHUNK_SIZE) * CHUNK_SIZE;
  const chunk = chunkCache.get(start);
  if (!chunk) return null;
  return chunk[idx - start];
}

function lerpNum(u, v, f) {
  const x = Number(u);
  const y = Number(v);
  if (!Number.isFinite(x)) return Number.isFinite(y) ? y : x;
  if (!Number.isFinite(y)) return x;
  return x + (y - x) * f;
}

/**
 * Linear blend of world positions between 25 Hz samples. Cosine easing was removed:
 * it forces zero derivative at each sample, so cars briefly “brake” at 25 Hz and look jittery.
 */
/** Blend continuous telemetry between two frames; discrete fields stay from `a`. */
function blendDriver(da, db, frac) {
  if (da && !db) return da;
  if (!da && db) return db;
  if (!da || !db) return da || db;
  return {
    ...da,
    x: lerpNum(da.x, db.x, frac),
    y: lerpNum(da.y, db.y, frac),
    dist: lerpNum(da.dist, db.dist, frac),
    rel_dist: lerpNum(da.rel_dist, db.rel_dist, frac),
    speed: lerpNum(da.speed, db.speed, frac),
    throttle: lerpNum(da.throttle, db.throttle, frac),
    brake: lerpNum(da.brake, db.brake, frac),
    tyre_life: lerpNum(da.tyre_life, db.tyre_life, frac),
    tyre_laps_since_pit: lerpNum(
      da.tyre_laps_since_pit ?? da.tyre_life,
      db.tyre_laps_since_pit ?? db.tyre_life,
      frac,
    ),
  };
}

function blendFrames(a, b, frac) {
  const drivers = {};
  const codes = new Set([
    ...Object.keys(a.drivers || {}),
    ...Object.keys(b.drivers || {}),
  ]);
  for (const code of codes) {
    drivers[code] = blendDriver(a.drivers[code], b.drivers[code], frac);
  }
  const scA = a.safety_car;
  const scB = b.safety_car;
  let safety_car;
  if (scA && scB) {
    safety_car = {
      ...scA,
      x: lerpNum(scA.x, scB.x, frac),
      y: lerpNum(scA.y, scB.y, frac),
    };
  } else if (scA || scB) {
    safety_car = frac < 0.5 ? scA || undefined : scB || undefined;
  } else {
    safety_car = undefined;
  }

  return {
    ...a,
    t: lerpNum(a.t, b.t, frac),
    drivers,
    safety_car,
  };
}

/**
 * Linear interpolation between telemetry samples so playback matches wall-clock
 * advance (frameIndex is fractional) instead of stepping at 25 Hz.
 */
function getFrameBlendAt(t) {
  if (!totalFrames) return null;
  const max = totalFrames - 1;
  const tClamped = Math.min(Math.max(0, t), max);
  const i0 = Math.floor(tClamped);
  const frac = tClamped - i0;
  const a = getFrameAt(i0);
  if (!a) return null;
  if (i0 >= max || frac < 1e-5) return a;
  const b = getFrameAt(i0 + 1);
  if (!b) return a;
  return blendFrames(a, b, frac);
}

function formatTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Session time at scrub position from pointer (uniform timeline, matches frame index / FPS). */
function timeAtScrubClientX(clientX) {
  const rect = scrub.getBoundingClientRect();
  const min = parseFloat(scrub.min) || 0;
  const max = parseFloat(scrub.max) || 0;
  const span = Math.max(0, max - min);
  const w = rect.width;
  const x = Math.min(Math.max(clientX - rect.left, 0), w);
  const ratio = w > 0 ? x / w : 0;
  const idx = min + ratio * span;
  return idx / sessionFps;
}

function expectedStintLapsForCompound(meta, tyre) {
  const k = Math.round(Number(tyre));
  if (!Number.isFinite(k) || k < 0) return null;
  const map = meta?.tyre_expected_laps;
  if (map && typeof map === 'object') {
    const v = map[k] ?? map[String(k)];
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  const d = DEFAULT_TYRE_EXPECTED_LAPS[k];
  return d != null ? d : null;
}

/** Laps left vs typical stint for current compound (TyreLife resets after a pit). */
function formatTyreLapsRemaining(d, meta) {
  const since = Number(d.tyre_laps_since_pit ?? d.tyre_life);
  if (!Number.isFinite(since)) return '—';
  const expected = expectedStintLapsForCompound(meta, d.tyre);
  if (expected == null) return '—';
  const rem = Math.max(0, Math.round(expected) - Math.round(since));
  return `${rem} left`;
}

function formatTyreStintLaps(d) {
  const since = Number(d.tyre_laps_since_pit ?? d.tyre_life);
  if (!Number.isFinite(since)) return '—';
  return String(Math.round(since));
}

function refreshTimeReadout() {
  if (!timeReadout) return;
  if (!sessionId || !totalFrames || !sessionMeta) {
    timeReadout.textContent = '—';
    return;
  }
  const frame =
    getFrameBlendAt(frameIndex) ?? getFrameAt(Math.floor(frameIndex));
  const t =
    frame?.t != null && Number.isFinite(Number(frame.t))
      ? Number(frame.t)
      : frameIndex / sessionFps;
  const leaderLap = frame?.lap ?? 1;
  const tl = sessionMeta.total_laps;
  timeReadout.textContent = `${formatTime(t)} · Lap ${leaderLap}${
    tl ? '/' + tl : ''
  } · x${playbackSpeed}`;
}

function showScrubHoverTip(clientX, timeSec) {
  if (!scrubHoverTip || !scrub) return;
  const barTop = scrub.getBoundingClientRect().top;
  scrubHoverTip.textContent = formatTime(timeSec);
  scrubHoverTip.classList.remove('scrub-hover-tip--event');
  scrubHoverTip.hidden = false;
  scrubHoverTip.setAttribute('aria-hidden', 'false');
  scrubHoverTip.style.left = `${clientX}px`;
  scrubHoverTip.style.top = `${barTop}px`;
}

/**
 * Tooltip for a race-event marker (description + time, or start–end for periods).
 * @param {Record<string, unknown>} ev
 */
function showScrubMarkerEventTip(clientX, clientY, ev) {
  if (!scrubHoverTip) return;
  scrubHoverTip.textContent = formatRaceEventTooltipText(ev);
  scrubHoverTip.classList.add('scrub-hover-tip--event');
  scrubHoverTip.hidden = false;
  scrubHoverTip.setAttribute('aria-hidden', 'false');
  scrubHoverTip.style.left = `${clientX}px`;
  scrubHoverTip.style.top = `${clientY}px`;
}

function hideScrubHoverTip() {
  if (!scrubHoverTip) return;
  scrubHoverTip.hidden = true;
  scrubHoverTip.setAttribute('aria-hidden', 'true');
  scrubHoverTip.classList.remove('scrub-hover-tip--event');
}

/** Seconds behind leader (from telemetry gap); ~0 for P1 */
function formatGapLeaderS(s) {
  if (s == null || !Number.isFinite(Number(s))) return '—';
  const n = Number(s);
  if (n < 0.0005) return '0.000s';
  return `+${n.toFixed(3)}s`;
}

/** Seconds behind the car immediately ahead; none for leader */
function formatGapAheadS(s) {
  if (s == null || !Number.isFinite(Number(s))) return '—';
  return `+${Number(s).toFixed(3)}s`;
}

function drawFrame() {
  const dpr = window.devicePixelRatio || 1;
  const view3d = isViewMode3d();

  if (!sessionMeta || !totalFrames) {
    cachedScreenTransformKey = '';
    cachedScreenTransform = null;
    if (!view3d) {
      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    } else {
      void ensureTrackView3d().then((v) => {
        if (!isViewMode3d()) return;
        v.setActive(true);
        const wrap = canvas.parentElement;
        if (wrap) v.resize(wrap.clientWidth, wrap.clientHeight);
        v.rebuildTrack(null);
        metaBuiltFor3d = null;
      });
    }
    return;
  }

  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  if (!view3d) {
    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, w, h);
  }

  const track = sessionMeta.track;
  const circuitRotation = sessionMeta.circuit_rotation || 0;
  /** @type {ReturnType<typeof computeTransform> | null} */
  let T = null;
  if (!view3d) {
    T = getCachedScreenTransform(track, circuitRotation, w, h);
  }
  const frame =
    getFrameBlendAt(frameIndex) ?? getFrameAt(Math.floor(frameIndex));
  if (!frame) {
    if (!view3d) {
      ctx.fillStyle = '#888';
      ctx.font = '14px system-ui';
      ctx.fillText('Loading frames…', 24, 40);
    }
    updateTelemetryOverlay(null);
    updateWeatherHud(null);
    refreshTimeReadout();
    return;
  }

  if (sessionId && !autoPickLeaderDone && selectedDriverCode == null) {
    const leader = leaderCodeFromFrame(frame);
    if (leader) {
      selectedDriverCode = leader;
      autoPickLeaderDone = true;
    }
  }

  const colors = sessionMeta.driver_colors;
  const drivers = frame.drivers || {};
  const selectedKey = getDriverKeyFromMap(drivers, selectedDriverCode);
  const leaderCode = leaderCodeFromFrame(frame);

  if (view3d) {
    if (trackView3d) {
      if (metaBuiltFor3d !== sessionMeta) {
        trackView3d.rebuildTrack(sessionMeta);
        metaBuiltFor3d = sessionMeta;
      }
      trackView3d.updateFrame(frame, colors, leaderCode, selectedKey);
    } else {
      void ensureTrackView3d().then((v) => {
        if (!isViewMode3d()) return;
        if (metaBuiltFor3d !== sessionMeta) {
          v.rebuildTrack(sessionMeta);
          metaBuiltFor3d = sessionMeta;
        }
        v.updateFrame(frame, colors, leaderCode, selectedKey);
      });
    }
  } else {
    const tc = trackColorForStatus(
      currentTrackStatus(frame, sessionMeta.track_statuses),
    );
    drawPolyline(track.inner.x, track.inner.y, tc, 4, T);
    drawPolyline(track.outer.x, track.outer.y, tc, 4, T);

    for (const z of track.drs_zones || []) {
      const [sx, sy] = worldToScreen(z.start.x, z.start.y, T);
      const [ex, ey] = worldToScreen(z.end.x, z.end.y, T);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    const fl = finishLineFromTrack(track);
    if (fl) drawFinishLineStrip(ctx, T, fl);
  }

  /** Leader (leaderboard top row) drawn last so they sit on top at stacks; gold ring. */
  function drawDriverDot(code, pos, isLeaderRow) {
    const hex = normalizeHex(colors[code] || '#ffffff');
    const rgb = hexToRgb(hex);
    const [sx, sy] = worldToScreen(pos.x, pos.y, T);
    const sel = !!(selectedKey && code === selectedKey);
    let r = 6;
    if (isLeaderRow) r = sel ? 8 : 7;
    else if (sel) r = 7;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fill();
    if (isLeaderRow) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 214, 90, 0.95)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (sel) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + (isLeaderRow ? 6.5 : 4), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.88)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  /** 3-letter tag under dot; drawn after all dots so it isn’t covered by other cars. */
  function drawDriverCodeTag(code, pos, isLeaderRow) {
    const [sx, sy] = worldToScreen(pos.x, pos.y, T);
    const sel = !!(selectedKey && code === selectedKey);
    let r = 6;
    if (isLeaderRow) r = sel ? 8 : 7;
    else if (sel) r = 7;
    const tag = String(code).toUpperCase().trim().slice(0, 3);
    if (!tag) return;
    ctx.save();
    ctx.font = '600 10.5px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const ty = sy + r + 2;
    ctx.lineWidth = 2.75;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeText(tag, sx, ty);
    ctx.fillStyle = 'rgba(252,252,252,0.96)';
    ctx.fillText(tag, sx, ty);
    ctx.restore();
  }

  if (!view3d) {
    const entries = Object.entries(drivers);
    for (const [code, pos] of entries) {
      if (leaderCode && code === leaderCode) continue;
      drawDriverDot(code, pos, false);
    }
    if (leaderCode) {
      const leaderEntry = entries.find(([c]) => c === leaderCode);
      if (leaderEntry) drawDriverDot(leaderEntry[0], leaderEntry[1], true);
    }

    for (const [code, pos] of entries) {
      if (leaderCode && code === leaderCode) continue;
      drawDriverCodeTag(code, pos, false);
    }
    if (leaderCode) {
      const leaderEntry = entries.find(([c]) => c === leaderCode);
      if (leaderEntry) drawDriverCodeTag(leaderEntry[0], leaderEntry[1], true);
    }

    const sc = frame.safety_car;
    if (sc) {
      const [sx, sy] = worldToScreen(sc.x, sc.y, T);
      ctx.beginPath();
      ctx.arc(sx, sy, 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(210, 210, 210, 0.9)';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.fillText('SC', sx + 12, sy + 4);
    }
  }

  updateLeaderboard(frame);
  updateTelemetryOverlay(frame);
  updateWeatherHud(frame);
  refreshTimeReadout();
}

function createLeaderboardRow(r, d, hex, selectedKey) {
  const gl = d.gap_leader_s;
  const ga = d.gap_ahead_s;
  const team = driverTeamLabel(r.code);
  const teamHtml = team
    ? `<span class="lb-team" title="${escapeHtmlAttr(team)}">${escapeHtmlText(team)}</span>`
    : '<span class="lb-team" hidden></span>';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `lb-row${selectedKey && r.code === selectedKey ? ' is-selected' : ''}`;
  btn.dataset.code = r.code;
  btn.setAttribute('data-code', String(r.code));
  btn.setAttribute('role', 'listitem');
  btn.innerHTML = `
      <span class="lb-icon" style="background:${hex}">${r.code}</span>
      <span class="lb-main">
        <span class="lb-line1">
          <span class="lb-pos">P${d.position}</span>
          ${teamHtml}
          <span class="lb-lap" title="Lap number at this moment in the replay">L${d.lap}</span>
        </span>
        <span class="lb-line2">
          <span class="lb-gap-item" title="Approx. seconds behind the race leader"><span class="lb-gap-label">Leader</span><span class="lb-gap-leader-val">${formatGapLeaderS(gl)}</span></span>
          <span class="lb-gap-item" title="Approx. seconds behind the car in front"><span class="lb-gap-label">Ahead</span><span class="lb-gap-ahead-val">${formatGapAheadS(ga)}</span></span>
        </span>
      </span>`;
  return btn;
}

function updateLeaderboardRow(btn, r, d, hex, selectedKey) {
  const gl = d.gap_leader_s;
  const ga = d.gap_ahead_s;
  const icon = btn.querySelector('.lb-icon');
  if (icon) {
    icon.style.background = hex;
    icon.textContent = r.code;
  }
  const posEl = btn.querySelector('.lb-pos');
  const lapEl = btn.querySelector('.lb-lap');
  const teamEl = btn.querySelector('.lb-team');
  if (posEl) posEl.textContent = `P${d.position}`;
  if (lapEl) lapEl.textContent = `L${d.lap}`;
  if (teamEl) {
    const team = driverTeamLabel(r.code);
    if (team) {
      teamEl.hidden = false;
      teamEl.textContent = team;
      teamEl.title = team;
    } else {
      teamEl.textContent = '';
      teamEl.removeAttribute('title');
      teamEl.hidden = true;
    }
  }
  const g1 = btn.querySelector('.lb-gap-leader-val');
  const g2 = btn.querySelector('.lb-gap-ahead-val');
  if (g1) g1.textContent = formatGapLeaderS(gl);
  if (g2) g2.textContent = formatGapAheadS(ga);
  btn.classList.toggle(
    'is-selected',
    !!(selectedKey && r.code === selectedKey),
  );
}

function createLeaderboardRowOut(code, hex, selectedKey) {
  const team = driverTeamLabel(code);
  const teamHtml = team
    ? `<span class="lb-team" title="${escapeHtmlAttr(team)}">${escapeHtmlText(team)}</span>`
    : '<span class="lb-team" hidden></span>';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `lb-row lb-row--out${
    selectedKey && code === selectedKey ? ' is-selected' : ''
  }`;
  btn.dataset.code = code;
  btn.setAttribute('data-code', String(code));
  btn.setAttribute('role', 'listitem');
  btn.innerHTML = `
      <span class="lb-icon" style="background:${hex}">${code}</span>
      <span class="lb-main">
        <span class="lb-line1">
          <span class="lb-pos">OUT</span>
          ${teamHtml}
          <span class="lb-lap" title="Retired">DNF</span>
        </span>
        <span class="lb-line2">
          <span class="lb-gap-item muted">—</span>
        </span>
      </span>`;
  return btn;
}

function updateLeaderboardRowOut(btn, code, hex, selectedKey) {
  const icon = btn.querySelector('.lb-icon');
  if (icon) {
    icon.style.background = hex;
    icon.textContent = code;
  }
  const teamEl = btn.querySelector('.lb-team');
  if (teamEl) {
    const team = driverTeamLabel(code);
    if (team) {
      teamEl.hidden = false;
      teamEl.textContent = team;
      teamEl.title = team;
    } else {
      teamEl.textContent = '';
      teamEl.removeAttribute('title');
      teamEl.hidden = true;
    }
  }
  btn.classList.toggle('is-selected', !!(selectedKey && code === selectedKey));
}

/**
 * Update leaderboard in place so row DOM nodes are not recreated every frame
 * (recreating broke click selection — events were lost between mousedown and click).
 */
function updateLeaderboard(frame) {
  if (lbSessionTime) {
    lbSessionTime.textContent = frame?.t != null ? formatTime(frame.t) : '—';
  }
  const drivers = frame?.drivers || {};
  const colors = sessionMeta?.driver_colors || {};
  const selectedKey = getDriverKeyFromMap(drivers, selectedDriverCode);
  const rows = leaderboardSortRows(drivers).slice(0, 20);
  const curFrame = Math.floor(frameIndex);
  const dnfEv = sessionMeta?.race_events || [];
  const retiredCodes = [];
  for (const ev of dnfEv) {
    if (
      ev.type === 'dnf' &&
      ev.label &&
      ev.frame != null &&
      Number(ev.frame) <= curFrame &&
      !drivers[ev.label]
    ) {
      retiredCodes.push(ev.label);
    }
  }
  retiredCodes.sort();
  const wanted = new Set([...rows.map((r) => r.code), ...retiredCodes]);

  for (const r of rows) {
    const d = drivers[r.code];
    const hex = normalizeHex(colors[r.code] || '#666666');
    let btn = lbList.querySelector(
      `.lb-row[data-code="${CSS.escape(r.code)}"]`,
    );
    if (btn && btn.classList.contains('lb-row--out')) {
      btn.remove();
      btn = null;
    }
    if (!btn) {
      btn = createLeaderboardRow(r, d, hex, selectedKey);
      lbList.appendChild(btn);
    } else {
      updateLeaderboardRow(btn, r, d, hex, selectedKey);
    }
  }

  for (const code of retiredCodes) {
    const hex = normalizeHex(colors[code] || '#666666');
    let btn = lbList.querySelector(`.lb-row[data-code="${CSS.escape(code)}"]`);
    if (btn && !btn.classList.contains('lb-row--out')) {
      btn.remove();
      btn = null;
    }
    if (!btn) {
      btn = createLeaderboardRowOut(code, hex, selectedKey);
      lbList.appendChild(btn);
    } else {
      updateLeaderboardRowOut(btn, code, hex, selectedKey);
    }
  }

  for (const btn of [...lbList.querySelectorAll('.lb-row')]) {
    const c = btn.getAttribute('data-code');
    if (c && !wanted.has(c)) btn.remove();
  }

  const desiredOrder = [...rows.map((r) => r.code), ...retiredCodes];
  const currentOrder = [...lbList.querySelectorAll('.lb-row')].map((el) =>
    el.getAttribute('data-code'),
  );
  const orderSame =
    currentOrder.length === desiredOrder.length &&
    desiredOrder.every((code, i) => currentOrder[i] === code);
  if (!orderSame) {
    for (const code of desiredOrder) {
      const btn = lbList.querySelector(
        `.lb-row[data-code="${CSS.escape(code)}"]`,
      );
      if (btn) lbList.appendChild(btn);
    }
  }
}

function isDriverBroadcastHud() {
  return (
    isViewMode3d() &&
    cameraModeSelect?.value === 'driver_pov' &&
    !!selectedDriverCode &&
    !!sessionId
  );
}

function setDriverBroadcastHudVisible(visible) {
  if (driverViewHud) driverViewHud.hidden = !visible;
  if (driverPovMeta) driverPovMeta.hidden = !visible;
}

function syncDriverHudGearStrip(gearRaw) {
  if (!driverHudGearStrip) return;
  const g = Number(gearRaw);
  const active = Number.isFinite(g) ? Math.round(g) : -1;
  driverHudGearStrip.querySelectorAll('.driver-view-hud-g').forEach((el) => {
    const tag = el.getAttribute('data-g');
    const isN = tag === 'N';
    const num = isN ? 0 : Number(tag);
    const match = isN ? active === 0 : active === num;
    el.classList.toggle('is-active', match && active >= 0);
  });
}

/** Wheel shift LEDs from pseudo power % (throttle + speed; no RPM in API). */
function setShiftLedsFromPower(pct) {
  if (!driverHudShiftLeds) return;
  const leds = driverHudShiftLeds.querySelectorAll('.driver-hud-led');
  const n = leds.length;
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const lit = Math.round((p / 100) * n);
  leds.forEach((el, i) => {
    const on = i < lit;
    el.classList.toggle('is-on', on);
    el.classList.toggle('is-red', on && i >= n - 3);
  });
}

/**
 * F1-style cockpit HUD: wheel LEDs, MFD speeds/gear/tyre, vertical inputs, DRS.
 */
function fillDriverBroadcastHud(d, labelCode, hex) {
  if (driverHudInner) driverHudInner.style.setProperty('--tel-accent', hex);
  if (driverHudChip) {
    driverHudChip.textContent = labelCode;
    driverHudChip.style.background = hex;
  }
  if (driverHudCode) driverHudCode.textContent = labelCode;
  if (driverHudSub)
    driverHudSub.textContent = `P${d.position} · Lap ${d.lap ?? '—'}`;
  const sp = Number(d.speed);
  if (driverHudSpeedKmh)
    driverHudSpeedKmh.textContent = Number.isFinite(sp)
      ? String(Math.round(sp))
      : '—';
  if (driverHudSpeedMph)
    driverHudSpeedMph.textContent = Number.isFinite(sp)
      ? String(Math.round(sp * 0.621371))
      : '—';
  const gi = Number(d.gear);
  if (driverHudGear) {
    if (d.gear != null && Number.isFinite(gi)) {
      driverHudGear.textContent = gi === 0 ? 'N' : String(gi);
    } else {
      driverHudGear.textContent = '—';
    }
  }
  syncDriverHudGearStrip(
    d.gear != null && Number.isFinite(gi) ? gi : Number.NaN,
  );
  if (driverHudTyre) driverHudTyre.textContent = tyreCompoundName(d.tyre);
  const thrPct = inputPct01(d.throttle);
  const brkPct = inputPct01(d.brake);
  if (driverHudThrottleBar) driverHudThrottleBar.style.height = `${thrPct}%`;
  if (driverHudBrakeBar) driverHudBrakeBar.style.height = `${brkPct}%`;
  if (driverHudThrottlePct) driverHudThrottlePct.textContent = pct(d.throttle);
  if (driverHudBrakePct) driverHudBrakePct.textContent = pct(d.brake);
  const speedPct = Number.isFinite(sp) ? Math.min(100, (sp / 340) * 100) : 0;
  const powerBar = Math.min(100, thrPct * 0.55 + speedPct * 0.45);
  setShiftLedsFromPower(powerBar);
  applyTelDrs(driverHudDrs, d.drs);
}

function updateTelemetryOverlay(frame) {
  if (!telemetryPanel || !telemetryInner) return;
  if (!sessionId || !selectedDriverCode) {
    telemetryPanel.hidden = true;
    setDriverBroadcastHudVisible(false);
    return;
  }
  const colors = sessionMeta?.driver_colors || {};
  const colorKey = getDriverKeyFromMap(colors, selectedDriverCode);
  const hex = normalizeHex(
    (colorKey && colors[colorKey]) || colors[selectedDriverCode] || '#888888',
  );

  if (isDriverBroadcastHud()) {
    telemetryPanel.hidden = true;
    setDriverBroadcastHudVisible(true);
    if (driverHudInner) driverHudInner.style.setProperty('--tel-accent', hex);

    if (!frame) {
      if (driverHudChip) {
        driverHudChip.textContent = selectedDriverCode;
        driverHudChip.style.background = hex;
      }
      if (driverHudCode) driverHudCode.textContent = selectedDriverCode;
      if (driverHudSub) driverHudSub.textContent = 'Loading telemetry…';
      const dash = '—';
      if (driverHudSpeedKmh) driverHudSpeedKmh.textContent = dash;
      if (driverHudSpeedMph) driverHudSpeedMph.textContent = dash;
      if (driverHudGear) driverHudGear.textContent = dash;
      if (driverHudTyre) driverHudTyre.textContent = dash;
      syncDriverHudGearStrip(Number.NaN);
      setShiftLedsFromPower(0);
      if (driverHudThrottleBar) driverHudThrottleBar.style.height = '0%';
      if (driverHudBrakeBar) driverHudBrakeBar.style.height = '0%';
      if (driverHudThrottlePct) driverHudThrottlePct.textContent = dash;
      if (driverHudBrakePct) driverHudBrakePct.textContent = dash;
      applyTelDrs(driverHudDrs, undefined);
      return;
    }

    const driverKey = getDriverKeyFromMap(frame.drivers, selectedDriverCode);
    const d = driverKey ? frame.drivers[driverKey] : undefined;
    const labelCode = driverKey || selectedDriverCode;

    if (!d) {
      if (driverHudChip) {
        driverHudChip.textContent = labelCode;
        driverHudChip.style.background = hex;
      }
      if (driverHudCode) driverHudCode.textContent = labelCode;
      if (driverHudSub) driverHudSub.textContent = 'Out of session';
      const dash = '—';
      if (driverHudSpeedKmh) driverHudSpeedKmh.textContent = dash;
      if (driverHudSpeedMph) driverHudSpeedMph.textContent = dash;
      if (driverHudGear) driverHudGear.textContent = dash;
      if (driverHudTyre) driverHudTyre.textContent = dash;
      syncDriverHudGearStrip(Number.NaN);
      setShiftLedsFromPower(0);
      if (driverHudThrottleBar) driverHudThrottleBar.style.height = '0%';
      if (driverHudBrakeBar) driverHudBrakeBar.style.height = '0%';
      if (driverHudThrottlePct) driverHudThrottlePct.textContent = dash;
      if (driverHudBrakePct) driverHudBrakePct.textContent = dash;
      applyTelDrs(driverHudDrs, undefined);
      return;
    }

    fillDriverBroadcastHud(d, labelCode, hex);
    return;
  }

  setDriverBroadcastHudVisible(false);
  telemetryPanel.hidden = false;
  telemetryInner.style.setProperty('--tel-accent', hex);

  if (!frame) {
    if (telChip) telChip.textContent = selectedDriverCode;
    if (telChip) telChip.style.background = hex;
    if (telCode) telCode.textContent = selectedDriverCode;
    if (telPos) telPos.textContent = 'Loading telemetry…';
    const dash = '—';
    if (telSpeed) telSpeed.textContent = dash;
    if (telGear) telGear.textContent = dash;
    if (telThrottle) telThrottle.textContent = dash;
    if (telBrake) telBrake.textContent = dash;
    if (telThrottleBar) telThrottleBar.style.width = '0%';
    if (telBrakeBar) telBrakeBar.style.width = '0%';
    applyTelDrs(telDrs, undefined);
    if (telTyre) telTyre.textContent = dash;
    if (telTyreLife) telTyreLife.textContent = dash;
    if (telTyreStint) telTyreStint.textContent = dash;
    if (telLap) telLap.textContent = dash;
    if (telDist) telDist.textContent = dash;
    return;
  }

  const driverKey = getDriverKeyFromMap(frame.drivers, selectedDriverCode);
  const d = driverKey ? frame.drivers[driverKey] : undefined;
  const labelCode = driverKey || selectedDriverCode;
  if (telChip) telChip.textContent = labelCode;
  if (telChip) telChip.style.background = hex;
  if (telCode) telCode.textContent = labelCode;

  if (!d) {
    if (telPos) telPos.textContent = 'Out of session';
    const dash = '—';
    if (telSpeed) telSpeed.textContent = dash;
    if (telGear) telGear.textContent = dash;
    if (telThrottle) telThrottle.textContent = dash;
    if (telBrake) telBrake.textContent = dash;
    if (telThrottleBar) telThrottleBar.style.width = '0%';
    if (telBrakeBar) telBrakeBar.style.width = '0%';
    applyTelDrs(telDrs, undefined);
    if (telTyre) telTyre.textContent = dash;
    if (telTyreLife) telTyreLife.textContent = dash;
    if (telTyreStint) telTyreStint.textContent = dash;
    if (telLap) telLap.textContent = dash;
    if (telDist) telDist.textContent = dash;
    return;
  }

  const sp = Number(d.speed);
  if (telPos) telPos.textContent = `P${d.position} · Lap ${d.lap}`;
  if (telSpeed)
    telSpeed.textContent = Number.isFinite(sp) ? String(Math.round(sp)) : '—';
  if (telGear)
    telGear.textContent =
      d.gear != null && Number.isFinite(Number(d.gear)) ? String(d.gear) : '—';
  if (telThrottle) telThrottle.textContent = pct(d.throttle);
  if (telBrake) telBrake.textContent = pct(d.brake);
  if (telThrottleBar) telThrottleBar.style.width = `${inputPct01(d.throttle)}%`;
  if (telBrakeBar) telBrakeBar.style.width = `${inputPct01(d.brake)}%`;
  applyTelDrs(telDrs, d.drs);
  if (telTyre) telTyre.textContent = tyreCompoundName(d.tyre);
  if (telTyreLife)
    telTyreLife.textContent = formatTyreLapsRemaining(d, sessionMeta);
  if (telTyreStint) telTyreStint.textContent = formatTyreStintLaps(d);
  if (telLap) telLap.textContent = String(d.lap ?? '—');
  const distN = Number(d.dist);
  if (telDist)
    telDist.textContent = Number.isFinite(distN)
      ? `${(distN / 1000).toFixed(2)} km`
      : '—';
}

function updateWeatherHud(frame) {
  if (!weatherPanel) return;
  const w = frame?.weather;
  if (!sessionId || !w) {
    weatherPanel.hidden = true;
    return;
  }
  weatherPanel.hidden = false;
  if (wxTrack) wxTrack.textContent = formatTempCelsiusFahrenheit(w.track_temp);
  if (wxAir) wxAir.textContent = formatTempCelsiusFahrenheit(w.air_temp);
  if (wxHumidity) wxHumidity.textContent = formatHumidityPct(w.humidity);
  if (wxWind)
    wxWind.textContent = formatWindLine(w.wind_speed, w.wind_direction);
  if (wxRain) wxRain.textContent = w.rain_state === 'RAINING' ? 'Wet' : 'Dry';
}

/**
 * Never await chunk I/O in this path — blocking rAF stalls wall-clock dt.
 * Playback advances `frameIndex` by elapsed time × telemetry FPS × speed (smooth sub-frame blend).
 * Chunks load in parallel; drawFrame blends or shows Loading until data arrives.
 */
function loop(ts) {
  if (!lastTs) lastTs = ts;
  let rawDt = (ts - lastTs) / 1000;
  lastTs = ts;
  rawDt = Math.min(rawDt, 0.25);

  if (sessionId && totalFrames > 0 && !paused) {
    const dt = Math.min(rawDt, 0.25);
    frameIndex += dt * sessionFps * playbackSpeed;
    if (frameIndex >= totalFrames) frameIndex = totalFrames - 1;
    if (frameIndex < 0) frameIndex = 0;
    scrub.value = String(Math.floor(frameIndex));
  }

  const nowWall = performance.now();
  if (sessionId && totalFrames > 0 && nowWall - lastReplayHashSyncMs > 900) {
    lastReplayHashSyncMs = nowWall;
    syncReplayHash();
  }
  if (
    sessionId &&
    !isStaticSessionId(sessionId) &&
    document.visibilityState === 'visible' &&
    nowWall - lastSessionKeepaliveMs >= SESSION_KEEPALIVE_MS
  ) {
    lastSessionKeepaliveMs = nowWall;
    const sid = sessionId;
    void fetch(
      apiUrl(`/api/session/${encodeURIComponent(sid)}/meta`),
      defaultFetchInit(),
    ).then((r) => {
      if (r.status === 404 && sessionId === sid) handleSessionGone();
    });
  }

  const idx = Math.floor(frameIndex);
  if (sessionId && totalFrames > 0) {
    void ensureChunkForFrame(idx).catch(() => {});
    if (idx < totalFrames - 1) {
      void ensureChunkForFrame(idx + 1).catch(() => {});
    }
    prefetchChunksAround(idx, paused ? 1 : playbackSpeed);
  }

  drawFrame();
  if (isViewMode3d()) trackView3d?.tick();
  requestAnimationFrame(loop);
}

async function prefetchNearby() {
  if (!sessionId) return;
  const i = Math.floor(frameIndex);
  try {
    const loads = [ensureChunkForFrame(i)];
    if (i < totalFrames - 1) loads.push(ensureChunkForFrame(i + 1));
    await Promise.all(loads);
    prefetchChunksAround(i, paused ? 1 : playbackSpeed);
  } catch (_) {
    /* retry on next frame / input */
  }
}

function onFrameChanged() {
  prefetchNearby().catch(() => {});
}

/** Set from init so hash autoload can await the same calendar loader. */
let loadCalendarRef = /** @type {null | (() => Promise<void>)} */ (null);

/**
 * Load the selected weekend session (static bundle or POST /api/session/load).
 * @param {number | null | undefined} initialFrame optional frame index after load (URL hash).
 */
async function loadSelectedSession(initialFrame) {
  if (!selectedEvent) return;
  const st = document.querySelector('input[name="stype"]:checked').value;
  if (isSessionScheduledInFuture(selectedEvent, st)) {
    loadStatus.classList.remove('load-status--ready');
    loadStatus.classList.add('load-status--error');
    loadStatus.textContent =
      'This session has not started yet — no replay data is available.';
    return;
  }
  loadStatus.textContent = '';
  loadStatus.classList.remove('load-status--ready', 'load-status--error');
  sessionGoneHandled = false;
  lastSessionKeepaliveMs = performance.now();
  chunkCache.clear();
  chunkInflight.clear();
  lbList.innerHTML = '';
  hideScrubHoverTip();
  sessionId = null;
  sessionMeta = null;
  selectedDriverCode = null;
  autoPickLeaderDone = false;
  btnPlay.disabled = true;
  btnPause.disabled = true;
  scrub.disabled = true;
  speedSelect.disabled = true;
  clearScrubMarkers();
  updateCopyReplayLinkButton();

  const year = parseInt(elYear.value, 10);
  const round = selectedEvent.round_number;
  const slug = makeReplaySlug(year, round, st);

  try {
    let data;
    let source = 'api';
    const bundle = await apiJson(
      `/api/static-replay-meta/${encodeURIComponent(slug)}`,
    );
    if (bundle.available && bundle.meta) {
      data = bundle.meta;
      sessionId = `static:${slug}`;
      source = 'static';
      showLoading('Loading replay bundle…');
    } else {
      showLoading('Loading session (about 20 seconds)…');
      const body = { year, round, session_type: st };
      data = await apiJson('/api/session/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      sessionId = data.session_id;
    }
    lastSessionKeepaliveMs = performance.now();

    totalFrames = data.total_frames;
    if (!totalFrames || totalFrames < 1) {
      throw new Error('Session has no frames.');
    }

    sessionMeta = data;
    {
      const f = Number(data.fps);
      sessionFps = Number.isFinite(f) && f > 0 && f < 240 ? f : FPS;
    }
    frameIndex = 0;
    paused = true;
    scrub.min = '0';
    scrub.max = String(Math.max(0, totalFrames - 1));
    scrub.value = '0';
    btnPlay.disabled = false;
    btnPause.disabled = false;
    scrub.disabled = false;
    speedSelect.disabled = false;

    const si = data.session_info;
    sessionBanner.hidden = false;
    const sessionLabel =
      st === 'S' ? 'Sprint' : st === 'Q' ? 'Qualifying' : 'Grand Prix';
    const srcNote =
      source === 'static' ? ' · static bundle' : ' · computed on server';
    sessionBanner.innerHTML = `<strong>${si.event_name}</strong> · ${si.circuit_name} · ${si.date}<br/>
        <span class="muted">${sessionLabel} · ${data.total_frames} frames @ ${data.fps ?? FPS} Hz${srcNote}</span>`;

    await ensureChunkForFrame(0);
    onFrameChanged();

    buildScrubMarkers();

    if (initialFrame != null && Number.isFinite(Number(initialFrame))) {
      const fi = Math.floor(Number(initialFrame));
      frameIndex = Math.min(Math.max(0, fi), totalFrames - 1);
      scrub.value = String(Math.floor(frameIndex));
    }

    syncReplayHash();

    loadStatus.classList.remove('load-status--error');
    loadStatus.classList.add('load-status--ready');
    loadStatus.textContent =
      source === 'static' ? 'Ready (offline bundle)' : 'Ready';
  } catch (e) {
    loadStatus.classList.remove('load-status--ready');
    loadStatus.classList.add('load-status--error');
    loadStatus.textContent = String(e.message || e);
  } finally {
    updateCopyReplayLinkButton();
    hideLoading();
  }
}

function markWelcomeDismissed() {
  document.documentElement.classList.add('welcome-seen');
  if (welcomeOverlay) welcomeOverlay.setAttribute('aria-hidden', 'true');
  updateCanvasHint();
}

async function tryReplayHashAutoload() {
  const h = parseReplayHash();
  if (!h || sessionId) return;
  elYear.value = String(h.y);
  if (!loadCalendarRef) return;
  await loadCalendarRef();
  const idx = calendarEvents.findIndex((ev) => ev.round_number === h.r);
  if (idx < 0) {
    if (loadStatus) {
      loadStatus.classList.remove('load-status--ready');
      loadStatus.classList.add('load-status--error');
      loadStatus.textContent = `No round ${h.r} in the ${h.y} calendar.`;
    }
    return;
  }
  eventSelect.value = String(idx);
  eventSelect.dispatchEvent(new Event('change'));
  const radio = document.querySelector(`input[name="stype"][value="${h.s}"]`);
  if (radio) {
    radio.checked = true;
    updateSessionTypeOptions();
  }
  await loadSelectedSession(h.f);
}

async function init() {
  resizeTrackViews();
  window.addEventListener('resize', () => {
    resizeTrackViews();
  });
  if (window.visualViewport) {
    const vv = window.visualViewport;
    vv.addEventListener('resize', () => {
      resizeTrackViews();
    });
    vv.addEventListener('scroll', () => {
      resizeTrackViews();
    });
  }

  const mqTouchUi = window.matchMedia('(hover: none) and (pointer: coarse)');
  const onTouchUiChange = () => {
    set3dHintText();
    setViewModeSliderTitle();
    resizeTrackViews();
  };
  if (typeof mqTouchUi.addEventListener === 'function') {
    mqTouchUi.addEventListener('change', onTouchUiChange);
  } else if (typeof mqTouchUi.addListener === 'function') {
    mqTouchUi.addListener(onTouchUiChange);
  }
  set3dHintText();

  if (
    document.documentElement.classList.contains('welcome-seen') &&
    welcomeOverlay
  ) {
    welcomeOverlay.setAttribute('aria-hidden', 'true');
  }

  if (welcomeStart && welcomeOverlay) {
    const dismissWelcome = () => {
      markWelcomeDismissed();
      elYear.focus();
      void tryReplayHashAutoload();
    };
    welcomeStart.addEventListener('click', dismissWelcome);
    document.addEventListener('keydown', (e) => {
      if (
        e.code === 'Escape' &&
        !document.documentElement.classList.contains('welcome-seen')
      ) {
        dismissWelcome();
      }
    });
  }
  updateCanvasHint();

  const staticDefault = await fetchJsonIfOk('/data/default-year.json');
  let defaultY =
    staticDefault != null && Number.isFinite(Number(staticDefault.year))
      ? Number(staticDefault.year)
      : new Date().getFullYear();
  const yearChoices = [...elYear.options].map((o) => parseInt(o.value, 10));
  if (yearChoices.length) {
    const lo = Math.min(...yearChoices);
    const hi = Math.max(...yearChoices);
    defaultY = Math.min(hi, Math.max(lo, defaultY));
  }
  elYear.value = String(defaultY);

  for (const s of PLAYBACK_SPEEDS) {
    const o = document.createElement('option');
    o.value = String(s);
    o.textContent = `${s}x`;
    if (s === 1) o.selected = true;
    speedSelect.appendChild(o);
  }

  async function loadCalendar() {
    scheduleStatus.textContent = 'Loading calendar…';
    try {
      const year = parseInt(elYear.value, 10);
      const data = await loadScheduleForYear(year);
      calendarEvents = data.events || [];
      eventSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose race';
      eventSelect.appendChild(placeholder);
      calendarEvents.forEach((ev, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `R${ev.round_number} · ${ev.event_name}`;
        eventSelect.appendChild(opt);
      });
      eventSelect.disabled = calendarEvents.length === 0;
      selectedEvent = null;
      sessionPanel.hidden = true;
      btnLoad.disabled = true;
      eventSelect.value = '';
      scheduleStatus.textContent =
        calendarEvents.length === 0
          ? 'No events'
          : `${calendarEvents.length} races`;
    } catch (e) {
      scheduleStatus.textContent = String(e.message || e);
      calendarEvents = [];
      eventSelect.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '—';
      eventSelect.appendChild(opt);
      eventSelect.disabled = true;
    }
  }

  loadCalendarRef = loadCalendar;

  elYear.addEventListener('change', () => {
    void loadCalendar();
  });

  void (async () => {
    const replayHash = parseReplayHash();
    if (replayHash) {
      markWelcomeDismissed();
      elYear.value = String(replayHash.y);
    }
    await loadCalendar();
    if (replayHash) {
      await tryReplayHashAutoload();
    }
  })();

  eventSelect.addEventListener('change', () => {
    const i = parseInt(eventSelect.value, 10);
    if (eventSelect.value === '' || Number.isNaN(i) || !calendarEvents[i]) {
      selectedEvent = null;
      sessionPanel.hidden = true;
      btnLoad.disabled = true;
      return;
    }
    const ev = calendarEvents[i];
    selectedEvent = ev;
    sessionPanel.hidden = false;
    /* New weekend: default to Grand Prix. Otherwise Qualifying/Sprint stays checked from the last event and Load pulls the wrong session. */
    const gpRadio = document.querySelector('input[name="stype"][value="R"]');
    if (gpRadio) gpRadio.checked = true;
    updateSessionTypeOptions();
    btnLoad.disabled = false;
  });

  btnLoad.addEventListener('click', () => {
    void loadSelectedSession(null);
  });
  if (btnCopyReplayLink) {
    btnCopyReplayLink.addEventListener('click', () => {
      void copyReplayLinkToClipboard();
    });
  }

  btnPlay.addEventListener('click', () => {
    paused = false;
  });
  btnPause.addEventListener('click', () => {
    paused = true;
  });
  speedSelect.addEventListener('change', () => {
    playbackSpeed = parseFloat(speedSelect.value);
  });
  scrub.addEventListener('input', () => {
    frameIndex = parseFloat(scrub.value);
    paused = true;
    syncReplayHash();
    void (async () => {
      try {
        await prefetchNearby();
      } catch (_) {
        /* next loop will retry */
      }
    })();
  });
  scrub.addEventListener('mousemove', (e) => {
    if (scrub.disabled) return;
    showScrubHoverTip(e.clientX, timeAtScrubClientX(e.clientX));
  });
  scrub.addEventListener('mouseleave', () => {
    hideScrubHoverTip();
  });

  document.addEventListener('keydown', (ev) => {
    const el = /** @type {HTMLElement | null} */ (ev.target);
    if (el?.isContentEditable) return;
    if (el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT') return;
    if (
      el?.tagName === 'INPUT' &&
      /** @type {HTMLInputElement} */ (el).type === 'text'
    )
      return;

    if (ev.code === 'Space' && sessionId) {
      ev.preventDefault();
      paused = !paused;
      return;
    }
    if (!sessionId || !totalFrames) return;
    if (ev.code === 'ArrowLeft') {
      ev.preventDefault();
      const step = ev.shiftKey ? sessionFps * 5 : 1;
      frameIndex = Math.max(0, frameIndex - step);
      if (scrub) scrub.value = String(Math.floor(frameIndex));
      paused = true;
      syncReplayHash();
      void prefetchNearby();
      return;
    }
    if (ev.code === 'ArrowRight') {
      ev.preventDefault();
      const step = ev.shiftKey ? sessionFps * 5 : 1;
      frameIndex = Math.min(totalFrames - 1, frameIndex + step);
      if (scrub) scrub.value = String(Math.floor(frameIndex));
      paused = true;
      syncReplayHash();
      void prefetchNearby();
      return;
    }
    if (ev.key >= '1' && ev.key <= '9') {
      const i = parseInt(ev.key, 10) - 1;
      if (PLAYBACK_SPEEDS[i] != null) {
        ev.preventDefault();
        playbackSpeed = PLAYBACK_SPEEDS[i];
        if (speedSelect) speedSelect.value = String(playbackSpeed);
      }
    }
  });

  if (leaderboardEl) {
    leaderboardEl.addEventListener('click', (e) => {
      const row = e.target.closest('.lb-row');
      if (!row) return;
      const raw = row.getAttribute('data-code') || row.dataset.code || '';
      if (!raw) return;
      const code = String(raw).trim();
      selectedDriverCode = code;
      autoPickLeaderDone = true;
      void (async () => {
        const idx = Math.floor(frameIndex);
        try {
          await ensureChunkForFrame(idx);
        } catch {
          /* drawFrame will retry */
        }
        updateTelemetryOverlay(getFrameBlendAt(frameIndex) ?? getFrameAt(idx));
      })();
    });
  }

  function closeTelemetrySelection() {
    selectedDriverCode = null;
    const frame = getFrameAt(Math.floor(frameIndex));
    updateTelemetryOverlay(frame ?? null);
  }
  if (telemetryClose) {
    telemetryClose.addEventListener('click', closeTelemetrySelection);
  }
  if (driverHudClose) {
    driverHudClose.addEventListener('click', closeTelemetrySelection);
  }

  const viewModeSlider = document.getElementById('view-mode-slider');
  const viewModeRow = document.querySelector('.view-mode-slider-row');
  if (viewModeSlider && viewModeRow) {
    const syncViewModeUi = () => {
      const is3d = viewModeSlider.value === '1';
      viewModeRow.dataset.mode = is3d ? '3d' : '2d';
      viewModeSlider.setAttribute('aria-valuenow', viewModeSlider.value);
      viewModeSlider.setAttribute('aria-valuetext', is3d ? '3D' : '2D');
      setViewModeSliderTitle();
    };
    const setViewModeFromValue = (v) => {
      const s = String(v);
      if (viewModeSlider.value === s) return;
      viewModeSlider.value = s;
      viewModeSlider.dispatchEvent(new Event('input', { bubbles: true }));
    };
    viewModeSlider.addEventListener('input', () => {
      syncViewModeUi();
      applyViewModeVisibility();
    });
    syncViewModeUi();
    applyViewModeVisibility();

    // Entire row (pill + 2D/3D labels): any click toggles — no drag, no hit zones.
    viewModeRow.addEventListener('click', (e) => {
      e.preventDefault();
      const next = viewModeSlider.value === '1' ? '0' : '1';
      setViewModeFromValue(next);
    });
  }

  if (cameraModeSelect) {
    cameraModeSelect.addEventListener('change', () => {
      void ensureTrackView3d().then((v) => {
        v.setCameraMode(
          /** @type {'free'|'follow'|'driver_pov'} */ (
            cameraModeSelect.value || 'free'
          ),
        );
      });
      const frame =
        getFrameBlendAt(frameIndex) ?? getFrameAt(Math.floor(frameIndex));
      updateTelemetryOverlay(frame ?? null);
      set3dHintText();
      sync3dCanvasHint();
    });
  }

  requestAnimationFrame(loop);
}

init();
