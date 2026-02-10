// XTOC-style settings port for XCOM (plain JS).
// Mirrors: xtoc-web/src/core/settings.ts (subset used by mapping).
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

const KEY_MAP_BASE = 'xtoc.map.base'
const KEY_MAP_RASTER_TEMPLATE = 'xtoc.map.rasterTemplate'

const KEY_MAP_DEFAULT_LAT = 'xtoc.map.defaultLat'
const KEY_MAP_DEFAULT_LON = 'xtoc.map.defaultLon'
const KEY_MAP_DEFAULT_ZOOM = 'xtoc.map.defaultZoom'

// Tactical map overlays
const KEY_TACTICAL_LAYER_IMPORTED = 'xtoc.tacticalMap.layers.imported'
const KEY_TACTICAL_LAYER_IMPORTED_LAST7 = 'xtoc.tacticalMap.layers.imported.last7d'
const KEY_TACTICAL_LAYER_IMPORTED_TPL_PREFIX = 'xtoc.tacticalMap.layers.imported.tpl.'
const KEY_TACTICAL_LAYER_MESH_NODES = 'xtoc.tacticalMap.layers.meshNodes'

// Map base style: online vector styles (dark/light) or offline raster.
// Keep values identical to XTOC for code reuse.
// 'offlineRasterDark' and 'topoDark' are UI hints only; the style is raster + a display filter.
function getMapBaseStyle() {
  const v = localStorage.getItem(KEY_MAP_BASE)
  if (v === 'light' || v === 'dark' || v === 'topo' || v === 'topoDark' || v === 'offlineRaster' || v === 'offlineRasterDark') return v
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

// Imported overlay (defaults ON if unset)
function getTacticalMapImportedEnabled() {
  return localStorage.getItem(KEY_TACTICAL_LAYER_IMPORTED) !== '0'
}

function setTacticalMapImportedEnabled(enabled) {
  localStorage.setItem(KEY_TACTICAL_LAYER_IMPORTED, enabled ? '1' : '0')
}

// Default ON: keep map responsive by hiding older imported markers.
function getTacticalMapImportedLast7dOnly() {
  return localStorage.getItem(KEY_TACTICAL_LAYER_IMPORTED_LAST7) !== '0'
}

function setTacticalMapImportedLast7dOnly(enabled) {
  localStorage.setItem(KEY_TACTICAL_LAYER_IMPORTED_LAST7, enabled ? '1' : '0')
}

// Mesh nodes overlay (defaults ON if unset)
function getTacticalMapMeshNodesEnabled() {
  return localStorage.getItem(KEY_TACTICAL_LAYER_MESH_NODES) !== '0'
}

function setTacticalMapMeshNodesEnabled(enabled) {
  localStorage.setItem(KEY_TACTICAL_LAYER_MESH_NODES, enabled ? '1' : '0')
}

// Per-template toggles for Imported overlay (defaults ON if unset)
function getTacticalMapImportedTemplateEnabled(templateId) {
  const t = Number(templateId || 0)
  if (!Number.isFinite(t) || t <= 0) return true
  return localStorage.getItem(`${KEY_TACTICAL_LAYER_IMPORTED_TPL_PREFIX}${String(t)}`) !== '0'
}

function setTacticalMapImportedTemplateEnabled(templateId, enabled) {
  const t = Number(templateId || 0)
  if (!Number.isFinite(t) || t <= 0) return
  localStorage.setItem(`${KEY_TACTICAL_LAYER_IMPORTED_TPL_PREFIX}${String(t)}`, enabled ? '1' : '0')
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
  globalThis.getTacticalMapImportedEnabled = getTacticalMapImportedEnabled
  globalThis.setTacticalMapImportedEnabled = setTacticalMapImportedEnabled
  globalThis.getTacticalMapImportedLast7dOnly = getTacticalMapImportedLast7dOnly
  globalThis.setTacticalMapImportedLast7dOnly = setTacticalMapImportedLast7dOnly
  globalThis.getTacticalMapMeshNodesEnabled = getTacticalMapMeshNodesEnabled
  globalThis.setTacticalMapMeshNodesEnabled = setTacticalMapMeshNodesEnabled
  globalThis.getTacticalMapImportedTemplateEnabled = getTacticalMapImportedTemplateEnabled
  globalThis.setTacticalMapImportedTemplateEnabled = setTacticalMapImportedTemplateEnabled
} catch (_) {
  // ignore
}
