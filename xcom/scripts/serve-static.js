#!/usr/bin/env node
/*
  Tiny static file server for XCOM development/preview.

  Why this exists:
  - Avoids `npx http-server` deprecation noise / extra downloads
  - Keeps dev output clean (important when validating UI/layout)
  - No external deps

  Usage:
    node scripts/serve-static.js --dir . --port 5174
    node scripts/serve-static.js --dir releases/xcom-1.0.0 --port 5179
*/

const http = require('http');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { dir: '.', port: 5174, host: '127.0.0.1' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i] || out.dir;
    else if (a === '--port') out.port = parseInt(argv[++i] || String(out.port), 10);
    else if (a === '--host') out.host = argv[++i] || out.host;
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

function safeJoin(root, reqPath) {
  const cleaned = decodeURIComponent(reqPath.split('?')[0] || '/');
  const rel = cleaned.replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  if (!full.startsWith(rootAbs)) return null;
  return full;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(process.cwd(), args.dir);
  const port = Number.isFinite(args.port) ? args.port : 5174;
  const host = args.host || '127.0.0.1';

  const server = http.createServer((req, res) => {
    try {
      const urlPath = (req.url || '/');
      let full = safeJoin(root, urlPath);
      if (!full) return send(res, 400, 'Bad request');

      // Directory -> serve index.html
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        full = path.join(full, 'index.html');
      }

      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return send(res, 404, 'Not found');
      }

      const ext = path.extname(full).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      const data = fs.readFileSync(full);

      // Disable caching for local validation so formatting/CSS changes are immediate.
      // (Service worker is already disabled on localhost by registerSW.js.)
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, max-age=0',
      };
      return send(res, 200, data, headers);
    } catch (err) {
      return send(res, 500, `Server error: ${err && err.message ? err.message : String(err)}`);
    }
  });

  server.listen(port, host, () => {
    // Intentionally keep output minimal.
    console.log(`http://${host}:${port}`);
  });
}

main();
