// Shared MapLibre helpers for XCOM (XTOC-style mapping).
// Keeps MapLibre usage consistent across modules.
//
// Requirements:
// - maplibregl global (MapLibre GL)
// - getMapBaseStyle/getMapRasterTemplate

// OpenTopoMap raster tiles (topographic). Public tile servers have usage policies.
const TOPO_RASTER_TEMPLATE = 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png'

function buildMapLibreStyle() {
  const base = globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'
  const rasterTemplate = globalThis.getMapRasterTemplate
    ? globalThis.getMapRasterTemplate()
    : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

  // Keep consistent with XTOC basemap choices.
  // MapLibre demo tiles/styles can render a pink/green “missing tiles” debug pattern
  // when any referenced asset (tiles/glyphs/sprites) fails to load.
  const STYLE_DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
  const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/liberty'

  const isRaster = base === 'offlineRaster' || base === 'offlineRasterDark' || base === 'topo' || base === 'topoDark'
  if (isRaster) {
    const tpl = (base === 'topo' || base === 'topoDark')
      ? TOPO_RASTER_TEMPLATE
      : rasterTemplate
    return {
      version: 8,
      name: (base === 'topo' || base === 'topoDark') ? 'Topographic' : 'Offline Raster',
      sources: {
        raster: {
          type: 'raster',
          tiles: [tpl],
          tileSize: 256,
          attribution: 'Raster Tiles',
        },
      },
      layers: [{ id: 'raster', type: 'raster', source: 'raster' }],
    }
  }

  // Online vector style. If it fails offline, switch base to Offline Raster.
  return base === 'dark' ? STYLE_DARK : STYLE_LIGHT
}

function applyOfflineRasterDarkFilter(containerEl) {
  const base = globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'
  const isDarkRaster = base === 'offlineRasterDark' || base === 'topoDark'
  // Support callers that pass an element OR a string id.
  // (Some modules call createMapLibreMap({ container: 'map' }))
  if (!containerEl) return
  const el = typeof containerEl === 'string'
    ? document.getElementById(containerEl)
    : containerEl
  if (!el || typeof el.querySelector !== 'function') return
  const canvas = el.querySelector('canvas')
  if (!canvas) return
  canvas.style.filter = isDarkRaster ? 'invert(1) hue-rotate(180deg) brightness(0.95) contrast(1.05)' : ''
}

// Very small helper to create a basic map with the shared settings.
function createMapLibreMap({ container, centerLon, centerLat, zoom }) {
  if (!globalThis.maplibregl) throw new Error('MapLibre not loaded')

  // Normalize container arg. MapLibre itself accepts an HTMLElement or a string id,
  // but our helper also passes the container into applyOfflineRasterDarkFilter,
  // which expects a DOM element.
  const containerEl = typeof container === 'string'
    ? document.getElementById(container)
    : container
  if (!containerEl) throw new Error('MapLibre container not found')

  const map = new globalThis.maplibregl.Map({
    container: containerEl,
    style: buildMapLibreStyle(),
    center: [centerLon, centerLat],
    zoom,
    attributionControl: true,
  })
  map.addControl(new globalThis.maplibregl.NavigationControl(), 'top-right')
  map.on('render', () => {
    // In case canvas is recreated after setStyle.
    applyOfflineRasterDarkFilter(containerEl)
  })
  return map
}

try {
  globalThis.TOPO_RASTER_TEMPLATE = TOPO_RASTER_TEMPLATE
  globalThis.buildMapLibreStyle = buildMapLibreStyle
  globalThis.applyOfflineRasterDarkFilter = applyOfflineRasterDarkFilter
  globalThis.createMapLibreMap = createMapLibreMap
} catch (_) {
  // ignore
}
