// asdfbase frontend server (Express) — serves the static SPA and proxies
// /api/* and /uploads/* to the backend, streaming both directions.
// This replaces the Render Static Site rewrite proxy, which buffers
// Server-Sent Events (SSE) so realtime hangs on "connecting".
// (The old asdfbase.onrender.com was an Express service too — that's
// why SSE worked there.)
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');

const BACKEND = process.env.ASDF_BACKEND || 'https://api-asdf.rds9.net';
const PORT = parseInt(process.env.PORT || '10000', 10);
const app = express();

// Proxy /api and /uploads to the backend, streaming (no buffering).
function proxyToBackend(req, res) {
  let target;
  try {
    target = new URL(BACKEND + req.originalUrl);
  } catch {
    return res.status(400).send('Bad URL');
  }
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: target.host };
  const proxyReq = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      // Stream the backend response straight through (SSE keeps flowing).
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.setTimeout(0); // long-lived SSE: no timeout on the upstream socket
  proxyReq.on('timeout', () => proxyReq.destroy());
  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).send('Bad Gateway');
    else res.end();
  });
  req.pipe(proxyReq); // stream the request body (uploads)
  req.on('aborted', () => proxyReq.destroy());
}

app.use('/api', proxyToBackend);
app.use('/uploads', proxyToBackend);

// Static frontend (index.html, assets/, favicon, manifest).
app.use(
  express.static(__dirname, {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      // index.html must not be cached (it references hashed assets).
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);
// SPA fallback.
app.use((req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = app.listen(PORT, () =>
  console.log(`asdfbase listening on ${PORT}, backend ${BACKEND}`)
);
// SSE holds connections open indefinitely — Node's default 5 min
// request timeout would kill the stream, so disable it.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65000;
