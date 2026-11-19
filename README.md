# asdfbase-web

asdfbase (Discord web client) frontend — pre-built static export, hosted on
Render so it is reachable from the school PC (the original
`asdfbase.onrender.com` is blocked there).

## What this is

- A static export of the live Render build (fetched 2026-11-19). No source, no
  build step — the files in this repo ARE the site.
- `server.js` is a small Express server: it serves these static files and
  proxies `/api/*` and `/uploads/*` to the backend at
  `https://api-asdf.rds9.net`, streaming both directions. The proxy streams
  (it pipes the response), so Server-Sent Events (SSE) realtime works —
  the Render Static Site rewrite proxy buffers SSE, which is why the
  static-site deployment hangs on "connecting".
- The backend itself stays on the VPS; only the frontend host changes.

## Deploy (Render Web Service — the school-PC route)

1. Render → New → Web Service → Public Git Repository →
   `https://github.com/rds9dev/asdfbase-web`, branch `main`.
2. Environment: **Node**. Build Command: `npm install`.
   Start Command: `node server.js`. Plan: **Free**.
3. Deploy. The URL will be `https://<name>.onrender.com`.
4. Free web services spin down after 15 min idle — keep it awake with a
   cron that hits `<url>/api/health` every 5 min (e.g. from the VPS).

## Deploy (Render Static Site — fallback, SSE does NOT work)

- `asdfbase2` (srv-dbvdm06tlv9c738imk50) is the static-site deployment.
  Its `/api/*` and `/uploads/*` are proxied by Render dashboard
  Redirects/Rewrites rules (Render does NOT read `_redirects`).
  SSE hangs on "connecting" there; use the in-app
  "リアルタイム通信方式" setting → ロングポーリング as a workaround.

## Deploy (Vercel — fallback, blocked from school)

- `vercel.json` proxies `/api/*` and `/uploads/*` to the backend
  (Vercel rewrites, server-side). Deploy with
  `~/workspace/asdfbase-pages/vercel_deploy.py`. `vercel.app` is
  blocked from the school PC, so this is a fallback only.

## Updating

When the Render build changes, re-export the build (fetch from
`https://asdfbase.onrender.com`) and push the new files here.
Render services created from a public Git URL do NOT auto-deploy —
trigger a Manual Deploy from the Render dashboard after pushing.

## Notes

- The Cloudflare Pages version of the same build exists at `asdfbase.pages.dev`
  but returns empty HTTP 500 for all new Pages projects on this
  account (Cloudflare-side fault).
- The GAS proxy version (`~/workspace/asdfbase-gas/Code.gs`, v3.3.1) remains
  the fallback that works through script.google.com.
- Render Hobby (free) bandwidth is 5 GB/month per workspace, then
  $0.15/GB (with a card on file) or suspension (without one).
  cdn.discordapp.com is blocked from the school PC, so Discord-hosted
  media does not load directly there.
