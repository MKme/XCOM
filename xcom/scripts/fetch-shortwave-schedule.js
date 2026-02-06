#!/usr/bin/env node
/**
 * Fetches and converts a shortwave broadcast schedule into an offline JS dataset.
 *
 * Data source (default): EiBi schedule (plain text)
 * - http://www.eibispace.de/dx/eibi.txt
 *
 * Output (default):
 * - modules/shortwave/shortwave-data.js
 *
 * This script is safe to re-run to refresh the dataset for new schedule updates.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE_URL = 'http://www.eibispace.de/dx/eibi.txt';
const DEFAULT_OUT_FILE = path.join(ROOT, 'modules', 'shortwave', 'shortwave-data.js');

// "Shortwave" focus range (kHz). Keeps the dataset relevant for HF listening.
const MIN_KHZ = 1700;
const MAX_KHZ = 30000;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function getArg(name, fallback = '') {
  const key = `--${name}`;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === key) return argv[i + 1] || fallback;
    if (a.startsWith(`${key}=`)) return a.slice(key.length + 1) || fallback;
  }
  return fallback;
}

function getFlag(name) {
  const key = `--${name}`;
  return process.argv.slice(2).includes(key);
}

function usage() {
  console.log(`fetch-shortwave-schedule

Usage:
  node scripts/fetch-shortwave-schedule.js [--source <url>] [--out <file>] [--help]

Defaults:
  --source ${DEFAULT_SOURCE_URL}
  --out    ${path.relative(ROOT, DEFAULT_OUT_FILE)}
`);
}

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'XCOM-shortwave-fetch/1.0',
          'Accept': 'text/plain,*/*',
        },
      },
      (res) => {
        const code = res.statusCode || 0;
        const loc = res.headers.location || '';

        if ([301, 302, 303, 307, 308].includes(code) && loc && redirectsLeft > 0) {
          const next = new URL(loc, url).toString();
          res.resume();
          fetchText(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (code !== 200) {
          res.resume();
          reject(new Error(`HTTP ${code} from ${url}`));
          return;
        }

        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      },
    );

    req.on('error', reject);
    req.end();
  });
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseHHMM(hhmm) {
  const m = /^(\d{2})(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 24) return null;
  if (mm < 0 || mm > 59) return null;
  const minutes = hh * 60 + mm;
  return minutes === 1440 ? 1440 : minutes;
}

function dayIndexFromDigit(d) {
  // EiBi digits: 1=Mon ... 7=Sun
  const n = Number(d);
  if (!Number.isFinite(n) || n < 1 || n > 7) return null;
  return n - 1;
}

function dayIndexFromAbbrev(tok) {
  const t = String(tok || '').trim().slice(0, 2).toLowerCase();
  const map = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };
  return Object.prototype.hasOwnProperty.call(map, t) ? map[t] : null;
}

function addDay(mask, idx) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0 || i > 6) return mask;
  return mask | (1 << i);
}

function addRange(mask, startIdx, endIdx) {
  if (startIdx === null || endIdx === null) return mask;
  if (startIdx <= endIdx) {
    for (let i = startIdx; i <= endIdx; i++) mask = addDay(mask, i);
    return mask;
  }
  // Wrap (e.g., We-Mo)
  for (let i = startIdx; i <= 6; i++) mask = addDay(mask, i);
  for (let i = 0; i <= endIdx; i++) mask = addDay(mask, i);
  return mask;
}

function parseDaysMask(days) {
  const s0 = String(days || '').trim();
  if (!s0) return 127; // daily

  const s = s0.replace(/\s/g, '');

  // Numeric forms: 1234567, 1-5, 1,3,5
  if (/[0-7]/.test(s) && !/[a-z]/i.test(s)) {
    let mask = 0;
    const parts = s.split(',');
    for (const p of parts) {
      if (!p) continue;
      if (p.includes('-')) {
        const [a, b] = p.split('-', 2);
        const ai = dayIndexFromDigit(a);
        const bi = dayIndexFromDigit(b);
        mask = addRange(mask, ai, bi);
      } else {
        for (const ch of p) {
          const di = dayIndexFromDigit(ch);
          if (di !== null) mask = addDay(mask, di);
        }
      }
    }
    return mask || 127;
  }

  // Abbrev forms: Mo-Fr, Mo,We, Su, We-Mo
  let mask = 0;
  const parts = s.split(',');
  for (const p of parts) {
    if (!p) continue;
    if (p.includes('-')) {
      const [a, b] = p.split('-', 2);
      const ai = dayIndexFromAbbrev(a);
      const bi = dayIndexFromAbbrev(b);
      mask = addRange(mask, ai, bi);
    } else {
      const di = dayIndexFromAbbrev(p);
      if (di !== null) mask = addDay(mask, di);
    }
  }
  return mask || 127;
}

