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

const SVG_NS = 'http://www.w3.org/2000/svg'

class MapModule {
  constructor() {
    this.map = null
    this.mapEl = null

    this._lastViewSaveTimer = null
    this._isDownloading = false

    // Imported overlay (from XTOC Comm / XTOC backup imports)
    this._importedEnabled = true
    this._importedLast7dOnly = true
    this._importedLegendEl = null
    this._importedSourceId = 'xcom-imported-src'
    // Legacy dot layer id (removed; points now render as DOM icon markers)
    this._importedPointLayerId = 'xcom-imported-pt'
    this._importedLineLayerId = 'xcom-imported-ln'
    this._importedFillLayerId = 'xcom-imported-fl'
    this._importedPopup = null
    this._importedHandlersBound = false
    this._importedTplEnabled = new Map([[1, true], [2, true], [3, true], [4, true], [5, true], [6, true], [7, true], [8, true]])
    this._importedTplEls = []
    this._importedMarkerById = new Map()
    this._importedMarkerFeatureById = new Map()

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
      <div class="mapMobileBar">
        <button id="mapPanelsToggle" type="button" class="mapMobileToggle" aria-controls="mapLeft" aria-expanded="true">Hide panels</button>
      </div>
      <div class="mapShell" id="mapShell">
        <div class="mapLeft" id="mapLeft">
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
            <div class="mapCardTitle">Overlays</div>
            <div class="mapRow">
              <label class="mapInline"><input id="mapImported" type="checkbox" /> Imported</label>
              <label class="mapInline mapInline--sub"><input id="mapImportedLast7" type="checkbox" /> Last 7 days only</label>
              <div class="mapInlineGroup mapInlineGroup--sub" id="mapImportedTypes">
                <label class="mapInline"><input id="mapImportedT1" type="checkbox" /> SITREP</label>
                <label class="mapInline"><input id="mapImportedT2" type="checkbox" /> CONTACT</label>
                <label class="mapInline"><input id="mapImportedT3" type="checkbox" /> TASK</label>
                <label class="mapInline"><input id="mapImportedT4" type="checkbox" /> CHECKIN</label>
                <label class="mapInline"><input id="mapImportedT5" type="checkbox" /> RESOURCE</label>
                <label class="mapInline"><input id="mapImportedT6" type="checkbox" /> ASSET</label>
                <label class="mapInline"><input id="mapImportedT7" type="checkbox" /> ZONE</label>
                <label class="mapInline"><input id="mapImportedT8" type="checkbox" /> MISSION</label>
              </div>
              <div class="mapSmallMuted" id="mapImportedLegend"></div>
              <div class="mapSmallMuted">Imported markers come from XTOC Comm “Import” and XTOC Backup imports.</div>
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
    const shellEl = document.getElementById('mapShell')
    const panelsToggle = document.getElementById('mapPanelsToggle')
    const baseSel = document.getElementById('mapBaseSel')
    const tplEl = document.getElementById('mapRasterTemplate')
    const minZoomEl = document.getElementById('mapMinZoom')
    const maxZoomEl = document.getElementById('mapMaxZoom')
    const maxTilesEl = document.getElementById('mapMaxTiles')
    const downloadBtn = document.getElementById('mapDownloadBtn')
    const clearBtn = document.getElementById('mapClearBtn')
    const testBtn = document.getElementById('mapTestBtn')

    const importedEl = document.getElementById('mapImported')
    const importedLast7El = document.getElementById('mapImportedLast7')
    const importedLegendEl = document.getElementById('mapImportedLegend')
    this._importedLegendEl = importedLegendEl

    // Mobile: allow hiding the left-side panels so the map can fill the screen.
    if (shellEl && panelsToggle) {
      const key = 'xcom.ui.mapPanelsCollapsed.v1'
      const isMobile = () => {
        try {
          return window.matchMedia && window.matchMedia('(max-width: 900px)').matches
        } catch (_) {
          return false
        }
      }
      const readSaved = () => {
        try {
          const v = localStorage.getItem(key)
          if (v === '1') return true
          if (v === '0') return false
        } catch (_) {}
        return null
      }
      const apply = (collapsed, persist) => {
        shellEl.classList.toggle('mapShell--panelsCollapsed', !!collapsed)
        panelsToggle.textContent = collapsed ? 'Show panels' : 'Hide panels'
        panelsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
        if (persist) {
          try { localStorage.setItem(key, collapsed ? '1' : '0') } catch (_) {}
        }
        try {
          if (this.map) setTimeout(() => { try { this.map.resize() } catch (_) {} }, 0)
        } catch (_) {}
      }

      const saved = readSaved()
      const initial = (saved !== null) ? saved : isMobile()
      apply(initial, false)

      panelsToggle.addEventListener('click', () => {
        const collapsed = shellEl.classList.contains('mapShell--panelsCollapsed')
        apply(!collapsed, true)
      })
    }

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

    // Seed overlay settings
    try {
      if (importedEl) importedEl.checked = globalThis.getTacticalMapImportedEnabled ? globalThis.getTacticalMapImportedEnabled() : true
      this._importedEnabled = !!importedEl?.checked
    } catch (_) {
      if (importedEl) importedEl.checked = true
      this._importedEnabled = true
    }

    try {
      if (importedLast7El) importedLast7El.checked = globalThis.getTacticalMapImportedLast7dOnly ? globalThis.getTacticalMapImportedLast7dOnly() : true
      this._importedLast7dOnly = !!importedLast7El?.checked
    } catch (_) {
      if (importedLast7El) importedLast7El.checked = true
      this._importedLast7dOnly = true
    }

    // Seed Imported type toggles
    this._importedTplEls = []
    const tplIds = [1, 2, 3, 4, 5, 6, 7, 8]
    for (const t of tplIds) {
      const el = document.getElementById(`mapImportedT${String(t)}`)
      if (!el) continue
      this._importedTplEls.push(el)

      try {
        el.checked = globalThis.getTacticalMapImportedTemplateEnabled ? globalThis.getTacticalMapImportedTemplateEnabled(t) : true
      } catch (_) {
        el.checked = true
      }
      this._importedTplEnabled.set(t, !!el.checked)

      el.addEventListener('change', () => {
        const v = !!el.checked
        this._importedTplEnabled.set(t, v)
        try {
          globalThis.setTacticalMapImportedTemplateEnabled && globalThis.setTacticalMapImportedTemplateEnabled(t, v)
        } catch (_) {}
        this.syncImportedOverlay()
      })
    }

    const setImportedUiDisabled = (disabled) => {
      try { if (importedLast7El) importedLast7El.disabled = disabled } catch (_) { /* ignore */ }
      for (const el of Array.isArray(this._importedTplEls) ? this._importedTplEls : []) {
        try { el.disabled = disabled } catch (_) { /* ignore */ }
      }
    }

    setImportedUiDisabled(!this._importedEnabled)

    try { this.updateImportedLegend() } catch (_) { /* ignore */ }

    importedEl?.addEventListener('change', () => {
      const v = !!importedEl.checked
      this._importedEnabled = v
      try {
        globalThis.setTacticalMapImportedEnabled && globalThis.setTacticalMapImportedEnabled(v)
      } catch (_) {}
      setImportedUiDisabled(!v)
      this.syncImportedOverlay()
    })

    importedLast7El?.addEventListener('change', () => {
      const v = !!importedLast7El.checked
      this._importedLast7dOnly = v
      try {
        globalThis.setTacticalMapImportedLast7dOnly && globalThis.setTacticalMapImportedLast7dOnly(v)
      } catch (_) {}
      this.syncImportedOverlay()
    })

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
      try { this.ensureImportedOverlayLayers() } catch (_) { /* ignore */ }
      try { this.syncImportedOverlay() } catch (_) { /* ignore */ }
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

      // Style changes remove custom sources/layers. Re-add overlays after the style settles.
      try {
        this.map.once('idle', () => {
          try { this.ensureImportedOverlayLayers() } catch (_) { /* ignore */ }
          try { this.syncImportedOverlay() } catch (_) { /* ignore */ }
        })
      } catch (_) {
        // ignore
      }
    } catch (e) {
      console.warn('Failed to set style', e)
    }
  }

  escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  withRosterLabels(text) {
    const s = String(text ?? '')
    if (!s) return s
    try {
      if (typeof globalThis.xcomWithRosterLabels === 'function') return globalThis.xcomWithRosterLabels(s)
    } catch (_) {
      // ignore
    }
    return s
  }

  importedTemplateEnabled(templateId) {
    const t = Number(templateId || 0)
    if (!Number.isFinite(t) || t <= 0) return true
    try {
      if (this._importedTplEnabled && typeof this._importedTplEnabled.get === 'function' && this._importedTplEnabled.has(t)) {
        return !!this._importedTplEnabled.get(t)
      }
    } catch (_) {
      // ignore
    }
    return true
  }

  importedTimestampMs(props) {
    try {
      const p = (props && typeof props === 'object') ? props : {}
      const ts = Number(p.packetAt ?? p.receivedAt ?? p.importedAt ?? 0)
      return (Number.isFinite(ts) && ts > 0) ? ts : 0
    } catch (_) {
      return 0
    }
  }

  createMarkerIconSvg(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')

    const addPath = (d) => {
      const p = document.createElementNS(SVG_NS, 'path')
      p.setAttribute('d', d)
      svg.appendChild(p)
    }
    const addCircle = (cx, cy, r) => {
      const c = document.createElementNS(SVG_NS, 'circle')
      c.setAttribute('cx', String(cx))
      c.setAttribute('cy', String(cy))
      c.setAttribute('r', String(r))
      svg.appendChild(c)
    }

    if (kind === 'file') {
      addPath('M14 2H7a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V8z')
      addPath('M14 2v6h6')
      addPath('M9 13h6')
      addPath('M9 17h6')
      return svg
    }

    if (kind === 'target') {
      addCircle(12, 12, 8)
      addCircle(12, 12, 4)
      addPath('M12 2v2')
      addPath('M22 12h-2')
      addPath('M12 22v-2')
      addPath('M2 12h2')
      return svg
    }

    if (kind === 'check') {
      addPath('M20 6L9 17l-5-5')
      return svg
    }

    if (kind === 'box') {
      addPath('M21 8l-9-5-9 5 9 5 9-5z')
      addPath('M3 8v8l9 5 9-5V8')
      addPath('M12 13v8')
      return svg
    }

    if (kind === 'toolbox') {
      addPath('M10 6V5a2 2 0 012-2h0a2 2 0 012 2v1')
      addPath('M4 7h16a2 2 0 012 2v9a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2z')
      addPath('M2 13h20')
      addPath('M10 13v2')
      addPath('M14 13v2')
      return svg
    }

    if (kind === 'person') {
      addCircle(12, 7, 4)
      addPath('M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2')
      return svg
    }

    // 'flag'
    addPath('M6 3v18')
    addPath('M6 4h13l-2 4 2 4H6')
    return svg
  }

  importedMarkerClassName(templateId) {
    const t = Number(templateId)
    return t === 2
      ? 'xcomMapMarker--contact'
      : t === 3
        ? 'xcomMapMarker--task'
        : t === 5
          ? 'xcomMapMarker--resource'
          : t === 6
            ? 'xcomMapMarker--asset'
            : t === 8
              ? 'xcomMapMarker--mission'
              : t === 4
                ? 'xcomMapMarker--team'
                : 'xcomMapMarker--sitrep'
  }

  importedMarkerIconKind(templateId) {
    const t = Number(templateId)
    return t === 2
      ? 'target'
      : t === 3
        ? 'check'
        : t === 5
          ? 'box'
          : t === 6
            ? 'toolbox'
            : t === 8
              ? 'flag'
              : t === 4
                ? 'person'
                : 'file'
  }

  setImportedMarkerClasses(el, templateId, isStale) {
    if (!el || !el.classList) return
    try { el.classList.add('xcomMapMarker') } catch (_) { /* ignore */ }

    const typeClasses = [
      'xcomMapMarker--sitrep',
      'xcomMapMarker--contact',
      'xcomMapMarker--task',
      'xcomMapMarker--resource',
      'xcomMapMarker--asset',
      'xcomMapMarker--mission',
      'xcomMapMarker--team',
    ]
    for (const c of typeClasses) {
      try { el.classList.remove(c) } catch (_) { /* ignore */ }
    }
    try { el.classList.add(this.importedMarkerClassName(templateId)) } catch (_) { /* ignore */ }

    try { el.classList.remove('xcomMapMarker--stale') } catch (_) { /* ignore */ }
    if (isStale) {
      try { el.classList.add('xcomMapMarker--stale') } catch (_) { /* ignore */ }
    }
  }

  importedPopupHtmlForFeature(f) {
    const p = f?.properties || {}
    const summary = this.withRosterLabels(String(p?.summary || '').trim())
    const tpl = Number(p?.templateId) || ''
    const mode = String(p?.mode || '').toUpperCase()
    const id = String(p?.packetId || '').trim()
    const kid = (mode === 'S' && p?.kid != null) ? ` KID ${String(p.kid)}` : ''
    const whenTs = this.importedTimestampMs(p)
    const when = (Number.isFinite(whenTs) && whenTs > 0) ? new Date(whenTs).toLocaleString() : '-'

    return `
      <div style="font-weight:700; margin-bottom:6px;">Imported</div>
      ${summary ? `<div style="margin-bottom:6px;">${this.escapeHtml(summary)}</div>` : ''}
      <div style="font-size:12px; color:#444;">
        ${tpl ? `T=${this.escapeHtml(String(tpl))} ` : ''}${mode ? `${this.escapeHtml(mode)} ` : ''}${id ? `ID ${this.escapeHtml(id)}` : ''}${kid ? this.escapeHtml(kid) : ''}
      </div>
      <div style="font-size:12px; color:#444;">${this.escapeHtml(when)}</div>
    `
  }

  openImportedPopup(lngLat, feature) {
    if (!this.map || !lngLat) return
    const map = this.map
    try {
      if (!this._importedPopup && globalThis.maplibregl?.Popup) {
        this._importedPopup = new globalThis.maplibregl.Popup({ closeButton: true, closeOnClick: true })
      }
      if (this._importedPopup) {
        const html = this.importedPopupHtmlForFeature(feature)
        this._importedPopup.setLngLat(lngLat).setHTML(html).addTo(map)
      }
    } catch (_) {
      // ignore
    }
  }

  clearImportedMarkers() {
    try {
      for (const m of this._importedMarkerById?.values?.() || []) {
        try { m.remove() } catch (_) { /* ignore */ }
      }
    } catch (_) {
      // ignore
    }
    try { this._importedMarkerById?.clear?.() } catch (_) { /* ignore */ }
    try { this._importedMarkerFeatureById?.clear?.() } catch (_) { /* ignore */ }
  }

  syncImportedMarkers(pointFeatures) {
    if (!this.map || !globalThis.maplibregl?.Marker) return
    const map = this.map

    const staleCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000)
    const want = new Map()

    for (const f of Array.isArray(pointFeatures) ? pointFeatures : []) {
      const g = f?.geometry
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue
      const coords = g.coordinates
      const lon = Number(coords?.[0])
      const lat = Number(coords?.[1])
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue

      const p = f?.properties || {}
      const templateId = Number(p?.templateId || 0)
      // XTOC parity: Zones (templateId=7) are not point markers.
      if (templateId === 7) continue

      const id = (f.id != null) ? String(f.id) : `imported:${String(p?.packetId || '')}:${String(p?.mode || '')}:${String(templateId)}:${String(p?.kid ?? '')}:${lon.toFixed(6)},${lat.toFixed(6)}`
      want.set(id, { feature: f, lon, lat, templateId })
    }

    // Remove markers that no longer exist
    for (const [id, m] of this._importedMarkerById.entries()) {
      if (!want.has(id)) {
        try { m.remove() } catch (_) { /* ignore */ }
        this._importedMarkerById.delete(id)
        this._importedMarkerFeatureById.delete(id)
      }
    }

    for (const [id, item] of want.entries()) {
      const { feature: f, lon, lat, templateId } = item
      const ts = this.importedTimestampMs(f?.properties)
      const isStale = (ts > 0 && ts < staleCutoff)
      const iconKind = this.importedMarkerIconKind(templateId)

      let marker = this._importedMarkerById.get(id) || null
      if (!marker) {
        const el = document.createElement('div')
        el.dataset.xcomImportedId = id
        el.dataset.xcomImportedIconKind = iconKind
        this.setImportedMarkerClasses(el, templateId, isStale)
        el.appendChild(this.createMarkerIconSvg(iconKind))

        // Helpful hover text.
        try {
          const summary = this.withRosterLabels(String(f?.properties?.summary || '').trim())
          el.title = summary || `Imported T=${String(templateId || '')}`
        } catch (_) {
          // ignore
        }

        el.addEventListener('click', (e) => {
          try {
            e.preventDefault()
            e.stopPropagation()
          } catch (_) {
            // ignore
          }
          const markerId = el.dataset.xcomImportedId
          if (!markerId) return
          const feat = this._importedMarkerFeatureById.get(markerId)
          const mk = this._importedMarkerById.get(markerId)
          const ll = mk && typeof mk.getLngLat === 'function' ? mk.getLngLat() : null
          if (feat && ll) this.openImportedPopup(ll, feat)
        })

        marker = new globalThis.maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lon, lat])
          .addTo(map)
        this._importedMarkerById.set(id, marker)
      } else {
        try { marker.setLngLat([lon, lat]) } catch (_) { /* ignore */ }
        const el = marker.getElement ? marker.getElement() : null
        if (el) {
          this.setImportedMarkerClasses(el, templateId, isStale)

          const prevKind = String(el.dataset?.xcomImportedIconKind || '')
          if (prevKind !== iconKind) {
            try { el.dataset.xcomImportedIconKind = iconKind } catch (_) { /* ignore */ }
            try {
              while (el.firstChild) el.removeChild(el.firstChild)
              el.appendChild(this.createMarkerIconSvg(iconKind))
            } catch (_) {
              // ignore
            }
          }

          try {
            const summary = this.withRosterLabels(String(f?.properties?.summary || '').trim())
            el.title = summary || `Imported T=${String(templateId || '')}`
          } catch (_) {
            // ignore
          }
        }
      }

      this._importedMarkerFeatureById.set(id, f)
    }
  }

  updateImportedLegend() {
    const el = this._importedLegendEl
    if (!el) return
 
    const entries = globalThis.getImportedPackets ? globalThis.getImportedPackets() : []
    const count = Array.isArray(entries) ? entries.length : 0
    const hidden = !this._importedEnabled
    const win = this._importedLast7dOnly ? ' (last 7d)' : ''
    el.textContent = `Imported: ${count}${hidden ? ' (hidden)' : ''}${win}`
  }

  getImportedOverlayFeatures() {
    try {
      const entries = globalThis.getImportedPackets ? globalThis.getImportedPackets() : []
      const out = []
      for (const e of Array.isArray(entries) ? entries : []) {
        const feats = Array.isArray(e?.features) ? e.features : []
        const importedAt = Number(e?.importedAt || 0) || 0
        for (const f of feats) {
          if (!f || typeof f !== 'object') continue
          const p = (f.properties && typeof f.properties === 'object') ? f.properties : {}
          const nextProps = { ...p }
          if (importedAt > 0 && nextProps.receivedAt == null && nextProps.importedAt == null) {
            nextProps.importedAt = importedAt
          }
          out.push({ ...f, properties: nextProps })
        }
      }
      return out
    } catch (_) {
      return []
    }
  }

  ensureImportedOverlayLayers() {
    if (!this.map) return
    const map = this.map

    // Bind global update listener once per module instance.
    if (!this._importedHandlersBound) {
      this._importedHandlersBound = true

      try { if (globalThis.__xcomMapCleanup) globalThis.__xcomMapCleanup() } catch (_) { /* ignore */ }
      const onImportedUpdated = () => {
        try { this.syncImportedOverlay() } catch (_) { /* ignore */ }
      }
      try { globalThis.addEventListener('xcomImportedPacketsUpdated', onImportedUpdated) } catch (_) { /* ignore */ }
      globalThis.__xcomMapCleanup = () => {
        try { globalThis.removeEventListener('xcomImportedPacketsUpdated', onImportedUpdated) } catch (_) { /* ignore */ }
      }
    }

    // Source
    try {
      if (!map.getSource(this._importedSourceId)) {
        map.addSource(this._importedSourceId, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
      }
    } catch (_) {
      // ignore
    }

    // Layers (idempotent)
    try {
      if (!map.getLayer(this._importedFillLayerId)) {
        map.addLayer({
          id: this._importedFillLayerId,
          type: 'fill',
          source: this._importedSourceId,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            // Match Comms import preview: zones are blue.
            'fill-color': '#66c2ff',
            'fill-opacity': 0.15,
          },
        })
      }
    } catch (_) {
      // ignore
    }

    try {
      if (!map.getLayer(this._importedLineLayerId)) {
        map.addLayer({
          id: this._importedLineLayerId,
          type: 'line',
          source: this._importedSourceId,
          // Match Comms import preview: outlines for polygons + any optional lines.
          filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'LineString']],
          paint: {
            'line-color': '#66c2ff',
            'line-width': 3,
          },
        })
      }
    } catch (_) {
      // ignore
    }

    // Remove legacy dot layer if present (points are DOM icon markers now).
    try { if (map.getLayer(this._importedPointLayerId)) map.removeLayer(this._importedPointLayerId) } catch (_) { /* ignore */ }

    // Click handlers (bind once; layer ids remain stable across re-adds)
    try { map.off('click', this._importedFillLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.off('click', this._importedLineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.off('click', this._importedPointLayerId, this._onImportedClick) } catch (_) { /* ignore */ }

    this._onImportedClick = (ev) => {
      try {
        const f = ev?.features?.[0] || null
        const p = f?.properties || {}
        const summary = this.withRosterLabels(String(p?.summary || '').trim())
        const tpl = Number(p?.templateId) || ''
        const mode = String(p?.mode || '').toUpperCase()
        const id = String(p?.packetId || '').trim()
        const kid = (mode === 'S' && p?.kid != null) ? ` KID ${String(p.kid)}` : ''
        const whenTs = Number(p?.packetAt ?? p?.receivedAt ?? p?.importedAt ?? 0)
        const when = (Number.isFinite(whenTs) && whenTs > 0) ? new Date(whenTs).toLocaleString() : '—'

        const html = `
          <div style="font-weight:700; margin-bottom:6px;">Imported</div>
          ${summary ? `<div style="margin-bottom:6px;">${this.escapeHtml(summary)}</div>` : ''}
          <div style="font-size:12px; color:#444;">
            ${tpl ? `T=${this.escapeHtml(String(tpl))} ` : ''}${mode ? `${this.escapeHtml(mode)} ` : ''}${id ? `ID ${this.escapeHtml(id)}` : ''}${kid ? this.escapeHtml(kid) : ''}
          </div>
          <div style="font-size:12px; color:#444;">${this.escapeHtml(when)}</div>
        `

        if (!this._importedPopup && globalThis.maplibregl?.Popup) {
          this._importedPopup = new globalThis.maplibregl.Popup({ closeButton: true, closeOnClick: true })
        }
        if (this._importedPopup) {
          this._importedPopup.setLngLat(ev.lngLat).setHTML(html).addTo(map)
        }
      } catch (_) {
        // ignore
      }
    }

    try { map.on('click', this._importedFillLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.on('click', this._importedLineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
  }

  setImportedLayerVisibility(visible) {
    if (!this.map) return
    const map = this.map
    const v = visible ? 'visible' : 'none'
    // Legacy dot layer should never be visible.
    try { if (map.getLayer(this._importedPointLayerId)) map.setLayoutProperty(this._importedPointLayerId, 'visibility', 'none') } catch (_) {}
    try { if (map.getLayer(this._importedLineLayerId)) map.setLayoutProperty(this._importedLineLayerId, 'visibility', v) } catch (_) {}
    try { if (map.getLayer(this._importedFillLayerId)) map.setLayoutProperty(this._importedFillLayerId, 'visibility', v) } catch (_) {}
  }

  syncImportedOverlay() {
    if (!this.map) return
    const map = this.map

    let allFeatures = this.getImportedOverlayFeatures()
    allFeatures = allFeatures.filter((f) => {
      try { return this.importedTemplateEnabled(f?.properties?.templateId) } catch (_) { return true }
    })
    if (this._importedLast7dOnly) {
      const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000)
      allFeatures = allFeatures.filter((f) => {
        try {
          const ts = this.importedTimestampMs(f?.properties)
          if (!Number.isFinite(ts) || ts <= 0) return true
          return ts >= cutoff
        } catch (_) {
          return true
        }
      })
    }

    if (!this._importedEnabled) {
      try { this.clearImportedMarkers() } catch (_) { /* ignore */ }
      try {
        const src = map.getSource(this._importedSourceId)
        if (src && typeof src.setData === 'function') {
          src.setData({ type: 'FeatureCollection', features: [] })
        }
      } catch (_) {
        // ignore
      }
      this.setImportedLayerVisibility(false)
      try { this.updateImportedLegend() } catch (_) { /* ignore */ }
      return
    }

    const srcFeatures = allFeatures.filter((f) => {
      try { return f?.geometry?.type !== 'Point' } catch (_) { return true }
    })
    const pointFeatures = allFeatures.filter((f) => {
      try { return f?.geometry?.type === 'Point' } catch (_) { return false }
    })

    try {
      const src = map.getSource(this._importedSourceId)
      if (src && typeof src.setData === 'function') {
        src.setData({ type: 'FeatureCollection', features: srcFeatures })
      }
    } catch (_) {
      // ignore
    }

    try { this.syncImportedMarkers(pointFeatures) } catch (_) { /* ignore */ }

    const visible = allFeatures.length > 0
    this.setImportedLayerVisibility(visible)

    try { this.updateImportedLegend() } catch (_) { /* ignore */ }
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
