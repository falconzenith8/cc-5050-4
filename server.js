#!/usr/bin/env node
// Minimal static server for the browser app. It serves `public/` at the root
// and the shared ESM modules under `/src/` and `/node_modules/` where needed.
// No build step: the browser imports the same files the CLI does.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.svg': 'image/svg+xml',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const p = path.normalize(path.join(root, decoded));
  if (!p.startsWith(root + path.sep) && p !== root) return null;
  return p;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath;

  if (url.pathname.startsWith('/src/')) {
    filePath = safeJoin(path.join(ROOT, 'src'), url.pathname.slice('/src'.length));
  } else if (url.pathname.startsWith('/public/')) {
    filePath = safeJoin(PUBLIC, url.pathname.slice('/public'.length));
  } else if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  } else {
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = safeJoin(PUBLIC, rel);
  }

  if (!filePath) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
      // Needed if shared memory/threads ever get used; harmless now.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

const port = Number(process.env.PORT || 5173);
server.listen(port, () => {
  console.log(`master-format-lab listening on http://localhost:${port}`);
});
