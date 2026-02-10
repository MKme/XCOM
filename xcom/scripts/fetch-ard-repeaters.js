#!/usr/bin/env node
/**
 * Fetches and converts the Amateur Repeater Directory (ARD) master list into
 * XCOM's offline repeater dataset JS file.
 *
 * Source repo (CC0): https://github.com/Amateur-Repeater-Directory/ARD-RepeaterList
 *
 * Default output:
 * - modules/repeater-map/repeater-data.js (used by the app)
 * - repeater-data.js (legacy mirror kept in sync by this script)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE_URL =
  'https://raw.githubusercontent.com/Amateur-Repeater-Directory/ARD-RepeaterList/main/MasterList/MasterRepeater.json';
const DEFAULT_OUT_FILE = path.join(ROOT, 'modules', 'repeater-map', 'repeater-data.js');
const DEFAULT_OUT_LEGACY_FILE = path.join(ROOT, 'repeater-data.js');

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
  console.log(`fetch-ard-repeaters

Usage:
  node scripts/fetch-ard-repeaters.js [--source <url|file>] [--out <file>] [--out-legacy <file>] [--no-legacy] [--help]

Defaults:
  --source     ${DEFAULT_SOURCE_URL}
  --out        ${path.relative(ROOT, DEFAULT_OUT_FILE)}
  --out-legacy ${path.relative(ROOT, DEFAULT_OUT_LEGACY_FILE)}
`);
}

async function readJsonFromUrl(url) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'XCOM-ard-repeaters-fetch/1.0',
      'Accept': 'application/json,*/*',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return await res.json();
}

function readJsonFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

const STATE_TO_ABBREV = {
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  'District of Columbia': 'DC',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY',
};

function toStateAbbrev(stateName) {
  const s = String(stateName || '').trim();
  if (!s) return '';
  if (/^[A-Z]{2}$/.test(s)) return s;
  return STATE_TO_ABBREV[s] || s;
}

