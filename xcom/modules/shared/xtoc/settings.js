// XTOC-style settings port for XCOM (plain JS).
// Mirrors: xtoc-web/src/core/settings.ts (subset used by mapping).
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

const KEY_MAP_BASE = 'xtoc.map.base'
const KEY_MAP_RASTER_TEMPLATE = 'xtoc.map.rasterTemplate'

const KEY_MAP_DEFAULT_LAT = 'xtoc.map.defaultLat'
const KEY_MAP_DEFAULT_LON = 'xtoc.map.defaultLon'
const KEY_MAP_DEFAULT_ZOOM = 'xtoc.map.defaultZoom'

// Map base style: online vector styles (dark/light) or offline raster.
// Keep values identical to XTOC for code reuse.
// 'offlineRasterDark' is a UI hint only; the offline style is raster.
function getMapBaseStyle() {
  const v = localStorage.getItem(KEY_MAP_BASE)
  if (v === 'light' || v === 'dark' || v === 'offlineRaster' || v === 'offlineRasterDark') return v
  return 'light'
}

function setMapBaseStyle(v) {
  localStorage.setItem(KEY_MAP_BASE, v)
}

function getMapRasterTemplate() {
  return localStorage.getItem(KEY_MAP_RASTER_TEMPLATE) ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
}

function setMapRasterTemplate(t) {
  localStorage.setItem(KEY_MAP_RASTER_TEMPLATE, String(t || ''))
}

function getMapDefaultCoords() {
  const slat = localStorage.getItem(KEY_MAP_DEFAULT_LAT)
  const slon = localStorage.getItem(KEY_MAP_DEFAULT_LON)
  const lat = slat ? Number(slat) : NaN
  const lon = slon ? Number(slon) : NaN

  // Default center (Knoxville-ish) to match XTOC.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat: 35.9606, lon: -83.9207 }
  return { lat, lon }
}

function setMapDefaultCoords(p) {
  if (!p) return
  localStorage.setItem(KEY_MAP_DEFAULT_LAT, String(p.lat))
  localStorage.setItem(KEY_MAP_DEFAULT_LON, String(p.lon))
}

function getMapDefaultZoom() {
  const s = localStorage.getItem(KEY_MAP_DEFAULT_ZOOM)
  const z = s ? Number(s) : NaN
  return Number.isFinite(z) ? z : 6
}

function setMapDefaultZoom(z) {
  if (!Number.isFinite(z)) return
  localStorage.setItem(KEY_MAP_DEFAULT_ZOOM, String(z))
}

// Expose globals (XCOM loads scripts as classic <script>).
try {
  globalThis.getMapBaseStyle = getMapBaseStyle
  globalThis.setMapBaseStyle = setMapBaseStyle
  globalThis.getMapRasterTemplate = getMapRasterTemplate
  globalThis.setMapRasterTemplate = setMapRasterTemplate
  globalThis.getMapDefaultCoords = getMapDefaultCoords
  globalThis.setMapDefaultCoords = setMapDefaultCoords
  globalThis.getMapDefaultZoom = getMapDefaultZoom
  globalThis.setMapDefaultZoom = setMapDefaultZoom
} catch (_) {
  // ignore
}
