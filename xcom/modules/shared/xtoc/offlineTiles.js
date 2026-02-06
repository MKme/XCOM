// Offline raster tile caching.
// Ported from xtoc-web/src/core/offlineTiles.ts.
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

const TILE_CACHE_NAME = 'xtoc.tiles.v1'

function fillTileTemplate(t, z, x, y) {
  return String(t).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

function lonLatToTileXY(lon, lat, z) {
  const latRad = (lat * Math.PI) / 180
  const n = Math.pow(2, z)
  const x = Math.floor(((lon + 180) / 360) * n)
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x, y }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

function boundsToTileRange(bounds, z) {
  const nw = lonLatToTileXY(bounds.west, bounds.north, z)
  const se = lonLatToTileXY(bounds.east, bounds.south, z)
  const n = Math.pow(2, z)

  const xMin = clamp(Math.min(nw.x, se.x), 0, n - 1)
  const xMax = clamp(Math.max(nw.x, se.x), 0, n - 1)
  const yMin = clamp(Math.min(nw.y, se.y), 0, n - 1)
  const yMax = clamp(Math.max(nw.y, se.y), 0, n - 1)

  return { xMin, xMax, yMin, yMax }
}

async function cacheTilesForBounds(args) {
  const { template, bounds, minZoom, maxZoom, maxTiles, onProgress } = args

  const cache = await caches.open(TILE_CACHE_NAME)

  const tiles = []
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = boundsToTileRange(bounds, z)
    for (let x = r.xMin; x <= r.xMax; x++) {
      for (let y = r.yMin; y <= r.yMax; y++) {
        const url = fillTileTemplate(template, z, x, y)
        tiles.push({ z, x, y, url })
        if (tiles.length > maxTiles) {
          throw new Error(`Tile download too large (${tiles.length} > ${maxTiles}). Reduce area or max zoom.`)
        }
      }
    }
  }

  let done = 0
  let cached = 0

  for (const t of tiles) {
    done++
    onProgress && onProgress({ done, total: tiles.length, z: t.z, x: t.x, y: t.y })

    const req = new Request(t.url, { mode: 'cors' })
    const hit = await cache.match(req)
    if (hit) continue

    const res = await fetch(req)
    if (!res.ok) continue

    await cache.put(req, res)
    cached++
  }

  return { total: tiles.length, cached }
}

async function clearTileCache() {
  await caches.delete(TILE_CACHE_NAME)
}

// Debug helper: counts cached requests in the tile cache.
// (Not exact disk usage; just a quick sanity check that caching is working.)
async function countTileCacheEntries() {
  const cache = await caches.open(TILE_CACHE_NAME)
  const keys = await cache.keys()
  return keys.length
}

// Expose globals
try {
  globalThis.XTOC_TILE_CACHE_NAME = TILE_CACHE_NAME
  globalThis.fillTileTemplate = fillTileTemplate
  globalThis.lonLatToTileXY = lonLatToTileXY
  globalThis.boundsToTileRange = boundsToTileRange
  globalThis.cacheTilesForBounds = cacheTilesForBounds
  globalThis.clearTileCache = clearTileCache
  globalThis.countTileCacheEntries = countTileCacheEntries
} catch (_) {
  // ignore
}
