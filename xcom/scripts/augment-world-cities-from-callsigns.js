#!/usr/bin/env node
/**
 * augment-world-cities-from-callsigns.js
 *
 * Goal: ensure every callsign QTH (city/state/province for US/Canada) has
 * a corresponding entry in world-cities.geojson so the offline geocoder
 * can always return *something* for plotting.
 *
 * Approach (offline-safe, no external APIs):
 * - Load assets/data/callsigns.json
 * - Load assets/data/world-cities.geojson
 * - For each unique (city, state, country) in the callsign data:
 *   - If geocoding that QTH with the existing gazetteer succeeds, do nothing.
 *   - Otherwise, synthesize a new Feature whose coordinates are the
 *     approximate centroid of the state/province (so at worst we plot at
 *     the right region, even if not the exact town).
 * - Write the augmented FeatureCollection back to world-cities.geojson.
 *
 * This script is meant to be run manually or in a data-prep step:
 *   node scripts/augment-world-cities-from-callsigns.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'assets', 'data');

// --- Helpers: state / province names & centroids ---

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

// Approximate centroids (or capitals) of US states (lat, lng)
const US_STATE_CENTROIDS = {
  AL: { lat: 32.8067, lng: -86.7911 },
  AK: { lat: 64.2008, lng: -149.4937 },
  AZ: { lat: 34.0489, lng: -111.0937 },
  AR: { lat: 35.2010, lng: -91.8318 },
  CA: { lat: 36.7783, lng: -119.4179 },
  CO: { lat: 39.5501, lng: -105.7821 },
  CT: { lat: 41.6032, lng: -73.0877 },
  DE: { lat: 38.9108, lng: -75.5277 },
  FL: { lat: 27.6648, lng: -81.5158 },
  GA: { lat: 32.1656, lng: -82.9001 },
  HI: { lat: 19.8968, lng: -155.5828 },
  ID: { lat: 44.0682, lng: -114.7420 },
  IL: { lat: 40.6331, lng: -89.3985 },
  IN: { lat: 40.2672, lng: -86.1349 },
  IA: { lat: 41.8780, lng: -93.0977 },
  KS: { lat: 39.0119, lng: -98.4842 },
  KY: { lat: 37.8393, lng: -84.2700 },
  LA: { lat: 30.9843, lng: -91.9623 },
  ME: { lat: 45.2538, lng: -69.4455 },
  MD: { lat: 39.0458, lng: -76.6413 },
  MA: { lat: 42.4072, lng: -71.3824 },
  MI: { lat: 44.3148, lng: -85.6024 },
  MN: { lat: 46.7296, lng: -94.6859 },
  MS: { lat: 32.3547, lng: -89.3985 },
  MO: { lat: 37.9643, lng: -91.8318 },
  MT: { lat: 46.8797, lng: -110.3626 },
  NE: { lat: 41.4925, lng: -99.9018 },
  NV: { lat: 38.8026, lng: -116.4194 },
  NH: { lat: 43.1939, lng: -71.5724 },
  NJ: { lat: 40.0583, lng: -74.4057 },
  NM: { lat: 34.5199, lng: -105.8701 },
  NY: { lat: 43.2994, lng: -74.2179 },
  NC: { lat: 35.7596, lng: -79.0193 },
  ND: { lat: 47.5515, lng: -101.0020 },
  OH: { lat: 40.4173, lng: -82.9071 },
  OK: { lat: 35.4676, lng: -97.5164 },
  OR: { lat: 43.8041, lng: -120.5542 },
  PA: { lat: 41.2033, lng: -77.1945 },
  RI: { lat: 41.5801, lng: -71.4774 },
  SC: { lat: 33.8361, lng: -81.1637 },
  SD: { lat: 43.9695, lng: -99.9018 },
  TN: { lat: 35.5175, lng: -86.5804 },
  TX: { lat: 31.9686, lng: -99.9018 },
  UT: { lat: 39.3210, lng: -111.0937 },
  VT: { lat: 44.5588, lng: -72.5778 },
  VA: { lat: 37.4316, lng: -78.6569 },
  WA: { lat: 47.7511, lng: -120.7401 },
  WV: { lat: 38.5976, lng: -80.4549 },
  WI: { lat: 43.7844, lng: -88.7879 },
  WY: { lat: 43.0759, lng: -107.2903 },
  DC: { lat: 38.9072, lng: -77.0369 }
};

// Approximate centroids for Canadian provinces/territories
const CA_PROVINCE_CENTROIDS = {
  AB: { lat: 53.9333, lng: -116.5765 },
  BC: { lat: 53.7267, lng: -127.6476 },
  MB: { lat: 53.7609, lng: -98.8139 },
  NB: { lat: 46.5653, lng: -66.4619 },
  NL: { lat: 53.1355, lng: -57.6604 },
  NS: { lat: 44.6820, lng: -63.7443 },
  NT: { lat: 64.8255, lng: -124.8457 },
  NU: { lat: 70.2998, lng: -83.1076 },
  ON: { lat: 51.2538, lng: -85.3232 },
  PE: { lat: 46.5107, lng: -63.4168 },
  QC: { lat: 52.9399, lng: -73.5491 },
  SK: { lat: 52.9399, lng: -106.4509 },
  YT: { lat: 64.2823, lng: -135.0000 }
};

function loadJson(file) {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required data file: ${full}`);
  }
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function buildGazetteer(geojson) {
  const feats = geojson.features || [];
  return feats.map((feat) => {
    const props = feat.properties || {};
    const coords = feat.geometry && feat.geometry.coordinates;
    const lat = coords ? coords[1] : props.latitude;
    const lng = coords ? coords[0] : props.longitude;
    return {
      name: (props.name || props.nameascii || '').toString(),
      admin0: (props.adm0name || props.sov0name || '').toString(),
      admin1: (props.adm1name || '').toString(),
      iso: (props.iso_a2 || '').toString(),
      lat,
      lng
    };
  }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function searchFirstPlace(places, query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let best = null;
  for (const p of places) {
    const haystacks = [
      p.name.toLowerCase(),
      p.admin0.toLowerCase(),
      p.admin1.toLowerCase()
    ];
    if (haystacks.some(h => h && h.includes(q))) {
      best = p;
      break;
    }
  }
  return best;
}

function normalizeCountry(raw) {
  const v = (raw || '').trim().toUpperCase();
  if (!v) return { label: '', iso: '' };
  if (v === 'USA' || v === 'US' || v === 'UNITED STATES' || v === 'UNITED STATES OF AMERICA') {
    return { label: 'United States of America', iso: 'US' };
  }
  if (v === 'CANADA' || v === 'CAN') {
    return { label: 'Canada', iso: 'CA' };
  }
  return { label: raw, iso: v.slice(0, 2) };
}

function getRegionMeta(st, coLabel) {
  const code = (st || '').trim().toUpperCase();
  if (!code) return null;

  if (coLabel === 'United States of America' || coLabel === 'USA' || coLabel === 'US') {
    const name = US_STATE_NAMES[code];
    const center = US_STATE_CENTROIDS[code];
    if (name && center) return { code, name, center };
  }

  if (coLabel === 'Canada' || coLabel === 'CAN') {
    const name = CA_PROVINCE_NAMES[code];
    const center = CA_PROVINCE_CENTROIDS[code];
    if (name && center) return { code, name, center };
  }

  // Try either table generically
  const nameUS = US_STATE_NAMES[code];
  const centerUS = US_STATE_CENTROIDS[code];
  if (nameUS && centerUS) return { code, name: nameUS, center: centerUS };

  const nameCA = CA_PROVINCE_NAMES[code];
  const centerCA = CA_PROVINCE_CENTROIDS[code];
  if (nameCA && centerCA) return { code, name: nameCA, center: centerCA };

  return null;
}

function main() {
  console.log('Loading callsigns and world-cities datasets...');
  const callsignsPayload = loadJson('callsigns.json');
  const worldCities = loadJson('world-cities.geojson');

  const records = callsignsPayload.records || [];
  const places = buildGazetteer(worldCities);

  console.log(`Loaded ${records.length.toLocaleString()} callsign records`);
  console.log(`Loaded ${places.length.toLocaleString()} existing world-city places`);

  // Build a set of unique QTHs to consider (US/Canada only)
  const qthMap = new Map();
  for (const rec of records) {
    const city = (rec.city || '').trim();
    const st = (rec.st || '').trim().toUpperCase();
    const rawCo = (rec.co || '').trim();
    const { label: coLabel, iso } = normalizeCountry(rawCo);

    if (!city && !st) continue;
    if (iso !== 'US' && iso !== 'CA') continue;

    const key = `${city.toUpperCase()}|${st}|${iso}`;
    if (!qthMap.has(key)) {
      qthMap.set(key, { city, st, coLabel, iso });
    }
  }

  console.log(`Unique US/CA QTHs from callsigns: ${qthMap.size.toLocaleString()}`);

  let alreadyCovered = 0;
  let added = 0;
  const newFeatures = [];

  for (const { city, st, coLabel, iso } of qthMap.values()) {
    const baseQuery = [city, st, coLabel].filter(Boolean).join(', ');

    // Try to find an existing place with current gazetteer logic
    let hit = null;
    if (city) {
      // Try just the city name first (most common)
      hit = searchFirstPlace(places, city);
    }
    if (!hit && baseQuery) {
      hit = searchFirstPlace(places, baseQuery);
    }

    if (hit) {
      alreadyCovered += 1;
      continue;
    }

    const region = getRegionMeta(st, coLabel);
    if (!region) {
      // No state/province centroid; skip (will remain unplottable until we know more)
      continue;
    }

    added += 1;

    const feature = {
      type: 'Feature',
      properties: {
        name: city || region.name,
        nameascii: city || region.name,
        adm0name: coLabel,
        adm1name: region.name,
        iso_a2: iso,
        pop_max: 0,
        pop_min: 0
      },
      geometry: {
        type: 'Point',
        coordinates: [region.center.lng, region.center.lat]
      }
    };

    newFeatures.push(feature);
  }

  console.log(`QTHs already covered by existing cities: ${alreadyCovered.toLocaleString()}`);
  console.log(`Synthesizing ${added.toLocaleString()} new pseudo-city features at state/province centroids`);

  if (!added) {
    console.log('No new features to add; world-cities.geojson already covers all QTHs.');
    return;
  }

  const augmented = {
    ...worldCities,
    features: [...(worldCities.features || []), ...newFeatures]
  };

  const outPath = path.join(DATA_DIR, 'world-cities.geojson');
  fs.writeFileSync(outPath, JSON.stringify(augmented));
  console.log(`Wrote augmented world-cities.geojson with ${(augmented.features || []).length.toLocaleString()} total features.`);

  // Also emit a JS payload so the offline geocoder can load data under file://
  // without relying on fetch, by loading assets/data/world-cities.js which sets
  // window.WORLD_CITIES_GEOJSON.
  const jsPath = path.join(DATA_DIR, 'world-cities.js');
  const jsPayload = `window.WORLD_CITIES_GEOJSON = ${JSON.stringify(augmented)};`;
  fs.writeFileSync(jsPath, jsPayload);
  console.log(`Wrote world-cities.js payload for browser/Electron use at ${jsPath}`);
}

main();
