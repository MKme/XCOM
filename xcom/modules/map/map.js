// XCOM Map module (XTOC-style)
// - MapLibre GL basemap
// - User selects AO by panning/zooming
// - Download raster tiles for offline use via Cache Storage
//
// Requirements (loaded by app-main.js):
// - maplibregl (MapLibre GL)
// - getMapBaseStyle/setMapBaseStyle
// - getMapRasterTemplate/setMapRasterTemplate
// - getMapDefaultCoords/setMapDefaultCoords
// - getMapDefaultZoom/setMapDefaultZoom
// - deriveBoundsFromCenterZoom/formatBoundsShort
// - cacheTilesForBounds/clearTileCache

class MapModule {
  constructor() {
    this.map = null
    this.mapEl = null

    this._lastViewSaveTimer = null
    this._isDownloading = false

    this.init()
  }

  init() {
    this.render()
    this.bindUi()
    this.initMap()
    window.radioApp?.updateStatus?.('Map module loaded')
  }

  render() {
    const root = document.getElementById('map')
    root.innerHTML = `
      <div class="xModuleIntro">
        <div class="xModuleIntroTitle">What you can do here</div>
        <div class="xModuleIntroText">
          Set your Area of Operations (AO) and optionally download map tiles so your maps still work when you go offline.
        </div>
      </div>
      <div class="mapShell">
        <div class="mapLeft">
          <div class="mapCard">
            <div class="mapCardTitle">Tactical Map (XTOC-style)</div>

            <div class="mapRow">
              <label>Base</label>
              <select id="mapBaseSel">
                <option value="light">Online Vector (Light)</option>
                <option value="dark">Online Vector (Dark)</option>
                <option value="offlineRaster">Offline Raster (cached)</option>
                <option value="offlineRasterDark">Offline Raster Dark (cached)</option>
              </select>
              <div class="mapSmallMuted">
                Offline raster uses a tile template and caches tiles for your AO into device storage.
              </div>
            </div>

            <div class="mapRow">
              <label>Raster tile URL template</label>
              <input id="mapRasterTemplate" type="text" spellcheck="false" />
              <div class="mapSmallMuted">
                Example: <code>https://tile.openstreetmap.org/{z}/{x}/{y}.png</code>
              </div>
            </div>

            <div class="mapGrid2">
              <div class="mapRow">
                <label>Min zoom</label>
                <input id="mapMinZoom" type="number" min="0" max="18" step="1" value="6" />
              </div>
              <div class="mapRow">
                <label>Max zoom</label>
                <input id="mapMaxZoom" type="number" min="0" max="18" step="1" value="12" />
              </div>
            </div>

            <div class="mapRow">
              <label>Max tiles (safety)</label>
              <input id="mapMaxTiles" type="number" min="100" step="100" value="2500" />
            </div>

            <div class="mapRow">
              <label>Current AO bounds</label>
              <div class="mapMono" id="mapAoBounds">—</div>
            </div>

            <div class="mapButtonRow">
              <button id="mapDownloadBtn" type="button" class="primary">Download tiles (this AO)</button>
              <button id="mapClearBtn" type="button" class="danger">Clear tiles</button>
            </div>
            <div class="mapRow">
              <div class="mapSmallMuted" id="mapProgress"> </div>
            </div>

            <div class="mapRow">
              <label>Tile cache status</label>
              <div class="mapMono" id="mapCacheStatus">—</div>
              <div class="mapSmallMuted">
                Shows how many cached tile requests are currently stored in <code>Cache Storage</code> (<code>xtoc.tiles.v1</code>).
              </div>
            </div>

            <div class="mapButtonRow">
              <button id="mapTestBtn" type="button">Test cached tile (current center)</button>
            </div>

            <div class="mapRow">
              <div class="mapSmallMuted" id="mapTestResult"> </div>
            </div>
          </div>

          <div class="mapCard">
            <div class="mapCardTitle">Tips</div>
            <ul class="mapTips">
              <li>Pan/zoom the map to your AO. The AO bounds are derived from the current center + zoom.</li>
              <li>Keep the AO + max zoom reasonable to avoid thousands of tile downloads.</li>
              <li>Public tile servers have usage policies; for serious use point this to your own server.</li>
            </ul>
          </div>
        </div>

        <div class="mapRight">
          <div class="mapWrap">
            <div id="mapCanvas" class="mapCanvas"></div>
          </div>
        </div>
      </div>
    `

    this.mapEl = document.getElementById('mapCanvas')
  }

