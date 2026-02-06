// Area-of-Operations (AO) helpers.
// Ported from xtoc-web/src/core/ao.ts.
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid import/export.

function approxRadiusKmForZoom(z) {
  const clamped = Math.max(3, Math.min(15, z))
  const km = 250 * Math.pow(0.52, clamped - 6)
  return Math.max(3, Math.min(600, km))
}

function kmToLatDegrees(km) {
  return km / 110.574
}

function kmToLonDegrees(km, atLat) {
  const denom = 111.320 * Math.cos((atLat * Math.PI) / 180)
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-6) return km / 111.320
  return km / denom
}

function clampLat(lat) {
  return Math.max(-90, Math.min(90, lat))
}

function clampLon(lon) {
  let x = lon
  while (x > 180) x -= 360
  while (x < -180) x += 360
  return x
}

function deriveBoundsFromCenterZoom(lat, lon, zoom) {
  const rKm = approxRadiusKmForZoom(zoom)
  const dLat = kmToLatDegrees(rKm)
  const dLon = kmToLonDegrees(rKm, lat)
  const west = clampLon(lon - dLon)
  const east = clampLon(lon + dLon)
  const south = clampLat(lat - dLat)
  const north = clampLat(lat + dLat)
  return { west, south, east, north }
}

function pointInBounds(p, b) {
  if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) return false
  const lat = p.lat
  const lon = p.lon
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east
}

function defaultAoFromSavedMapView() {
  const c = globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 35.9606, lon: -83.9207 }
  const z = globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 6
  return {
    lat: c.lat,
    lon: c.lon,
    bounds: deriveBoundsFromCenterZoom(c.lat, c.lon, z),
    source: 'mapView',
  }
}

function formatBoundsShort(b) {
  return `${b.south.toFixed(2)},${b.west.toFixed(2)} → ${b.north.toFixed(2)},${b.east.toFixed(2)}`
}

const DEFAULT_AO_PRESETS = [
  {
    key: 'saved',
    label: 'Saved AO (Map View)',
    lat: (globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 35.9606, lon: -83.9207 }).lat,
    lon: (globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 35.9606, lon: -83.9207 }).lon,
    zoomHint: globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 6,
  },
  { key: 'knox', label: 'Knoxville (default)', lat: 35.9606, lon: -83.9207, zoomHint: 10 },
  { key: 'dc', label: 'Washington DC', lat: 38.8898, lon: -77.0091, zoomHint: 10 },
  { key: 'ramstein', label: 'Ramstein AB', lat: 49.4369, lon: 7.6003, zoomHint: 10 },
]

try {
  globalThis.deriveBoundsFromCenterZoom = deriveBoundsFromCenterZoom
  globalThis.pointInBounds = pointInBounds
  globalThis.defaultAoFromSavedMapView = defaultAoFromSavedMapView
  globalThis.formatBoundsShort = formatBoundsShort
  globalThis.DEFAULT_AO_PRESETS = DEFAULT_AO_PRESETS
} catch (_) {
  // ignore
}
