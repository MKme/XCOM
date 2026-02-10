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
const VERSION = 'xcom.sw.v21'
const APP_CACHE = `${VERSION}.app`
const TILE_CACHE = `${VERSION}.tiles`

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
]

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
      // Best-effort: allow missing app-main.js if query strings are used.
      await cache.addAll(CORE_ASSETS).catch(() => {})
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
  if (req.method !== 'GET') return

  const url = new URL(req.url)

  // Allow *cross-origin* tile requests for the offline raster cache.
  // The Map module downloads tiles into Cache Storage (xtoc.tiles.v1) using the
  // full tile URL (often https://...). When offline, MapLibre will re-request
  // those same URLs, which only a SW can intercept.
  const isExternal = url.origin !== self.location.origin

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
        const res = await fetch(req)
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
        const res = await fetch(req)
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
        const res = await fetch(req)
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