  bindUi() {
    const baseSel = document.getElementById('mapBaseSel')
    const tplEl = document.getElementById('mapRasterTemplate')
    const minZoomEl = document.getElementById('mapMinZoom')
    const maxZoomEl = document.getElementById('mapMaxZoom')
    const maxTilesEl = document.getElementById('mapMaxTiles')
    const downloadBtn = document.getElementById('mapDownloadBtn')
    const clearBtn = document.getElementById('mapClearBtn')
    const testBtn = document.getElementById('mapTestBtn')

    // Seed
    try {
      baseSel.value = globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'
    } catch (_) {
      baseSel.value = 'light'
    }
    try {
      tplEl.value = globalThis.getMapRasterTemplate ? globalThis.getMapRasterTemplate() : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
    } catch (_) {
      tplEl.value = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
    }

    baseSel.addEventListener('change', () => {
      try {
        globalThis.setMapBaseStyle && globalThis.setMapBaseStyle(baseSel.value)
      } catch (_) {}
      this.applyBaseStyle()
    })

    tplEl.addEventListener('change', () => {
      try {
        globalThis.setMapRasterTemplate && globalThis.setMapRasterTemplate(tplEl.value)
      } catch (_) {}
      this.applyBaseStyle()
    })

    downloadBtn.addEventListener('click', () => this.downloadTiles())
    clearBtn.addEventListener('click', () => this.clearTiles())
    testBtn?.addEventListener('click', () => this.testCachedTile())

    // initial cache count
    this.updateCacheStatus().catch(() => {})

    // Clamp zoom values if user types silly inputs
    const clampZoomInputs = () => {
      const minZ = Math.max(0, Math.min(18, Number(minZoomEl.value || 0)))
      const maxZ = Math.max(0, Math.min(18, Number(maxZoomEl.value || 0)))
      if (Number.isFinite(minZ)) minZoomEl.value = String(minZ)
      if (Number.isFinite(maxZ)) maxZoomEl.value = String(maxZ)
    }
    minZoomEl.addEventListener('change', clampZoomInputs)
    maxZoomEl.addEventListener('change', clampZoomInputs)

    maxTilesEl.addEventListener('change', () => {
      const n = Math.max(100, Number(maxTilesEl.value || 100))
      maxTilesEl.value = String(n)
    })
  }

  initMap() {
    if (!this.mapEl) throw new Error('map element missing')
    if (!globalThis.maplibregl) throw new Error('MapLibre not loaded')

    const c = globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 35.9606, lon: -83.9207 }
    const z = globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 6

    // Prefer shared helper (keeps style + offline-dark filter behavior consistent)
    if (globalThis.createMapLibreMap) {
      this.map = globalThis.createMapLibreMap({
        container: this.mapEl,
        centerLon: c.lon,
        centerLat: c.lat,
        zoom: z,
      })
    } else {
      this.map = new globalThis.maplibregl.Map({
        container: this.mapEl,
        style: this.buildStyle(),
        center: [c.lon, c.lat],
        zoom: z,
        attributionControl: true,
      })
      this.map.addControl(new globalThis.maplibregl.NavigationControl(), 'top-right')
    }

    this.map.on('load', () => {
      this.updateAoUi()
    })

