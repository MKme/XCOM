// XTOC-style settings port for XCOM (plain JS).
// Mirrors: xtoc-web/src/core/settings.ts (subset used by mapping).
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

const KEY_MAP_BASE = 'xtoc.map.base'
const KEY_MAP_RASTER_TEMPLATE = 'xtoc.map.rasterTemplate'

const KEY_FORCED_OFFLINE = 'xtoc.forcedOffline'

const KEY_MAP_DEFAULT_LAT = 'xtoc.map.defaultLat'
const KEY_MAP_DEFAULT_LON = 'xtoc.map.defaultLon'
const KEY_MAP_DEFAULT_ZOOM = 'xtoc.map.defaultZoom'

// Tactical map overlays
const KEY_TACTICAL_LAYER_IMPORTED = 'xtoc.tacticalMap.layers.imported'
const KEY_TACTICAL_LAYER_IMPORTED_LAST7 = 'xtoc.tacticalMap.layers.imported.last7d'
const KEY_TACTICAL_LAYER_IMPORTED_TPL_PREFIX = 'xtoc.tacticalMap.layers.imported.tpl.'
const KEY_TACTICAL_LAYER_MESH_NODES = 'xtoc.tacticalMap.layers.meshNodes'
const KEY_TACTICAL_TRUSTED_MODE = 'xtoc.tacticalMap.trustedMode'
const KEY_TACTICAL_HIDDEN_ITEMS = 'xtoc.tacticalMap.hiddenItems.v1'

// OpenMANET (node positions via openmanetd)
const KEY_OPENMANET_API_BASE_URL = 'xtoc.openmanet.apiBaseUrl'
const KEY_OPENMANET_REFRESH_MS = 'xtoc.openmanet.refreshMs'

function safePostForcedOfflineToServiceWorker(enabled) {
  try {
    if (!('serviceWorker' in navigator)) return

    const msg = { type: 'SET_FORCED_OFFLINE', enabled: !!enabled }

    try {
      navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage(msg)
    } catch (_) {
      // ignore
    }

    navigator.serviceWorker.ready
      .then((reg) => reg && reg.active && reg.active.postMessage(msg))
      .catch(() => {})
  } catch (_) {
    // ignore
  }
}

function getForcedOfflineEnabled() {
  try {
    return localStorage.getItem(KEY_FORCED_OFFLINE) === '1'
  } catch (_) {
    return false
  }
}

function setForcedOfflineEnabled(enabled) {
  const next = !!enabled
  try {
    if (next) localStorage.setItem(KEY_FORCED_OFFLINE, '1')
    else localStorage.removeItem(KEY_FORCED_OFFLINE)
  } catch (_) {
    // ignore
  }

  safePostForcedOfflineToServiceWorker(next)
}

function toggleForcedOfflineEnabled() {
  const next = !getForcedOfflineEnabled()
  setForcedOfflineEnabled(next)
  return next
}

function syncForcedOfflineToServiceWorker() {
  safePostForcedOfflineToServiceWorker(getForcedOfflineEnabled())
}

const GUARD_MARK = '__XCOM_FORCED_OFFLINE_GUARD_INSTALLED'

