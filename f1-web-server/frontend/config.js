/**
 * Backend base URL for `/api/*` only (no trailing slash). `/data/*` is same-origin (this site).
 * Default: same origin (API served with this static site). For a separate API host, set
 * `NEXT_PUBLIC_API_BASE` (or `PUBLIC_API_BASE` / `API_BASE`) at build time — see
 * `scripts/write-vercel-config.js` — or assign `window.__API_BASE__` before other scripts load.
 */
window.__API_BASE__ = '';