    // Track AO by view; save view to localStorage with a small debounce.
    const onMoveEnd = () => {
      this.updateAoUi()
      this.scheduleSaveView()
    }
    this.map.on('moveend', onMoveEnd)
    this.map.on('zoomend', onMoveEnd)
  }

  scheduleSaveView() {
    if (this._lastViewSaveTimer) clearTimeout(this._lastViewSaveTimer)
    this._lastViewSaveTimer = setTimeout(() => {
      this._lastViewSaveTimer = null
      try {
        const center = this.map.getCenter()
        const zoom = this.map.getZoom()
        globalThis.setMapDefaultCoords && globalThis.setMapDefaultCoords({ lat: center.lat, lon: center.lng })
        globalThis.setMapDefaultZoom && globalThis.setMapDefaultZoom(Number(zoom))
      } catch (_) {
        // ignore
      }
    }, 400)
  }

  updateAoUi() {
    if (!this.map) return
    const el = document.getElementById('mapAoBounds')
    if (!el) return
    try {
      const center = this.map.getCenter()
      const zoom = this.map.getZoom()
      const b = globalThis.deriveBoundsFromCenterZoom(center.lat, center.lng, zoom)
      el.textContent = globalThis.formatBoundsShort ? globalThis.formatBoundsShort(b) : JSON.stringify(b)
    } catch (e) {
      el.textContent = '—'
    }

    // keep cache status roughly up to date while user pans around
    this.updateCacheStatus().catch(() => {})
  }

  async updateCacheStatus() {
    const el = document.getElementById('mapCacheStatus')
    if (!el) return
    try {
      if (!globalThis.countTileCacheEntries) {
        el.textContent = 'Cache API helper not loaded'
        return
      }
      const n = await globalThis.countTileCacheEntries()
      el.textContent = `${n} cached request(s)`
    } catch (e) {
      el.textContent = '—'
    }
  }

  buildStyle() {
    // If shared helper is loaded, defer style building to it.
    if (globalThis.buildMapLibreStyle) return globalThis.buildMapLibreStyle()

    const base = globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'
    const rasterTemplate = globalThis.getMapRasterTemplate ? globalThis.getMapRasterTemplate() : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

    const isOfflineRaster = base === 'offlineRaster' || base === 'offlineRasterDark'
    if (isOfflineRaster) {
      // Raster style.
      return {
        version: 8,
        name: 'Offline Raster',
        sources: {
          raster: {
            type: 'raster',
            tiles: [rasterTemplate],
            tileSize: 256,
            attribution: 'Raster Tiles',
          },
        },
        layers: [
          {
            id: 'raster',
            type: 'raster',
            source: 'raster',
          },
        ],
      }
    }

    // Online vector style (fallback). Prefer stable basemaps (same as XTOC)
    // to avoid MapLibre demo “missing tiles” debug pattern when assets fail.
    const STYLE_DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
    const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/liberty'
    return base === 'dark' ? STYLE_DARK : STYLE_LIGHT
  }

  applyBaseStyle() {
    if (!this.map) return
    try {
      this.map.setStyle(this.buildStyle())
      this.applyOfflineDarkFilter()
    } catch (e) {
      console.warn('Failed to set style', e)
    }
  }

  applyOfflineDarkFilter() {
    // Prefer shared helper.
    if (globalThis.applyOfflineRasterDarkFilter) {
      globalThis.applyOfflineRasterDarkFilter(this.mapEl)
      return
    }

    const base = globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'
    const isOfflineDark = base === 'offlineRasterDark'
    if (!this.mapEl) return
    const canvas = this.mapEl.querySelector('canvas')
    if (!canvas) return
    canvas.style.filter = isOfflineDark ? 'invert(1) hue-rotate(180deg) brightness(0.95) contrast(1.05)' : ''
  }

  getCurrentAoBounds() {
    const center = this.map.getCenter()
    const zoom = this.map.getZoom()
    return globalThis.deriveBoundsFromCenterZoom(center.lat, center.lng, zoom)
  }

  setProgress(text) {
    const el = document.getElementById('mapProgress')
    if (el) el.textContent = text || ''
  }

  setTestResult(text) {
    const el = document.getElementById('mapTestResult')
    if (el) el.textContent = text || ''
  }

  async testCachedTile() {
    if (!this.map) return
    const tpl = document.getElementById('mapRasterTemplate')?.value
      || (globalThis.getMapRasterTemplate ? globalThis.getMapRasterTemplate() : '')

    if (!tpl || !globalThis.fillTileTemplate || !globalThis.lonLatToTileXY) {
      this.setTestResult('Missing offline tile helpers (fillTileTemplate/lonLatToTileXY)')
      return
    }

    // Pick a representative tile at a reasonable zoom (minZoom input)
    const minZoom = Number(document.getElementById('mapMinZoom')?.value || 6)
    const z = Math.max(0, Math.min(18, Math.floor(minZoom)))
    const c = this.map.getCenter()

    const { x, y } = globalThis.lonLatToTileXY(c.lng, c.lat, z)
    const url = globalThis.fillTileTemplate(tpl, z, x, y)

    // 1) Cache existence check
    let inCache = false
    try {
      const cache = await caches.open(globalThis.XTOC_TILE_CACHE_NAME || 'xtoc.tiles.v1')
      const hit = await cache.match(new Request(url, { mode: 'cors' }))
      inCache = !!hit
    } catch (_) {
      // ignore
    }

    // 2) Fetch check (will fail if truly offline). We report both signals.
    let fetchOk = false
    let fetchStatus = ''
    try {
      const res = await fetch(url, { mode: 'cors' })
      fetchOk = !!res && res.ok
      fetchStatus = `${res.status}`
    } catch (e) {
      fetchOk = false
      fetchStatus = 'fetch failed (offline?)'
    }

    const hasController = !!(navigator.serviceWorker && navigator.serviceWorker.controller)
    this.setTestResult(
      `Test tile z${z}/${x}/${y}: cache=${inCache ? 'HIT' : 'MISS'}, fetch=${fetchOk ? 'OK' : fetchStatus}, SW=${hasController ? 'controlling' : 'not controlling'}`
    )
  }

  async downloadTiles() {
    if (this._isDownloading) return
    if (!globalThis.cacheTilesForBounds) {
      alert('Offline tile caching helpers not loaded')
      return
    }

    const base = globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'
    if (!(base === 'offlineRaster' || base === 'offlineRasterDark')) {
      const ok = confirm('Base is not set to Offline Raster. Download tiles anyway?')
      if (!ok) return
    }

    const tpl = document.getElementById('mapRasterTemplate').value
    const minZoom = Number(document.getElementById('mapMinZoom').value || 6)
    const maxZoom = Number(document.getElementById('mapMaxZoom').value || 12)
    const maxTiles = Number(document.getElementById('mapMaxTiles').value || 2500)

    const bounds = this.getCurrentAoBounds()

    this._isDownloading = true
    try {
      this.setProgress('Preparing tile list…')
      const res = await globalThis.cacheTilesForBounds({
        template: tpl,
        bounds,
        minZoom: Math.min(minZoom, maxZoom),
        maxZoom: Math.max(minZoom, maxZoom),
        maxTiles,
        onProgress: ({ done, total, z }) => {
          if (done % 10 === 0 || done === total) {
            this.setProgress(`Downloading… ${done}/${total} (z=${z})`)
          }
        }
      })

      this.setProgress(`Done. Cached ${res.cached}/${res.total} tiles.`)
      window.radioApp?.updateStatus?.(`Cached ${res.cached}/${res.total} tiles`) 
      await this.updateCacheStatus()
    } catch (e) {
      console.error(e)
      alert(e.message || String(e))
      this.setProgress(`Error: ${e.message || e}`)
    } finally {
      this._isDownloading = false
      this.applyBaseStyle()
      setTimeout(() => this.setProgress(''), 2500)
    }
  }

  async clearTiles() {
    if (!globalThis.clearTileCache) {
      alert('Offline tile caching helpers not loaded')
      return
    }
    const ok = confirm('Clear cached raster tiles?')
    if (!ok) return
    try {
      await globalThis.clearTileCache()
      this.setProgress('Tile cache cleared.')
      window.radioApp?.updateStatus?.('Tile cache cleared')
      await this.updateCacheStatus()
    } catch (e) {
      console.error(e)
      alert(e.message || String(e))
    } finally {
      this.applyBaseStyle()
      setTimeout(() => this.setProgress(''), 2000)
    }
  }
}