function isExternalHttpUrl(inputUrl) {
  let u
  try {
    u = new URL(String(inputUrl || ''), location && location.href ? location.href : 'http://localhost/')
  } catch (_) {
    return true
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false

  let origin = 'http://localhost'
  try {
    origin = location && location.origin ? location.origin : origin
  } catch (_) {
    // ignore
  }

  return u.origin !== origin
}

function requestUrlToString(input) {
  if (typeof input === 'string') return input
  try {
    if (typeof URL !== 'undefined' && input instanceof URL) return input.toString()
  } catch (_) {
    // ignore
  }
  try {
    // Request
    return input && input.url ? String(input.url) : String(input)
  } catch (_) {
    return String(input)
  }
}

function installForcedOfflineNetworkGuards() {
  try {
    if (globalThis && globalThis[GUARD_MARK]) return
    if (globalThis) globalThis[GUARD_MARK] = true
  } catch (_) {
    // ignore
  }

  if (typeof fetch !== 'function') return
  const origFetch = fetch.bind(globalThis)

  globalThis.fetch = async (input, init) => {
    if (!getForcedOfflineEnabled()) return origFetch(input, init)

    const urlString = requestUrlToString(input)
    if (!isExternalHttpUrl(urlString)) return origFetch(input, init)

    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    if (method === 'GET') {
      try {
        if (typeof caches !== 'undefined' && typeof Request !== 'undefined') {
          const req = new Request(urlString, init)
          const cached = await caches.match(req)
          if (cached) return cached
        }
      } catch (_) {
        // ignore
      }
    }

    throw new Error('Forced offline: external network calls are disabled.')
  }
}

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

// Trusted Mode (defaults OFF): only plot SECURE (decrypted) packets on the map.
function getTacticalMapTrustedModeEnabled() {
  return localStorage.getItem(KEY_TACTICAL_TRUSTED_MODE) === '1'
}

function setTacticalMapTrustedModeEnabled(enabled) {
  if (enabled) localStorage.setItem(KEY_TACTICAL_TRUSTED_MODE, '1')
  else localStorage.removeItem(KEY_TACTICAL_TRUSTED_MODE)
}

// ---- Tactical Map: hidden items ----

const MAX_TACTICAL_HIDDEN_ITEMS = 5000

function tacticalMapHiddenKey(kind, id) {
  return `${String(kind)}\u0000${String(id)}`
}

function getTacticalMapHiddenItems() {
  try {
    const raw = localStorage.getItem(KEY_TACTICAL_HIDDEN_ITEMS)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    const out = []
    const seen = new Set()
    for (const it of parsed) {
      if (!it || typeof it !== 'object') continue
      const kind = String(it.kind ?? '').trim()
      const id = String(it.id ?? '').trim()
      if (!kind || !id) continue
      const key = tacticalMapHiddenKey(kind, id)
      if (seen.has(key)) continue
      seen.add(key)

      const labelRaw = it.label
      const label = labelRaw != null ? String(labelRaw).trim() : ''

      const hiddenAtRaw = Number(it.hiddenAt)
      const hiddenAt = Number.isFinite(hiddenAtRaw) && hiddenAtRaw > 0 ? hiddenAtRaw : undefined

      out.push({ kind, id, label: label || undefined, hiddenAt })
      if (out.length >= MAX_TACTICAL_HIDDEN_ITEMS) break
    }

    return out
  } catch (_) {
    return []
  }
}

function setTacticalMapHiddenItems(items) {
  const next = []
  const seen = new Set()

  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue
    const kind = String(it.kind ?? '').trim()
    const id = String(it.id ?? '').trim()
    if (!kind || !id) continue
    const key = tacticalMapHiddenKey(kind, id)
    if (seen.has(key)) continue
    seen.add(key)

    const labelRaw = it.label
    const label = labelRaw != null ? String(labelRaw).trim() : ''

    const hiddenAtRaw = Number(it.hiddenAt)
    const hiddenAt = Number.isFinite(hiddenAtRaw) && hiddenAtRaw > 0 ? hiddenAtRaw : undefined

    next.push({ kind, id, label: label || undefined, hiddenAt })
    if (next.length >= MAX_TACTICAL_HIDDEN_ITEMS) break
  }

  try {
    if (!next.length) localStorage.removeItem(KEY_TACTICAL_HIDDEN_ITEMS)
    else localStorage.setItem(KEY_TACTICAL_HIDDEN_ITEMS, JSON.stringify(next))
  } catch (_) {
    // ignore
  }
}

function isTacticalMapItemHidden(kind, id) {
  const k = String(kind ?? '').trim()
  const i = String(id ?? '').trim()
  if (!k || !i) return false
  const key = tacticalMapHiddenKey(k, i)
  return getTacticalMapHiddenItems().some((x) => tacticalMapHiddenKey(String(x.kind ?? ''), String(x.id ?? '')) === key)
}

function hideTacticalMapItem(kind, id, label) {
  const k = String(kind ?? '').trim()
  const i = String(id ?? '').trim()
  if (!k || !i) return getTacticalMapHiddenItems()

  const lab = label != null ? String(label).trim() : ''
  const now = Date.now()

  const key = tacticalMapHiddenKey(k, i)
  const cur = getTacticalMapHiddenItems()
  const out = []
  let found = false

  for (const x of cur) {
    const xKind = String(x?.kind ?? '').trim()
    const xId = String(x?.id ?? '').trim()
    if (!xKind || !xId) continue
    const xKey = tacticalMapHiddenKey(xKind, xId)
    if (xKey === key) {
      found = true
      out.push({
        kind: k,
        id: i,
        label: lab || x.label,
        hiddenAt: (typeof x.hiddenAt === 'number' && Number.isFinite(x.hiddenAt) && x.hiddenAt > 0) ? x.hiddenAt : now,
      })
    } else {
      out.push(x)
    }
  }

  if (!found) out.unshift({ kind: k, id: i, label: lab || undefined, hiddenAt: now })
  setTacticalMapHiddenItems(out)
  return out
}

