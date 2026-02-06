#!/usr/bin/env node
/**
 * Sanity check for callsign plotting:
 *
 * - Loads the offline callsign database (assets/data/callsigns.json)
 * - Loads the offline gazetteer (assets/data/world-cities.geojson)
 * - For a sample of callsign records, tries to geocode their QTH
 *   using logic similar to the runtime module.
 * - Fails (non‑zero exit) if nothing can be geocoded or if success
 *   rate drops below a configurable threshold.
 *
 * This is intended to be run in CI as:
 *   npm run test-callsign-geo
 */

const fs = require('fs');
const path = require('path');

// --- Config ---

// Max number of callsign records to test (to keep runtime reasonable)
const MAX_RECORDS = parseInt(process.env.CALLSIGN_GEO_MAX || '2000', 10);

// Minimum acceptable success ratio (0–1) before we consider geocoding "broken".
// This is intentionally modest because the gazetteer won't include every
// small town/village in the FCC/ISED data.
const MIN_SUCCESS_RATIO = parseFloat(process.env.CALLSIGN_GEO_MIN_RATIO || '0.4');

// --- Helpers: state / province expansion (keep in sync with callsign-lookup.js) ---

const US_STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
};

const CA_PROVINCE_NAMES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon'
};

// --- Load datasets ---

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'assets', 'data');

function loadJson(file) {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required data file: ${full}`);
  }
  const raw = fs.readFileSync(full, 'utf8');
  return JSON.parse(raw);
}

function buildGazetteer(geojson) {
  const feats = geojson.features || [];
  return feats
    .map((feat) => {
      const props = feat.properties || {};
      const coords = feat.geometry && feat.geometry.coordinates;
      const lat = coords ? coords[1] : props.latitude;
      const lng = coords ? coords[0] : props.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        name: (props.name || props.nameascii || '').toString(),
        alt: (props.namealt || '').toString(),
        admin0: (props.adm0name || props.sov0name || '').toString(),
        admin1: (props.adm1name || '').toString(),
        iso: (props.iso_a2 || '').toString(),
        pop: props.pop_max || props.pop_min || 0,
        lat,
        lng,
      };
    })
    .filter(Boolean);
}

function searchFirstPlace(places, query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  let best = null;
  for (const p of places) {
    const haystacks = [
      p.name.toLowerCase(),
      p.alt.toLowerCase(),
      p.admin0.toLowerCase(),
      p.admin1.toLowerCase(),
    ];
    if (haystacks.some((h) => h && h.includes(q))) {
      if (!best || (p.pop || 0) > (best.pop || 0)) {
        best = p;
      }
    }
  }
  return best;
}

function buildQueriesForRecord(rec) {
  const city = (rec.city || '').trim();
  const st = (rec.st || '').trim().toUpperCase();
  const co = (rec.co || '').trim();

  const queries = [];

  // 1) Raw composite: "City, ST, Country"
  if (city || st || co) {
    queries.push([city, st, co].filter(Boolean).join(', '));
  }

  // 2) With expanded state/province names
  let regionName = null;
  if (st) {
    if (co === 'USA' || co === 'US' || co === 'United States') {
      regionName = US_STATE_NAMES[st] || null;
    } else if (co === 'Canada' || co === 'CAN') {
      regionName = CA_PROVINCE_NAMES[st] || null;
    } else {
      regionName = US_STATE_NAMES[st] || CA_PROVINCE_NAMES[st] || null;
    }
  }

  if (regionName) {
    if (city) {
      queries.push([city, regionName, co].filter(Boolean).join(', '));
      queries.push([city, regionName].filter(Boolean).join(', '));
    }
    queries.push([regionName, co].filter(Boolean).join(', '));
    queries.push(regionName);
  }

  // Deduplicate while preserving order
  const seen = new Set();
  return queries
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .filter((q) => {
      const key = q.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function tryGeocodeRecord(places, rec) {
  const queries = buildQueriesForRecord(rec);
  for (const q of queries) {
    const hit = searchFirstPlace(places, q);
    if (hit) {
      return {
        queryTried: q,
        placeName: hit.name,
        admin1: hit.admin1,
        admin0: hit.admin0,
        lat: hit.lat,
        lng: hit.lng,
      };
    }
  }
  return null;
}

function main() {
  console.log('Loading callsigns.json and world-cities.geojson...');
  const callsignsPayload = loadJson('callsigns.json');
  const geo = loadJson('world-cities.geojson');

  const records = callsignsPayload.records || [];
  if (!records.length) {
    throw new Error('No callsign records found in callsigns.json');
  }

  const places = buildGazetteer(geo);
  if (!places.length) {
    throw new Error('No places found in world-cities.geojson');
  }

  const sample = records.slice(0, MAX_RECORDS);
  console.log(`Testing geocoding for ${sample.length} callsign records...`);

  let tested = 0;
  let success = 0;
  const failures = [];

  for (const rec of sample) {
    // Require at least a city or state; skip totally blank QTH
    if (!rec.city && !rec.st) continue;

    tested += 1;
    const hit = tryGeocodeRecord(places, rec);
    if (hit) {
      success += 1;
    } else if (failures.length < 25) {
      failures.push({
        callsign: rec.c,
        city: rec.city,
        st: rec.st,
        co: rec.co,
      });
    }
  }

  if (!tested) {
    throw new Error('No callsign records with city/state information to test');
  }

  const ratio = success / tested;
  console.log(`Geocoding success: ${success}/${tested} records (${(ratio * 100).toFixed(1)}%)`);

  if (failures.length) {
    console.log('Sample failures (first 25):');
    for (const f of failures) {
      console.log(`  - ${f.callsign || 'UNKNOWN'} :: ${[f.city, f.st, f.co].filter(Boolean).join(', ')}`);
    }
  }

  if (ratio < MIN_SUCCESS_RATIO) {
    console.error(
      `FAIL: success ratio ${(ratio * 100).toFixed(1)}% is below minimum ${(MIN_SUCCESS_RATIO * 100).toFixed(1)}%`,
    );
    process.exit(1);
  }

  console.log('PASS: callsign geocoding sanity check looks healthy.');
}

main();