function toFixedTrim(n, digits) {
  const s = Number(n).toFixed(digits);
  return s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function formatFrequencyMHz(n) {
  if (!Number.isFinite(Number(n))) return '';
  return Number(n).toFixed(3);
}

function formatOffsetMHz(rec) {
  const offset = Number(rec && rec.offset);
  if (!Number.isFinite(offset) || Math.abs(offset) < 1e-9) return 'simplex';

  let sign = String((rec && rec.offsetSign) || '').trim();
  if (sign !== '+' && sign !== '-') {
    const input = Number(rec && rec.inputFrequency);
    const output = Number(rec && rec.outputFrequency);
    if (Number.isFinite(input) && Number.isFinite(output) && input !== output) {
      sign = input > output ? '+' : '-';
    } else {
      sign = '+';
    }
  }

  const mag = toFixedTrim(Math.abs(offset), 3);
  return `${sign}${mag} MHz`;
}

function formatCtcssTone(n) {
  if (!Number.isFinite(Number(n)) || Number(n) <= 0) return '';
  return Number(n).toFixed(1);
}

function formatDcsCode(n) {
  if (!Number.isFinite(Number(n)) || Number(n) <= 0) return '';
  const code = Math.round(Number(n));
  return String(code).padStart(3, '0');
}

function formatTone(rec) {
  const mode = String((rec && rec.toneMode) || '').trim();

  if (mode === 'DTCS') {
    const code = formatDcsCode((rec && rec.ctcssRx) || (rec && rec.ctcssTx));
    return code ? `DCS ${code}` : 'DCS';
  }

  const tx = formatCtcssTone(rec && rec.ctcssTx);
  const rx = formatCtcssTone(rec && rec.ctcssRx);

  if (tx && rx && tx !== rx) return `TX ${tx} / RX ${rx}`;
  return tx || rx || 'none';
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeArdRecord(rec) {
  const id = clean(rec && rec.repeaterId);
  const callsign = clean(rec && rec.callsign);
  const band = clean(rec && rec.band);

  const lat = Number(rec && rec.latitude);
  const lng = Number(rec && rec.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const outputFrequency = Number(rec && rec.outputFrequency);
  if (!Number.isFinite(outputFrequency) || outputFrequency <= 0) return null;

  const nearestCity = clean(rec && rec.nearestCity);
  const stateName = clean(rec && rec.state);
  const state = toStateAbbrev(stateName);

  const entry = {
    id: id || `${callsign || 'repeater'}-${formatFrequencyMHz(outputFrequency)}-${lat.toFixed(5)}-${lng.toFixed(5)}`,
    frequency: formatFrequencyMHz(outputFrequency),
    offset: formatOffsetMHz(rec),
    tone: formatTone(rec),
    callsign: callsign || 'Unknown',
    location: nearestCity || state || 'Unknown',
    state: state || '',
    country: 'USA',
    lat,
    lng,
    mode: 'FM',
    band: band || '',
  };

  const noteParts = [];
  if (rec && rec.isOpen === false) noteParts.push('Closed');
  if (rec && rec.isOperational === false) noteParts.push('Not operational');
  if (rec && rec.isCoordinated === false) noteParts.push('Uncoordinated');
  const tags = [];
  if (rec && rec.ares) tags.push('ARES');
  if (rec && rec.races) tags.push('RACES');
  if (rec && rec.skywarn) tags.push('SKYWARN');
  if (tags.length) noteParts.push(tags.join('/'));
  if (noteParts.length) entry.notes = noteParts.join(' | ');

  return entry;
}

function stableSortKey(r) {
  return [
    clean(r.country),
    clean(r.state),
    clean(r.location),
    clean(r.callsign),
    clean(r.frequency),
    clean(r.id),
  ].join('|');
}

function buildMeta(sourceUrl, repeaters, raw) {
  const states = [...new Set(repeaters.map(r => r.state).filter(Boolean))].sort();
  const maxUpdated = (Array.isArray(raw) ? raw : [])
    .map(r => String(r && r.updatedDate || '').trim())
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || '';

  return {
    source: 'ARD-RepeaterList',
    sourceUrl,
    license: 'CC0-1.0',
    recordCount: repeaters.length,
    stateCount: states.length,
    states,
    maxUpdatedDate: maxUpdated,
    generatedAt: new Date().toISOString(),
  };
}

function jsHeader(meta) {
  const lines = [
    '// Repeater dataset built for XCOM from ARD-RepeaterList (CC0).',
    `// Source: ${meta.sourceUrl}`,
    `// Records: ${meta.recordCount} | States: ${meta.stateCount} | Max updated: ${meta.maxUpdatedDate || 'n/a'}`,
    `// Generated: ${meta.generatedAt}`,
    '',
  ];
  return lines.join('\n');
}

function helperFunctionsBlock() {
  // Keep these in sync with the existing in-browser helpers that other modules rely on.
  return `\n// Utility functions for filtering repeaters\nfunction getRepeatersInRadius(centerLat, centerLng, radiusKm, repeaters = repeaterData) {\n    return repeaters.filter(repeater => {\n        const distance = calculateDistance(centerLat, centerLng, repeater.lat, repeater.lng);\n        return distance <= radiusKm;\n    });\n}\n\nfunction calculateDistance(lat1, lng1, lat2, lng2) {\n    const R = 6371; // Earth's radius in kilometers\n    const dLat = (lat2 - lat1) * Math.PI / 180;\n    const dLng = (lng2 - lng1) * Math.PI / 180;\n    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +\n              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *\n              Math.sin(dLng/2) * Math.sin(dLng/2);\n    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));\n    return R * c;\n}\n\nfunction filterByBand(repeaters, band) {\n    if (band === 'all') return repeaters;\n    return repeaters.filter(repeater => repeater.band === band);\n}\n\nfunction filterByMode(repeaters, mode) {\n    if (mode === 'all') return repeaters;\n    return repeaters.filter(repeater => repeater.mode === mode);\n}\n\nfunction getAvailableBands() {\n    const bands = [...new Set(repeaterData.map(r => r.band))];\n    return bands.sort();\n}\n\nfunction getAvailableModes() {\n    const modes = [...new Set(repeaterData.map(r => r.mode))];\n    return modes.sort();\n}\n`;
}

function writeDataset(outPath, meta, repeaters) {
  ensureDir(path.dirname(outPath));

  const metaJson = JSON.stringify(meta, null, 2);
  const dataLines = repeaters.map((r) => `  ${JSON.stringify(r)}`);
  const js = [
    jsHeader(meta),
    `const REPEATER_DATA_META = ${metaJson};`,
    '',
    'const repeaterData = [',
    dataLines.join(',\n'),
    '];',
    '',
    '// Expose to window (classic scripts: helpers use the lexical binding, modules may prefer window).',
    'try {',
    '    window.repeaterData = repeaterData;',
    '    window.REPEATER_DATA_META = REPEATER_DATA_META;',
    '} catch (_) { /* ignore */ }',
    helperFunctionsBlock(),
    '',
  ].join('\n');

  fs.writeFileSync(outPath, js);
}

async function main() {
  if (getFlag('help')) {
    usage();
    process.exit(0);
  }

  const source = getArg('source', DEFAULT_SOURCE_URL);
  const out = path.resolve(ROOT, getArg('out', path.relative(ROOT, DEFAULT_OUT_FILE)));
  const outLegacy = path.resolve(ROOT, getArg('out-legacy', path.relative(ROOT, DEFAULT_OUT_LEGACY_FILE)));
  const writeLegacy = !getFlag('no-legacy');

  let raw;
  if (/^https?:\/\//i.test(source)) {
    console.log(`Fetching ARD master list: ${source}`);
    raw = await readJsonFromUrl(source);
  } else {
    const p = path.resolve(ROOT, source);
    console.log(`Reading ARD master list: ${p}`);
    raw = readJsonFromFile(p);
  }

  if (!Array.isArray(raw)) {
    throw new Error('Unexpected ARD payload: expected a JSON array');
  }

  const normalized = [];
  for (const rec of raw) {
    const r = normalizeArdRecord(rec);
    if (r) normalized.push(r);
  }

  // Stable ordering so diffs are meaningful when the source updates.
  normalized.sort((a, b) => stableSortKey(a).localeCompare(stableSortKey(b)));

  const meta = buildMeta(source, normalized, raw);

  writeDataset(out, meta, normalized);
  console.log(`Wrote: ${path.relative(ROOT, out)} (${normalized.length} records)`);

  if (writeLegacy) {
    writeDataset(outLegacy, meta, normalized);
    console.log(`Wrote: ${path.relative(ROOT, outLegacy)} (${normalized.length} records)`);
  } else {
    console.log('Skipping legacy mirror (--no-legacy).');
  }

  console.log(`States (${meta.stateCount}): ${meta.states.join(', ')}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

