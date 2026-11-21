// asdfbase frontend server (Express) — serves the static SPA and proxies
// /api/* and /uploads/* to the backend, streaming both directions.
// This replaces the Render Static Site rewrite proxy, which buffers
// Server-Sent Events (SSE) so realtime hangs on "connecting".
// (The old asdfbase.onrender.com was an Express service too — that's
// why SSE worked there.)
//
// Also proxies /bridge/* to the ai-bridge (via api.rds9.net) for the
// ai-bridge dashboard: verifies the page password (X-Bridge-Password)
// against BRIDGE_PAGE_PASSWORD_HASH, injects the Bearer token
// (BRIDGE_TOKEN) when forwarding, and streams SSE. WebSocket upgrades
// for /bridge/ws are proxied to the bridge upstream.
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');

const BACKEND = process.env.ASDF_BACKEND || 'https://api-asdf.rds9.net';
const BRIDGE_UPSTREAM = process.env.BRIDGE_UPSTREAM || 'https://api.rds9.net';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const BRIDGE_PAGE_PASSWORD_HASH = process.env.BRIDGE_PAGE_PASSWORD_HASH || '';
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

// ---- ai-bridge proxy (/bridge/*) ----
function bridgePasswordOk(provided) {
  if (!provided || !BRIDGE_PAGE_PASSWORD_HASH) return false;
  const idx = BRIDGE_PAGE_PASSWORD_HASH.indexOf(':');
  if (idx < 0) return false;
  const salt = BRIDGE_PAGE_PASSWORD_HASH.slice(0, idx);
  const expected = BRIDGE_PAGE_PASSWORD_HASH.slice(idx + 1);
  const actual = crypto.createHash('sha256').update(salt + provided).digest('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function bridgeCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bridge-Password');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function proxyToBridge(req, res) {
  // CORS preflight: answer here, do not forward upstream.
  if (req.method === 'OPTIONS') {
    bridgeCors(res);
    return res.status(204).end();
  }
  const auth = req.headers.authorization || '';
  const pw = req.headers['x-bridge-password'] || '';
  let bearer = '';
  if (BRIDGE_TOKEN && auth === 'Bearer ' + BRIDGE_TOKEN) {
    bearer = auth;
  } else if (bridgePasswordOk(pw)) {
    bearer = 'Bearer ' + BRIDGE_TOKEN;
  } else {
    bridgeCors(res);
    return res.status(401).json({ detail: 'unauthorized' });
  }
  let target;
  try {
    // req.originalUrl is like /bridge/notes?x=1; the upstream serves the
    // same /bridge/* path on api.rds9.net.
    target = new URL(BRIDGE_UPSTREAM + req.originalUrl);
  } catch {
    bridgeCors(res);
    return res.status(400).send('Bad URL');
  }
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: target.host, authorization: bearer };
  delete headers['x-bridge-password']; // never forward the page password upstream
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
      bridgeCors(res);
      const h = { ...proxyRes.headers };
      delete h['access-control-allow-origin'];
      delete h['access-control-allow-headers'];
      delete h['access-control-allow-methods'];
      res.writeHead(proxyRes.statusCode, h);
      proxyRes.pipe(res);
    }
  );
  proxyReq.setTimeout(0); // long-lived SSE: no timeout on the upstream socket
  proxyReq.on('timeout', () => proxyReq.destroy());
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      bridgeCors(res);
      res.status(502).send('Bad Gateway');
    } else res.end();
  });
  req.pipe(proxyReq);
  req.on('aborted', () => proxyReq.destroy());
}

app.use('/api', proxyToBackend);
app.use('/uploads', proxyToBackend);
app.use('/bridge', proxyToBridge);

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
  console.log(`asdfbase listening on ${PORT}, backend ${BACKEND}, bridge ${BRIDGE_UPSTREAM}`)
);
// SSE holds connections open indefinitely — Node's default 5 min
// request timeout would kill the stream, so disable it.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65000;

// WebSocket upgrade proxy for /bridge/ws -> bridge upstream.
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/bridge/ws') {
    socket.destroy();
    return;
  }
  let target;
  try {
    target = new URL(BRIDGE_UPSTREAM + req.url);
  } catch {
    socket.destroy();
    return;
  }
  const isSecure = target.protocol === 'https:';
  const lib = isSecure ? https : http;
  const headers = { ...req.headers, host: target.host };
  const proxyReq = lib.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isSecure ? 443 : 80),
    path: target.pathname + target.search,
    method: 'GET',
    headers,
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    let headerLines = '';
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      headerLines += `${k}: ${v}\r\n`;
    }
    socket.write(statusLine + headerLines + '\r\n');
    if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
    if (head && head.length) socket.unshift(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => {
      try {
        socket.destroy();
      } catch {}
    });
    socket.on('error', () => {
      try {
        proxySocket.destroy();
      } catch {}
    });
  });
  proxyReq.on('error', () => {
    try {
      socket.destroy();
    } catch {}
  });
  proxyReq.end();
});
