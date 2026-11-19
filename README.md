# asdfbase-web

asdfbase (Discord web client) frontend — pre-built static export, hosted on Vercel
so it is reachable from the school PC (onrender.com is blocked there).

## What this is

- A static export of the live Render build (fetched 2026-11-19). No source, no
  build step — the files in this repo ARE the site.
- `vercel.json` proxies `/api/*` and `/uploads/*` to the backend at
  `https://api-asdf.rds9.net` (Vercel rewrites, server-side). The backend itself
  stays on the VPS; only the frontend host changes.

## Deploy (Vercel dashboard)

1. Vercel → Add New → Project → Import Git Repository → pick this repo.
2. Framework Preset: **Other**. Build Command: leave empty (no build).
   Root Directory: `./`. Output Directory: leave default.
3. Deploy. The URL will be `https://asdfbase-web.vercel.app`
   (rename the project to `asdfbase` in Vercel settings for
   `https://asdfbase.vercel.app`).

## Updating

When the Render build changes, re-export the build (fetch from
`https://asdfbase.onrender.com`) and push the new files here; Vercel
redeploys automatically on push to `main`.

## Notes

- The Cloudflare Pages version of the same build exists at `asdfbase.pages.dev`
  but currently returns empty HTTP 500 for all new Pages projects on this
  account (Cloudflare-side fault, under investigation).
- The GAS proxy version (`~/workspace/asdfbase-gas/Code.gs`, v3.3.1) remains
  the fallback that works through script.google.com.
