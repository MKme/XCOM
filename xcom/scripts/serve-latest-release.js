#!/usr/bin/env node
/*
  Serve the most recently modified folder under ./releases
  (handy for `npm run preview` so you don't have to hardcode versions).

  Usage:
    node scripts/serve-latest-release.js --port 5179
*/

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const out = { port: 5179, host: '127.0.0.1' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = parseInt(argv[++i] || String(out.port), 10);
    else if (a === '--host') out.host = argv[++i] || out.host;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(__dirname, '..');
  const releasesDir = path.join(root, 'releases');

  if (!fs.existsSync(releasesDir)) {
    console.error('No releases/ folder found. Run `npm run build` first.');
    process.exit(1);
  }

  const entries = fs
    .readdirSync(releasesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(releasesDir, e.name);
      const stat = fs.statSync(full);
      return { name: e.name, full, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const latest = entries[0];
  if (!latest) {
    console.error('No release folders found under releases/. Run `npm run build` first.');
    process.exit(1);
  }

  const rel = path.relative(root, latest.full);
  const child = spawn(
    process.execPath,
    ['scripts/serve-static.js', '--dir', rel, '--port', String(args.port), '--host', String(args.host)],
    {
      cwd: root,
      stdio: 'inherit',
      shell: false,
    }
  );

  child.on('exit', (code) => process.exit(code ?? 0));
}

main();