function unhideTacticalMapItem(kind, id) {
  const k = String(kind ?? '').trim()
  const i = String(id ?? '').trim()
  if (!k || !i) return getTacticalMapHiddenItems()
  const key = tacticalMapHiddenKey(k, i)
  const next = getTacticalMapHiddenItems().filter((x) => tacticalMapHiddenKey(String(x.kind ?? ''), String(x.id ?? '')) !== key)
  setTacticalMapHiddenItems(next)
  return next
}

function clearTacticalMapHiddenItems() {
  try { localStorage.removeItem(KEY_TACTICAL_HIDDEN_ITEMS) } catch (_) { /* ignore */ }
}

// OpenMANET
function getOpenManetApiBaseUrl() {
  return localStorage.getItem(KEY_OPENMANET_API_BASE_URL) || ''
}

function setOpenManetApiBaseUrl(url) {
  const v = String(url || '').trim().replace(/\/$/, '')
  if (!v) {
    localStorage.removeItem(KEY_OPENMANET_API_BASE_URL)
    return
  }
  localStorage.setItem(KEY_OPENMANET_API_BASE_URL, v)
}

function getOpenManetRefreshMs() {
  const s = localStorage.getItem(KEY_OPENMANET_REFRESH_MS)
  const n = s ? Number(s) : NaN
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 2000
}

function setOpenManetRefreshMs(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 500) return
  localStorage.setItem(KEY_OPENMANET_REFRESH_MS, String(Math.floor(n)))
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
  globalThis.getForcedOfflineEnabled = getForcedOfflineEnabled
  globalThis.setForcedOfflineEnabled = setForcedOfflineEnabled
  globalThis.toggleForcedOfflineEnabled = toggleForcedOfflineEnabled
  globalThis.syncForcedOfflineToServiceWorker = syncForcedOfflineToServiceWorker
  globalThis.installForcedOfflineNetworkGuards = installForcedOfflineNetworkGuards
  globalThis.getMapDefaultCoords = getMapDefaultCoords
  globalThis.setMapDefaultCoords = setMapDefaultCoords
  globalThis.getMapDefaultZoom = getMapDefaultZoom
  globalThis.setMapDefaultZoom = setMapDefaultZoom
  globalThis.getTacticalMapImportedEnabled = getTacticalMapImportedEnabled
  globalThis.setTacticalMapImportedEnabled = setTacticalMapImportedEnabled
  globalThis.getTacticalMapImportedLast7dOnly = getTacticalMapImportedLast7dOnly
  globalThis.setTacticalMapImportedLast7dOnly = setTacticalMapImportedLast7dOnly
  globalThis.getTacticalMapTrustedModeEnabled = getTacticalMapTrustedModeEnabled
  globalThis.setTacticalMapTrustedModeEnabled = setTacticalMapTrustedModeEnabled
  globalThis.tacticalMapHiddenKey = tacticalMapHiddenKey
  globalThis.getTacticalMapHiddenItems = getTacticalMapHiddenItems
  globalThis.setTacticalMapHiddenItems = setTacticalMapHiddenItems
  globalThis.isTacticalMapItemHidden = isTacticalMapItemHidden
  globalThis.hideTacticalMapItem = hideTacticalMapItem
  globalThis.unhideTacticalMapItem = unhideTacticalMapItem
  globalThis.clearTacticalMapHiddenItems = clearTacticalMapHiddenItems
  globalThis.getOpenManetApiBaseUrl = getOpenManetApiBaseUrl
  globalThis.setOpenManetApiBaseUrl = setOpenManetApiBaseUrl
  globalThis.getOpenManetRefreshMs = getOpenManetRefreshMs
  globalThis.setOpenManetRefreshMs = setOpenManetRefreshMs
  globalThis.getTacticalMapMeshNodesEnabled = getTacticalMapMeshNodesEnabled
  globalThis.setTacticalMapMeshNodesEnabled = setTacticalMapMeshNodesEnabled
  globalThis.getTacticalMapImportedTemplateEnabled = getTacticalMapImportedTemplateEnabled
  globalThis.setTacticalMapImportedTemplateEnabled = setTacticalMapImportedTemplateEnabled
} catch (_) {
  // ignore
}
