/*
  XCOM Service Worker

  Goals:
  - Cache app shell (HTML/CSS/JS + local vendor assets)
  - Cache offline tile packs (assets/tiles/.../{z}/{x}/{y}.png)
  - Work when hosted from a subfolder (use relative URLs and scope './')

  This intentionally mirrors the XTOC approach: aggressive caching for app assets,
  and a dedicated cache for tiles.
*/

// Bump this any time you change styling/assets and need clients to refresh caches.
const VERSION = 'xcom.sw.v23'
const APP_CACHE = `${VERSION}.app`
const TILE_CACHE = `${VERSION}.tiles`

let forcedOffline = false

// XTOC-style offline raster tile cache used by offlineTiles.js
const XTOC_TILE_CACHE = 'xtoc.tiles.v1'

// Minimal “app shell” list. We still do a runtime CacheFirst for same-origin GETs.
const CORE_ASSETS = [
  './',
  './index.html',
  './styles/main.css',
  './app-main.js',
  './registerSW.js',
  './manifest.webmanifest',
  './assets/icon.svg',

  // Vendor libs used by Comms
  './assets/vendor/noble-ciphers.iife.min.js',
  './assets/vendor/qrcode.iife.min.js',
  './assets/vendor/qr-scanner.umd.min.js',
  './assets/vendor/qr-scanner-worker.min.js',

  // Web Workers (keep UI responsive when loading large offline datasets)
  './modules/shared/callsign-db.worker.js',
]

function uniqStrings(list) {
  const out = []
  const seen = new Set()
  for (const v of list || []) {
    const s = String(v || '').trim()
    if (!s) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

async function cacheAddAllSettled(cache, urls, opts = {}) {
  const list = uniqStrings(urls || [])
  if (!list.length) return

  const concurrencyRaw = Number(opts.concurrency)
  const concurrency = Number.isFinite(concurrencyRaw) ? Math.max(1, Math.min(32, Math.floor(concurrencyRaw))) : 8

  let idx = 0
  const runOne = async () => {
    while (idx < list.length) {
      const url = list[idx++]
      try {
        // Use Request so we can consistently attach options later if needed.
        // (cache.add() uses Request(url) internally anyway.)
        // eslint-disable-next-line no-await-in-loop
        await cache.add(new Request(url))
      } catch {
        // best-effort
      }
    }
  }

  const workers = []
  const n = Math.min(concurrency, list.length)
  for (let i = 0; i < n; i++) workers.push(runOne())
  await Promise.all(workers)
}

function extractLocalAssetUrlsFromJs(jsText) {
  const text = String(jsText || '')
  const matches = []

  // Pull out quoted string literals that look like local asset paths.
  // We intentionally avoid caching extremely large datasets here.
  const re = /['"]((?:modules|styles|assets)\/[^'"]+\.(?:js|css|svg|png|webmanifest|json|geojson))['"]/g
  let m = null
  while ((m = re.exec(text)) !== null) {
    const path = String(m[1] || '').trim()
    if (!path) continue
    if (path === 'assets/data/callsigns.json' || path === 'assets/data/callsigns.js') continue
    matches.push(`./${path}`)
  }

  return uniqStrings(matches)
}

function buildWorldTilePackUrls(maxZoomInclusive = 6) {
  const maxZ = Math.max(0, Math.min(12, Math.floor(maxZoomInclusive)))
  const urls = []
  for (let z = 0; z <= maxZ; z++) {
    const n = 1 << z
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        urls.push(`./assets/tiles/world/${z}/${x}/${y}.png`)
      }
    }
  }
  return urls
}

async function fetchWithTimeout(request, timeoutMs) {
  const ms = Math.max(0, Number(timeoutMs) || 0)
  if (ms <= 0 || typeof AbortController === 'undefined') {
    return fetch(request)
  }

  const ctrl = new AbortController()
  const t = setTimeout(() => {
    try { ctrl.abort() } catch { /* ignore */ }
  }, ms)
  try {
    return await fetch(request, { signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

function isTileRequest(url) {
  // Cache slippy tiles under assets/tiles/.../{z}/{x}/{y}.png|jpg|jpeg|webp
  const p = url.pathname
  const extOk = p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.jpeg') || p.endsWith('.webp')
  if (!extOk) return false
  if (!p.includes('/assets/tiles/')) return false
  return /\/\d+\/\d+\/\d+\./.test(p)
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE)
      await cacheAddAllSettled(cache, CORE_ASSETS, { concurrency: 8 })

      // Pre-cache module scripts/styles so modules can open instantly offline.
      // We discover these from app-main.js so the list stays up to date.
      try {
        const res = await fetchWithTimeout(new Request('./app-main.js', { cache: 'no-store' }), 6000)
        if (res && res.ok) {
          const js = await res.text()
          const discovered = extractLocalAssetUrlsFromJs(js)
          await cacheAddAllSettled(cache, discovered, { concurrency: 8 })
        }
      } catch {
        // ignore
      }

      // Optional: cache the built-in low-zoom world basemap pack (if shipped).
      // This prevents “black map” when offline before any tiles were downloaded.
      try {
        const tiles = await caches.open(TILE_CACHE)
        const worldPack = buildWorldTilePackUrls(6)
        await cacheAddAllSettled(tiles, worldPack, { concurrency: 16 })
      } catch {
        // ignore
      }

      self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith('xcom.sw.') && k !== APP_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k)),
      )
      self.clients.claim()
    })(),
  )
})