function parseEibi(text) {
  const lines = String(text || '').split(/\r?\n/);

  const meta = {
    source: DEFAULT_SOURCE_URL,
    season: '',
    valid: '',
    lastUpdate: '',
    generatedAt: new Date().toISOString(),
    freqRangeKHz: [MIN_KHZ, MAX_KHZ],
  };

  for (const line of lines.slice(0, 80)) {
    const l = String(line || '').trim();
    const seasonMatch = /^BC\s+([A-Z]\d{2})\s+-/i.exec(l);
    if (seasonMatch && !meta.season) meta.season = seasonMatch[1].toUpperCase();

    const validMatch = /^Valid\s+(.+)$/i.exec(l);
    if (validMatch && !meta.valid) meta.valid = clean(validMatch[1]);

    const updateMatch = /^Last update:\s*(.+)$/i.exec(l);
    if (updateMatch && !meta.lastUpdate) meta.lastUpdate = clean(updateMatch[1]);
  }

  const entries = [];

  for (const rawLine of lines) {
    if (!rawLine) continue;
    if (!/^\s*\d/.test(rawLine)) continue;

    const line = String(rawLine).padEnd(80, ' ');
    const freqStr = line.slice(0, 14).trim();
    const timeStr = line.slice(14, 24).trim();
    if (!/^\d{4}-\d{4}$/.test(timeStr)) continue;

    const daysStr = line.slice(24, 30).trim();
    const itu = clean(line.slice(30, 34));
    const station = clean(line.slice(34, 57));
    const lang = clean(line.slice(57, 63));
    const target = clean(line.slice(63, 72));
    const remarks = clean(line.slice(72));

    const freq = Number(freqStr);
    if (!Number.isFinite(freq)) continue;
    if (freq < MIN_KHZ || freq > MAX_KHZ) continue;

    const [startHHMM, endHHMM] = timeStr.split('-', 2);
    const start = parseHHMM(startHHMM);
    const endRaw = parseHHMM(endHHMM);
    if (start === null || endRaw === null) continue;

    const end = endHHMM === '2400' ? 1440 : endRaw;
    const daysMask = parseDaysMask(daysStr);

    entries.push({
      freq,
      start,
      end,
      days: daysStr,
      daysMask,
      itu,
      station,
      lang,
      target,
      remarks,
    });
  }

  return { meta, entries };
}

function buildJsDataset(data) {
  const headerLines = [];
  headerLines.push('// Shortwave schedule dataset (EiBi)');
  headerLines.push(`// Source: ${data && data.meta && data.meta.source ? data.meta.source : DEFAULT_SOURCE_URL}`);
  headerLines.push(`// Generated: ${new Date().toISOString()}`);
  headerLines.push(`// Filter: ${MIN_KHZ}-${MAX_KHZ} kHz`);
  headerLines.push('// NOTE: This file is generated by scripts/fetch-shortwave-schedule.js');
  headerLines.push('');

  const js = `${headerLines.join('\n')}\nconst shortwaveScheduleData = ${JSON.stringify(data)};\n`;
  return js;
}

async function main() {
  if (getFlag('help') || getFlag('h')) {
    usage();
    process.exit(0);
  }

  const source = getArg('source', DEFAULT_SOURCE_URL) || DEFAULT_SOURCE_URL;
  const outFile = path.resolve(ROOT, getArg('out', path.relative(ROOT, DEFAULT_OUT_FILE)) || DEFAULT_OUT_FILE);

  console.log(`Fetching: ${source}`);
  const text = await fetchText(source);
  const parsed = parseEibi(text);
  parsed.meta.source = source;

  ensureDir(path.dirname(outFile));
  const outJs = buildJsDataset(parsed);
  fs.writeFileSync(outFile, outJs, 'utf8');

  console.log(`Wrote: ${path.relative(ROOT, outFile)}`);
  console.log(`Entries: ${parsed.entries.length.toLocaleString()}`);
  if (parsed.meta.season) console.log(`Season: ${parsed.meta.season}`);
  if (parsed.meta.valid) console.log(`Valid: ${parsed.meta.valid}`);
  if (parsed.meta.lastUpdate) console.log(`Last update: ${parsed.meta.lastUpdate}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