function reply(event, msg) {
  // Prefer MessageChannel reply when provided.
  const port = event && event.ports && event.ports[0]
  if (port) {
    try {
      port.postMessage(msg)
      return
    } catch {
      // Fall through.
    }
  }

  // Fallback: reply to the sender client.
  try {
    if (event && event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(msg)
    }
  } catch {
    // ignore
  }
}

// Allow the page to trigger an update immediately and query the SW build version.
self.addEventListener('message', (event) => {
  const data = event && event.data
  if (!data) return

  const type = typeof data === 'string' ? data : data.type

  if (type === 'SET_FORCED_OFFLINE') {
    forcedOffline = !!(data && typeof data === 'object' ? data.enabled : false)
    return
  }

  if (type === 'SKIP_WAITING') {
    event.waitUntil(
      (async () => {
        try {
          await self.skipWaiting()
        } catch {
          // ignore
        }
        try {
          await self.clients?.claim?.()
        } catch {
          // ignore
        }
      })(),
    )
    return
  }

  if (type !== 'GET_SW_BUILD_VERSION') return

  event.waitUntil(
    (async () => {
      const requestId = data && (data.requestId ?? data.id)
      reply(event, { type: 'SW_BUILD_VERSION', version: VERSION, requestId })
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (!req) return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }

  // Allow *cross-origin* tile requests for the offline raster cache.
  // The Map module downloads tiles into Cache Storage (xtoc.tiles.v1) using the
  // full tile URL (often https://...). When offline, MapLibre will re-request
  // those same URLs, which only a SW can intercept.
  const isExternal = url.origin !== self.location.origin

  if (forcedOffline && isExternal) {
    event.respondWith(
      (async () => {
        if (req.method === 'GET') {
          try {
            const cached = await caches.match(req)
            if (cached) return cached
          } catch {
            // ignore
          }
        }

        return new Response('Forced offline: external network calls are disabled.', {
          status: 503,
          statusText: 'FORCED_OFFLINE',
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            // Allow scripts to observe the status in CORS fetches.
            'Access-Control-Allow-Origin': '*',
          },
        })
      })(),
    )
    return
  }

  if (req.method !== 'GET') return

  const baseIsImage = req.destination === 'image' || /\.(png|jpg|jpeg|webp)(\?|$)/i.test(url.pathname)
  const looksLikeSlippy = /\/\d+\/\d+\/\d+\.(png|jpg|jpeg|webp)$/i.test(url.pathname)
  const isProbablyTile = baseIsImage && looksLikeSlippy

  if (isExternal && isProbablyTile) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(XTOC_TILE_CACHE)
        const cached = await cache.match(req)
        if (cached) return cached

        // Online fallback (when allowed). If offline, this will throw.
        // Use a short timeout so offline / captive portals don't hang the UI.
        const res = await fetchWithTimeout(req, 4000)
        // We intentionally do NOT cache here because offlineTiles.js already
        // manages caching and we don't want unbounded growth.
        return res
      })(),
    )
    return
  }

  if (url.origin !== self.location.origin) return

  // Dedicated tile cache
  if (isTileRequest(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILE_CACHE)
        const cached = await cache.match(req)
        if (cached) return cached
        // Use a short timeout so offline / captive portals don't hang the UI.
        const res = await fetchWithTimeout(req, 4000)
        if (res && res.ok) {
          cache.put(req, res.clone()).catch(() => {})
        }
        return res
      })(),
    )
    return
  }

  // App shell + same-origin assets: CacheFirst, then network.
  event.respondWith(
    (async () => {
      const cache = await caches.open(APP_CACHE)

      // Try cache match ignoring search so app-main.js?v=... is still cached.
      const cached = await cache.match(req, { ignoreSearch: true })
      if (cached) return cached

      try {
        // Short timeout to avoid "forever black screen" when offline / no-route.
        const res = await fetchWithTimeout(req, 6000)
        // Only cache successful, basic responses.
        if (res && res.ok && res.type === 'basic') {
          cache.put(req, res.clone()).catch(() => {})
        }
        return res
      } catch (err) {
        // If navigation fails offline, fall back to cached index.
        if (req.mode === 'navigate') {
          const fallback = await cache.match('./index.html')
          if (fallback) return fallback
        }
        throw err
      }
    })(),
  )
})
