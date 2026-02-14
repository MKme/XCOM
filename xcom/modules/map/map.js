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
// NOTE: Shared MapLibre helpers define a top-level `const TOPO_RASTER_TEMPLATE`.
// Because XCOM loads modules as classic <script> tags in a shared global scope,
// we MUST avoid redeclaring that identifier here (it would throw "Identifier has
// already been declared" and prevent the entire Map module from loading).
const MAP_TOPO_RASTER_TEMPLATE = globalThis.TOPO_RASTER_TEMPLATE || 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png'

function formatMeshtasticNodeId(num) {
  const n = Math.floor(Number(num))
  if (!Number.isFinite(n)) return null
  return '!' + ((n >>> 0).toString(16).padStart(8, '0'))
}

class MapModule {
  constructor() {
    this.map = null
    this.mapEl = null

    this._lastViewSaveTimer = null
    this._isDownloading = false

    // Connectivity probe can flip XCOM_HAS_INTERNET after the map is created.
    // When the user chose an online vector basemap (light/dark), we need to
    // re-apply the base style so the map upgrades from offline fallback.
    this._connectivitySyncTimer = null

    // Imported overlay (from XTOC Comm / XTOC backup imports)
    this._importedEnabled = true
    this._importedLast7dOnly = true
    this._trustedModeEnabled = false
    this._importedLegendEl = null
    this._importedSourceId = 'xcom-imported-src'
    // Zone center points (templateId=7) render as style-layer circles (like XTOC).
    this._importedPointLayerId = 'xcom-imported-pt'
    this._importedOutlineLayerId = 'xcom-imported-ol'
    this._importedLineLayerId = 'xcom-imported-ln'
    this._importedDashedLineLayerId = 'xcom-imported-ln-dashed'
    this._importedDoubleLineLayerAId = 'xcom-imported-ln-double-a'
    this._importedDoubleLineLayerBId = 'xcom-imported-ln-double-b'
    this._importedFillLayerId = 'xcom-imported-fl'
    this._importedKeyWarnLineLayerId = 'xcom-imported-ln-keywarn'
    this._importedPopup = null
    this._importedHandlersBound = false
    this._importedTimeWindowTimer = null
    this._importedTplEnabled = new Map([[1, true], [2, true], [3, true], [4, true], [5, true], [6, true], [7, true], [8, true], [9, true], [10, true]])
    this._importedTplEls = []
    this._importedMarkerById = new Map()
    this._importedMarkerFeatureById = new Map()

    // Mesh nodes overlay (Meshtastic/MeshCore position/adverts)
    this._meshNodesEnabled = true
    this._meshLegendEl = null
    this._meshHandlersBound = false
    this._meshMarkerByKey = new Map()
    this._meshPopupByKey = new Map()
    this._meshUnsub = null

    // Hidden marker controls (user "Hide from map")
    this._showHiddenEnabled = false
    this._hiddenLegendEl = null
    this._hiddenListEl = null
    this._hiddenShowAllBtn = null
    this._hiddenHandlersBound = false
    this._hiddenImportedMarkerById = new Map()
    this._hiddenImportedMarkerFeatureById = new Map()
    this._hiddenMeshMarkerByKey = new Map()
    this._hiddenMeshPopupByKey = new Map()

    // OpenMANET nodes (via openmanetd; fetched over LAN/MANET)
    this._openmanetNodes = []
    this._openmanetTimer = null
    this._openmanetAbort = null
    this._openmanetStatusEl = null

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
                <option value="topo">Topographic</option>
                <option value="topoDark">Topographic Dark</option>
                <option value="offlineRaster">Offline Raster (cached)</option>
                <option value="offlineRasterDark">Offline Raster Dark (cached)</option>
              </select>
              <div class="mapSmallMuted">
                Topographic uses OpenTopoMap raster tiles. Offline raster uses your tile URL template and can be cached into device storage.
              </div>
            </div>

            <div class="mapRow" id="mapTopoRow" style="display:none">
              <div class="mapSmallMuted">
                Topographic tiles: <code>${MAP_TOPO_RASTER_TEMPLATE}</code>
              </div>
            </div>

            <div class="mapRow" id="mapRasterRow">
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
                <label class="mapInline"><input id="mapImportedT9" type="checkbox" /> EVENT</label>
                <label class="mapInline"><input id="mapImportedT10" type="checkbox" /> PHASE LINE</label>
              </div>
              <div class="mapSmallMuted" id="mapImportedLegend"></div>
              <div class="mapSmallMuted">Imported markers come from XTOC Comm “Import” and XTOC Backup imports.</div>
            </div>
            <div class="mapRow" style="margin-top: 12px;">
              <label class="mapInline"><input id="mapTrustedMode" type="checkbox" /> Trusted Mode</label>
              <div class="mapSmallMuted">Only plot SECURE (decrypted) packets on the map overlay.</div>
            </div>
            <div class="mapRow" style="margin-top: 12px;">
              <label class="mapInline"><input id="mapMeshNodes" type="checkbox" /> Mesh nodes</label>
              <div class="mapSmallMuted" id="mapMeshLegend"></div>
              <div class="mapSmallMuted">Plots latest Meshtastic/MeshCore GPS packets and OpenMANET node positions as markers.</div>
              <div class="mapSmallMuted" style="margin-top:6px;">OpenMANET API URL (optional)</div>
              <input id="mapOpenmanetUrl" type="text" spellcheck="false" placeholder="http://10.0.0.1:8087" />
              <div class="mapSmallMuted" style="margin-top:6px;">OpenMANET refresh (ms)</div>
              <input id="mapOpenmanetRefreshMs" type="number" min="500" max="60000" step="100" value="2000" />
              <div class="mapSmallMuted" id="mapOpenmanetStatus" style="margin-top:6px;"></div>
            </div>
            <div class="mapRow" style="margin-top: 12px;">
              <label class="mapInline"><input id="mapShowHidden" type="checkbox" /> Hidden</label>
              <div class="mapSmallMuted">When enabled, plots items you previously hid. Click a hidden marker and choose “Unhide” to restore it.</div>
              <div class="mapSmallMuted" id="mapHiddenLegend"></div>
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
    const trustedModeEl = document.getElementById('mapTrustedMode')
    const meshNodesEl = document.getElementById('mapMeshNodes')
    const meshLegendEl = document.getElementById('mapMeshLegend')
    this._meshLegendEl = meshLegendEl

    const openmanetUrlEl = document.getElementById('mapOpenmanetUrl')
    const openmanetRefreshEl = document.getElementById('mapOpenmanetRefreshMs')
    const openmanetStatusEl = document.getElementById('mapOpenmanetStatus')
    this._openmanetStatusEl = openmanetStatusEl
    const showHiddenEl = document.getElementById('mapShowHidden')
    const hiddenLegendEl = document.getElementById('mapHiddenLegend')
    this._hiddenLegendEl = hiddenLegendEl

    // Base-style-dependent UI (Topographic vs user-configured raster template)
    const rasterRowEl = document.getElementById('mapRasterRow')
    const topoRowEl = document.getElementById('mapTopoRow')
    const syncBaseUi = () => {
      const base = String(baseSel?.value || (globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'))
      const isUserRaster = base === 'offlineRaster' || base === 'offlineRasterDark'
      const isTopo = base === 'topo' || base === 'topoDark'

      try { if (rasterRowEl) rasterRowEl.style.display = isUserRaster ? '' : 'none' } catch (_) {}
      try { if (topoRowEl) topoRowEl.style.display = isTopo ? '' : 'none' } catch (_) {}
      try { if (tplEl) tplEl.disabled = !isUserRaster } catch (_) {}
    }

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

    syncBaseUi()

    baseSel.addEventListener('change', () => {
      try {
        globalThis.setMapBaseStyle && globalThis.setMapBaseStyle(baseSel.value)
      } catch (_) {}
      syncBaseUi()
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
      if (showHiddenEl) showHiddenEl.checked = globalThis.getTacticalMapHiddenOverlayEnabled ? globalThis.getTacticalMapHiddenOverlayEnabled() : false
      this._showHiddenEnabled = !!showHiddenEl?.checked
    } catch (_) {
      if (showHiddenEl) showHiddenEl.checked = false
      this._showHiddenEnabled = false
    }

    try {
      if (meshNodesEl) meshNodesEl.checked = globalThis.getTacticalMapMeshNodesEnabled ? globalThis.getTacticalMapMeshNodesEnabled() : true
      this._meshNodesEnabled = !!meshNodesEl?.checked
    } catch (_) {
      if (meshNodesEl) meshNodesEl.checked = true
      this._meshNodesEnabled = true
    }

    try {
      if (importedLast7El) importedLast7El.checked = globalThis.getTacticalMapImportedLast7dOnly ? globalThis.getTacticalMapImportedLast7dOnly() : true
      this._importedLast7dOnly = !!importedLast7El?.checked
    } catch (_) {
      if (importedLast7El) importedLast7El.checked = true
      this._importedLast7dOnly = true
    }

    // Trusted Mode (defaults OFF)
    try {
      if (trustedModeEl) trustedModeEl.checked = globalThis.getTacticalMapTrustedModeEnabled ? globalThis.getTacticalMapTrustedModeEnabled() : false
      this._trustedModeEnabled = !!trustedModeEl?.checked
    } catch (_) {
      if (trustedModeEl) trustedModeEl.checked = false
      this._trustedModeEnabled = false
    }

    // Seed OpenMANET settings (optional).
    try {
      if (openmanetUrlEl) openmanetUrlEl.value = globalThis.getOpenManetApiBaseUrl ? globalThis.getOpenManetApiBaseUrl() : ''
    } catch (_) {
      if (openmanetUrlEl) openmanetUrlEl.value = ''
    }
    try {
      if (openmanetRefreshEl) openmanetRefreshEl.value = String(globalThis.getOpenManetRefreshMs ? globalThis.getOpenManetRefreshMs() : 2000)
    } catch (_) {
      if (openmanetRefreshEl) openmanetRefreshEl.value = '2000'
    }
    try { if (openmanetStatusEl) openmanetStatusEl.textContent = '' } catch (_) { /* ignore */ }

    const restartOpenmanet = () => {
      try { this.restartOpenmanetPolling() } catch (_) { /* ignore */ }
    }

    openmanetUrlEl?.addEventListener('change', () => {
      try {
        globalThis.setOpenManetApiBaseUrl && globalThis.setOpenManetApiBaseUrl(openmanetUrlEl.value)
      } catch (_) { /* ignore */ }
      restartOpenmanet()
    })

    openmanetRefreshEl?.addEventListener('change', () => {
      const n = Math.max(500, Math.min(60000, Math.floor(Number(openmanetRefreshEl.value || 2000))))
      openmanetRefreshEl.value = String(n)
      try {
        globalThis.setOpenManetRefreshMs && globalThis.setOpenManetRefreshMs(n)
      } catch (_) { /* ignore */ }
      restartOpenmanet()
    })

    // Seed Imported type toggles
    this._importedTplEls = []
    const tplIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
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
        try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
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
    try { this.updateMeshLegend() } catch (_) { /* ignore */ }

    importedEl?.addEventListener('change', () => {
      const v = !!importedEl.checked
      this._importedEnabled = v
      try {
        globalThis.setTacticalMapImportedEnabled && globalThis.setTacticalMapImportedEnabled(v)
      } catch (_) {}
      setImportedUiDisabled(!v)
      this.syncImportedOverlay()
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
    })

    importedLast7El?.addEventListener('change', () => {
      const v = !!importedLast7El.checked
      this._importedLast7dOnly = v
      try {
        globalThis.setTacticalMapImportedLast7dOnly && globalThis.setTacticalMapImportedLast7dOnly(v)
      } catch (_) {}
      this.syncImportedOverlay()
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
    })

    trustedModeEl?.addEventListener('change', () => {
      const v = !!trustedModeEl.checked
      this._trustedModeEnabled = v
      try {
        globalThis.setTacticalMapTrustedModeEnabled && globalThis.setTacticalMapTrustedModeEnabled(v)
      } catch (_) {}
      this.syncImportedOverlay()
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
    })

    showHiddenEl?.addEventListener('change', () => {
      const v = !!showHiddenEl.checked
      this._showHiddenEnabled = v
      try {
        globalThis.setTacticalMapHiddenOverlayEnabled && globalThis.setTacticalMapHiddenOverlayEnabled(v)
      } catch (_) {}
      try { this.syncImportedOverlay() } catch (_) { /* ignore */ }
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
    })

    meshNodesEl?.addEventListener('change', () => {
      const v = !!meshNodesEl.checked
      this._meshNodesEnabled = v
      try {
        globalThis.setTacticalMapMeshNodesEnabled && globalThis.setTacticalMapMeshNodesEnabled(v)
      } catch (_) {}
      this.syncMeshNodesOverlay()
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
    })

    try { this.bindHiddenHandlers() } catch (_) { /* ignore */ }
    try { this.updateHiddenUi() } catch (_) { /* ignore */ }

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
      try { this.ensureMeshNodesOverlay() } catch (_) { /* ignore */ }
      try { this.syncMeshNodesOverlay() } catch (_) { /* ignore */ }
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
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

    const isRaster = base === 'offlineRaster' || base === 'offlineRasterDark' || base === 'topo' || base === 'topoDark'
    if (isRaster) {
      const tpl = (base === 'topo' || base === 'topoDark') ? MAP_TOPO_RASTER_TEMPLATE : rasterTemplate
      // Raster style.
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
          try { this.syncMeshNodesOverlay() } catch (_) { /* ignore */ }
          try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
        })
      } catch (_) {
        // ignore
      }
    } catch (e) {
      console.warn('Failed to set style', e)
    }
  }

  onConnectivityUpdated(e) {
    // Only react while this module is actually mounted; the app swaps modules by
    // replacing DOM nodes, and old module instances can linger.
    if (!this.map || !this.mapEl) return
    try {
      if (this.mapEl.isConnected === false) return
    } catch (_) {
      // ignore
    }

    const base = globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'
    // Only vector bases depend on the internet probe (XCOM_HAS_INTERNET).
    if (base !== 'light' && base !== 'dark') return

    if (this._connectivitySyncTimer) clearTimeout(this._connectivitySyncTimer)
    this._connectivitySyncTimer = setTimeout(() => {
      this._connectivitySyncTimer = null
      try { this.applyBaseStyle() } catch (_) { /* ignore */ }
    }, 0)
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

  extractFirstUnitId(text) {
    const t = String(text ?? '')
    if (!t) return null
    const m = t.match(/\bU(\d+)\b/)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) && n > 0 ? n : null
  }

  getRosterSafeLabelByUnitId() {
    const out = new Map()
    try {
      const roster = (typeof globalThis.xcomGetTeamRoster === 'function') ? globalThis.xcomGetTeamRoster() : null
      const members = Array.isArray(roster?.members) ? roster.members : []
      for (const m of members) {
        const unitId = Number(m?.unitId)
        if (!Number.isFinite(unitId) || unitId <= 0) continue
        const label = String(m?.label ?? '').trim()
        const call = String(m?.hamCallsign ?? '').trim()
        out.set(unitId, label || call || `U${unitId}`)
      }
    } catch (_) {
      // ignore
    }
    return out
  }

  syncImportedTeamMarkerBadge(el, feature, rosterLabelByUnitId) {
    if (!el) return

    let templateId = 0
    let summary = ''
    try {
      templateId = Number(feature?.properties?.templateId || 0) || 0
      summary = String(feature?.properties?.summary || '').trim()
    } catch (_) {
      templateId = 0
      summary = ''
    }

    const existing = el.querySelector ? el.querySelector('.xcomMapMarkerText') : null

    if (templateId !== 4) {
      try { if (existing) existing.remove() } catch (_) { /* ignore */ }
      return
    }

    const unitId = this.extractFirstUnitId(summary)
    const label = unitId != null
      ? (rosterLabelByUnitId?.get?.(unitId) || `U${unitId}`)
      : ''

    let badge = ''
    try {
      if (label && typeof globalThis.xcomBadgeTextFromLabel === 'function') badge = globalThis.xcomBadgeTextFromLabel(label)
    } catch (_) {
      badge = ''
    }

    if (!badge && label) badge = String(label).trim().slice(0, 3).toUpperCase()
    badge = String(badge || '').trim()

    if (!badge) {
      try { if (existing) existing.remove() } catch (_) { /* ignore */ }
      return
    }

    if (existing) {
      try { existing.textContent = badge } catch (_) { /* ignore */ }
      return
    }

    try {
      const badgeEl = document.createElement('span')
      badgeEl.className = 'xcomMapMarkerText'
      badgeEl.textContent = badge
      el.appendChild(badgeEl)
    } catch (_) {
      // ignore
    }
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
      // Prefer local receipt/import time over the sender's packet timestamp.
      // Field reality: sender clocks can be wrong/offline; we still want markers visible
      // (and filtered by "last 7 days") based on when *this* device received/imported them.
      const ts = Number(p.receivedAt ?? p.importedAt ?? p.packetAt ?? 0)
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

    if (kind === 'mesh') {
      addCircle(6, 12, 2)
      addCircle(18, 6, 2)
      addCircle(18, 18, 2)
      addPath('M8 11l8-4')
      addPath('M8 13l8 4')
      addPath('M18 8v8')
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
    if (t === 9) return 'xcomMapMarker--event'
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
    if (t === 9) return 'flag'
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

  setImportedMarkerClasses(el, templateId, isStale, nonActiveKey) {
    if (!el || !el.classList) return
    try { el.classList.add('xcomMapMarker') } catch (_) { /* ignore */ }

    const typeClasses = [
      'xcomMapMarker--sitrep',
      'xcomMapMarker--contact',
      'xcomMapMarker--task',
      'xcomMapMarker--resource',
      'xcomMapMarker--asset',
      'xcomMapMarker--mission',
      'xcomMapMarker--event',
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

    try { el.classList.remove('xcomMapMarker--nonActiveKey') } catch (_) { /* ignore */ }
    if (nonActiveKey) {
      try { el.classList.add('xcomMapMarker--nonActiveKey') } catch (_) { /* ignore */ }
    }
  }

  importedHideIdForFeature(f) {
    try {
      const p = f?.properties || {}
      const templateId = Number(p?.templateId || 0)
      const mode = String(p?.mode || '').trim().toUpperCase()
      const packetId = String(p?.packetId || '').trim()
      const kid = (mode === 'S' && p?.kid != null) ? Math.floor(Number(p.kid)) : null

      // Phase lines: hide by payload ID (so updates stay hidden).
      if (templateId === 10) {
        const phaseLineId = String(p?.phaseLineId || '').trim()
        if (phaseLineId) return `T10:${phaseLineId}`
      }

      // Zones: hide by wrapper identity (polygon + center share the same wrapper).
      if (templateId === 7 && mode && packetId) {
        return `T7:${mode}:${packetId}${(mode === 'S' && Number.isFinite(kid) && kid > 0) ? `:${String(kid)}` : ''}`
      }

      // Fallback: stable feature id when available.
      if (f?.id != null) return String(f.id).trim()
    } catch (_) {
      // ignore
    }
    return ''
  }

  importedPopupHtmlForFeature(f, markerId) {
    const p = f?.properties || {}
    const summary = this.withRosterLabels(String(p?.summary || '').trim())
    const tpl = Number(p?.templateId) || ''
    const mode = String(p?.mode || '').toUpperCase()
    const id = String(p?.packetId || '').trim()
    const kid = (mode === 'S' && p?.kid != null) ? ` KID ${String(p.kid)}` : ''
    const nonActiveKey = p?.nonActiveKey === true
    const activeKidAtStore = Number(p?.activeKidAtStore)
    const keyWarn = nonActiveKey
      ? `<div style="margin-top:8px; padding:6px 8px; border-radius:10px; border:1px solid rgba(246, 201, 69, 0.55); background:rgba(246, 201, 69, 0.12); color:rgba(125, 80, 0, 0.95); font-size:12px; font-weight:800;">
          Non-active key${Number.isFinite(activeKidAtStore) && activeKidAtStore > 0 ? ` (ACTIVE KID ${this.escapeHtml(String(activeKidAtStore))})` : ''}
        </div>`
      : ''
    const whenTs = this.importedTimestampMs(p)
    const when = (Number.isFinite(whenTs) && whenTs > 0) ? new Date(whenTs).toLocaleString() : '-'

    const hideId = String(markerId || '').trim() || this.importedHideIdForFeature(f)
    const hideLabel = summary || (tpl ? `Imported T=${String(tpl)}` : 'Imported')
    const isHidden = (() => {
      if (!hideId) return false
      try {
        if (typeof globalThis.isTacticalMapItemHidden === 'function') return !!globalThis.isTacticalMapItemHidden('imported', hideId)
      } catch (_) {
        // ignore
      }
      try {
        return this.getHiddenItems().some((x) => String(x?.kind ?? '').trim() === 'imported' && String(x?.id ?? '').trim() === hideId)
      } catch (_) {
        return false
      }
    })()

    const actionBtn = hideId
      ? `
        <button
          type="button"
          class="${isHidden ? 'xcomUnhideFromMapBtn' : 'xcomHideFromMapBtn'}"
          data-kind="imported"
          data-id="${this.escapeHtml(hideId)}"
          data-label="${this.escapeHtml(hideLabel)}"
          style="margin-top:10px; width:100%; padding:8px; border-radius:10px; border:1px solid rgba(0,0,0,0.15); background:rgba(0,0,0,0.06); cursor:pointer; font-size:12px;"
        >
          ${isHidden ? 'Unhide' : 'Hide from map'}
        </button>
      `
      : ''

    return `
      <div style="font-weight:700; margin-bottom:6px;">Imported</div>
      ${summary ? `<div style="margin-bottom:6px;">${this.escapeHtml(summary)}</div>` : ''}
      <div style="font-size:12px; color:#444;">
        ${tpl ? `T=${this.escapeHtml(String(tpl))} ` : ''}${mode ? `${this.escapeHtml(mode)} ` : ''}${id ? `ID ${this.escapeHtml(id)}` : ''}${kid ? this.escapeHtml(kid) : ''}
      </div>
      <div style="font-size:12px; color:#444;">${this.escapeHtml(when)}</div>
      ${keyWarn}
      ${actionBtn}
    `
  }

  openImportedPopup(lngLat, feature, markerId) {
    if (!this.map || !lngLat) return
    const map = this.map
    try {
      if (!this._importedPopup && globalThis.maplibregl?.Popup) {
        this._importedPopup = new globalThis.maplibregl.Popup({ closeButton: true, closeOnClick: true })
      }
      if (this._importedPopup) {
        const html = this.importedPopupHtmlForFeature(feature, markerId)
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

    const rosterLabelByUnitId = this.getRosterSafeLabelByUnitId()
    const staleCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000)
    const hiddenIds = new Set()
    try {
      for (const it of this.getHiddenItems()) {
        const kind = String(it?.kind ?? '').trim()
        if (kind !== 'imported') continue
        const id = String(it?.id ?? '').trim()
        if (id) hiddenIds.add(id)
      }
    } catch (_) {
      // ignore
    }
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
      if (hiddenIds.has(id)) continue
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
      const nonActiveKey = f?.properties?.nonActiveKey === true
      const iconKind = this.importedMarkerIconKind(templateId)

      let marker = this._importedMarkerById.get(id) || null
      if (!marker) {
        const el = document.createElement('div')
        el.dataset.xcomImportedId = id
        el.dataset.xcomImportedIconKind = iconKind
        this.setImportedMarkerClasses(el, templateId, isStale, nonActiveKey)
        el.appendChild(this.createMarkerIconSvg(iconKind))

        // Helpful hover text.
        try {
          const summary = this.withRosterLabels(String(f?.properties?.summary || '').trim())
          el.title = summary || `Imported T=${String(templateId || '')}`
        } catch (_) {
          // ignore
        }

        try { this.syncImportedTeamMarkerBadge(el, f, rosterLabelByUnitId) } catch (_) { /* ignore */ }

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
          if (feat && ll) this.openImportedPopup(ll, feat, markerId)
        })

        marker = new globalThis.maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lon, lat])
          .addTo(map)
        this._importedMarkerById.set(id, marker)
      } else {
        try { marker.setLngLat([lon, lat]) } catch (_) { /* ignore */ }
        const el = marker.getElement ? marker.getElement() : null
        if (el) {
          this.setImportedMarkerClasses(el, templateId, isStale, nonActiveKey)

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

          try { this.syncImportedTeamMarkerBadge(el, f, rosterLabelByUnitId) } catch (_) { /* ignore */ }
        }
      }

      this._importedMarkerFeatureById.set(id, f)
    }
  }

  updateImportedLegend() {
    const el = this._importedLegendEl
    if (!el) return
 
    const allEntries = globalThis.getImportedPackets ? globalThis.getImportedPackets() : []
    const total = Array.isArray(allEntries) ? allEntries.length : 0
    const entries = this._trustedModeEnabled ? (Array.isArray(allEntries) ? allEntries.filter((e) => e?.mode === 'S') : []) : allEntries
    const count = Array.isArray(entries) ? entries.length : 0
    const hidden = !this._importedEnabled
    const win = this._importedLast7dOnly ? ' (last 7d)' : ''
    const trust = this._trustedModeEnabled ? ` (${count}/${total} trusted)` : ''
    el.textContent = `Imported: ${count}${hidden ? ' (hidden)' : ''}${win}${trust}`
  }

  getImportedOverlayFeatures() {
    try {
      const entries = globalThis.getImportedPackets ? globalThis.getImportedPackets() : []
      const out = []
      for (const e of Array.isArray(entries) ? entries : []) {
        if (this._trustedModeEnabled && e?.mode !== 'S') continue
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

    // Threat (zone) palette (match XTOC Tactical Map).
    const zoneFillExpr = [
      'case',
      ['==', ['get', 'threat'], 0], 'rgba(46,230,166,0.18)',
      ['==', ['get', 'threat'], 1], 'rgba(255,96,96,0.18)',
      'rgba(246,201,69,0.18)',
    ]
    const zoneStrokeExpr = [
      'case',
      ['==', ['get', 'threat'], 0], 'rgba(46,230,166,0.95)',
      ['==', ['get', 'threat'], 1], 'rgba(255,96,96,0.95)',
      'rgba(246,201,69,0.95)',
    ]

    const fillColorExpr = ['coalesce', ['get', 'fill'], ['case', ['has', 'threat'], zoneFillExpr, 'rgba(246,201,69,0.18)']]
    const polyStrokeColorExpr = ['coalesce', ['get', 'stroke'], ['case', ['has', 'threat'], zoneStrokeExpr, 'rgba(0,0,0,0.65)']]
    const lineStrokeColorExpr = ['coalesce', ['get', 'stroke'], ['case', ['has', 'threat'], zoneStrokeExpr, 'rgba(124,199,255,0.95)']]

    // Bind global update listener once per module instance.
    if (!this._importedHandlersBound) {
      this._importedHandlersBound = true

      try { if (globalThis.__xcomMapCleanup) globalThis.__xcomMapCleanup() } catch (_) { /* ignore */ }
      const onImportedUpdated = () => {
        try { this.syncImportedOverlay() } catch (_) { /* ignore */ }
        try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
      }
      const onRosterUpdated = () => {
        try { this.syncImportedOverlay() } catch (_) { /* ignore */ }
        try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
      }
      try { globalThis.addEventListener('xcomImportedPacketsUpdated', onImportedUpdated) } catch (_) { /* ignore */ }
      try { globalThis.addEventListener('xcomTeamRosterUpdated', onRosterUpdated) } catch (_) { /* ignore */ }
      globalThis.__xcomMapCleanup = () => {
        try { globalThis.removeEventListener('xcomImportedPacketsUpdated', onImportedUpdated) } catch (_) { /* ignore */ }
        try { globalThis.removeEventListener('xcomTeamRosterUpdated', onRosterUpdated) } catch (_) { /* ignore */ }
        try { if (this._importedTimeWindowTimer) clearInterval(this._importedTimeWindowTimer) } catch (_) { /* ignore */ }
        this._importedTimeWindowTimer = null
      }

      // Time-window auto-hide refresh (phase lines)
      try { if (this._importedTimeWindowTimer) clearInterval(this._importedTimeWindowTimer) } catch (_) { /* ignore */ }
      const tickPhaseLines = () => {
        if (!this._importedEnabled) return
        if (!this.importedTemplateEnabled(10)) return
        try { this.syncImportedOverlay() } catch (_) { /* ignore */ }
      }
      this._importedTimeWindowTimer = setInterval(tickPhaseLines, 30_000)
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
            // Match XTOC Tactical Map: zones are threat-colored.
            'fill-color': fillColorExpr,
            'fill-outline-color': polyStrokeColorExpr,
          },
        })
      }
    } catch (_) {
      // ignore
    }

    try {
      if (!map.getLayer(this._importedOutlineLayerId)) {
        map.addLayer({
          id: this._importedOutlineLayerId,
          type: 'line',
          source: this._importedSourceId,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: {
            'line-color': polyStrokeColorExpr,
            'line-width': ['coalesce', ['get', 'strokeWidth'], 2],
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
          filter: [
            'all',
            ['==', ['geometry-type'], 'LineString'],
            ['!=', ['get', 'lineStyle'], 'dashed'],
            ['!=', ['get', 'lineStyle'], 'double'],
          ],
          paint: {
            'line-color': lineStrokeColorExpr,
            'line-width': ['coalesce', ['get', 'strokeWidth'], 3],
          },
        })
      }
    } catch (_) {
      // ignore
    }

    // Dashed lines (phase lines, etc.)
    try {
      if (!map.getLayer(this._importedDashedLineLayerId)) {
        map.addLayer({
          id: this._importedDashedLineLayerId,
          type: 'line',
          source: this._importedSourceId,
          filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'lineStyle'], 'dashed']],
          paint: {
            'line-color': lineStrokeColorExpr,
            'line-width': ['coalesce', ['get', 'strokeWidth'], 3],
            'line-dasharray': [2, 2],
          },
        })
      }
    } catch (_) {
      // ignore
    }

    // Double lines (rendered as 2 offset lines)
    const doubleFilter = ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'lineStyle'], 'double']]
    try {
      if (!map.getLayer(this._importedDoubleLineLayerAId)) {
        map.addLayer({
          id: this._importedDoubleLineLayerAId,
          type: 'line',
          source: this._importedSourceId,
          filter: doubleFilter,
          paint: {
            'line-color': lineStrokeColorExpr,
            'line-width': ['coalesce', ['get', 'strokeWidth'], 3],
            'line-offset': 2,
          },
        })
      }
    } catch (_) {
      // ignore
    }
    try {
      if (!map.getLayer(this._importedDoubleLineLayerBId)) {
        map.addLayer({
          id: this._importedDoubleLineLayerBId,
          type: 'line',
          source: this._importedSourceId,
          filter: doubleFilter,
          paint: {
            'line-color': lineStrokeColorExpr,
            'line-width': ['coalesce', ['get', 'strokeWidth'], 3],
            'line-offset': -2,
          },
        })
      }
    } catch (_) {
      // ignore
    }

    // Extra key warning outline (non-active key packets)
    try {
      if (!map.getLayer(this._importedKeyWarnLineLayerId)) {
        map.addLayer({
          id: this._importedKeyWarnLineLayerId,
          type: 'line',
          source: this._importedSourceId,
          filter: [
            'all',
            ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'LineString']],
            ['==', ['get', 'nonActiveKey'], true],
          ],
          paint: {
            'line-color': '#f6c945',
            'line-width': 4,
            'line-dasharray': [2, 2],
          },
        })
      }
    } catch (_) {
      // ignore
    }

    // Zone center points (templateId=7) as circles (match XTOC zone center markers).
    try {
      if (!map.getLayer(this._importedPointLayerId)) {
        map.addLayer({
          id: this._importedPointLayerId,
          type: 'circle',
          source: this._importedSourceId,
          filter: [
            'all',
            ['==', ['geometry-type'], 'Point'],
            ['==', ['get', 'kind'], 'zoneCenter'],
          ],
          paint: {
            'circle-radius': 8,
            'circle-color': ['coalesce', ['get', 'stroke'], ['case', ['has', 'threat'], zoneStrokeExpr, 'rgba(124,199,255,0.95)']],
            'circle-stroke-color': 'rgba(0,0,0,0.65)',
            'circle-stroke-width': 2,
          },
        })
      }
    } catch (_) {
      // ignore
    }

    // Click handlers (bind once; layer ids remain stable across re-adds)
    try { map.off('click', this._importedFillLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.off('click', this._importedOutlineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.off('click', this._importedLineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.off('click', this._importedDashedLineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.off('click', this._importedDoubleLineLayerAId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.off('click', this._importedDoubleLineLayerBId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.off('click', this._importedKeyWarnLineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.off('click', this._importedPointLayerId, this._onImportedClick) } catch (_) { /* ignore */ }

    this._onImportedClick = (ev) => {
      try {
        const f = ev?.features?.[0] || null
        if (!f) return
        this.openImportedPopup(ev?.lngLat, f, null)
      } catch (_) {
        // ignore
      }
    }

    try { map.on('click', this._importedFillLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.on('click', this._importedOutlineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.on('click', this._importedLineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.on('click', this._importedDashedLineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.on('click', this._importedDoubleLineLayerAId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.on('click', this._importedDoubleLineLayerBId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.on('click', this._importedKeyWarnLineLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
    try { map.on('click', this._importedPointLayerId, this._onImportedClick) } catch (_) { /* ignore */ }
  }

  setImportedLayerVisibility(visible) {
    if (!this.map) return
    const map = this.map
    const v = visible ? 'visible' : 'none'
    try { if (map.getLayer(this._importedPointLayerId)) map.setLayoutProperty(this._importedPointLayerId, 'visibility', v) } catch (_) {}
    try { if (map.getLayer(this._importedOutlineLayerId)) map.setLayoutProperty(this._importedOutlineLayerId, 'visibility', v) } catch (_) {}
    try { if (map.getLayer(this._importedLineLayerId)) map.setLayoutProperty(this._importedLineLayerId, 'visibility', v) } catch (_) {}
    try { if (map.getLayer(this._importedDashedLineLayerId)) map.setLayoutProperty(this._importedDashedLineLayerId, 'visibility', v) } catch (_) {}
    try { if (map.getLayer(this._importedDoubleLineLayerAId)) map.setLayoutProperty(this._importedDoubleLineLayerAId, 'visibility', v) } catch (_) {}
    try { if (map.getLayer(this._importedDoubleLineLayerBId)) map.setLayoutProperty(this._importedDoubleLineLayerBId, 'visibility', v) } catch (_) {}
    try { if (map.getLayer(this._importedKeyWarnLineLayerId)) map.setLayoutProperty(this._importedKeyWarnLineLayerId, 'visibility', v) } catch (_) {}
    try { if (map.getLayer(this._importedFillLayerId)) map.setLayoutProperty(this._importedFillLayerId, 'visibility', v) } catch (_) {}
  }

  syncImportedOverlay() {
    if (!this.map) return
    const map = this.map

    const rawAllFeatures = this.getImportedOverlayFeatures()

    const showHidden = !!this._showHiddenEnabled
    const hiddenIds = new Set()
    try {
      for (const it of this.getHiddenItems()) {
        const kind = String(it?.kind ?? '').trim()
        if (kind !== 'imported') continue
        const id = String(it?.id ?? '').trim()
        if (id) hiddenIds.add(id)
      }
    } catch (_) {
      // ignore
    }

    const isZoneCenter = (f) => {
      try {
        return f?.geometry?.type === 'Point' && String(f?.properties?.kind ?? '').trim() === 'zoneCenter'
      } catch (_) {
        return false
      }
    }

    const styleHidden = (f) => {
      try {
        const g = f?.geometry || null
        const p = (f?.properties && typeof f.properties === 'object') ? f.properties : {}
        const nextProps = { ...p, stroke: 'rgba(160,160,160,0.85)' }
        if (String(g?.type || '') === 'Polygon') nextProps.fill = 'rgba(160,160,160,0.18)'
        return { ...f, properties: nextProps }
      } catch (_) {
        return f
      }
    }

    // Normal imported overlay features (respect filters/toggles).
    let allFeatures = rawAllFeatures
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

    // Phase lines: client-side auto-hide rules (match XTOC Tactical Map).
    // - CLOSED hides
    // - start/end window hides outside the window
    try {
      const now = Date.now()
      allFeatures = allFeatures.filter((f) => {
        try {
          const p = (f?.properties && typeof f.properties === 'object') ? f.properties : {}
          const tpl = Number(p?.templateId) || 0
          if (tpl !== 10) return true

          const status = Number(p?.status)
          if (Number.isFinite(status) && Math.floor(status) === 3) return false

          const startAt = Number(p?.startAt)
          if (Number.isFinite(startAt) && startAt > 0 && now < startAt) return false

          const endAt = Number(p?.endAt)
          if (Number.isFinite(endAt) && endAt > 0 && now > endAt) return false

          return true
        } catch (_) {
          return true
        }
      })
    } catch (_) {
      // ignore
    }

    // Phase lines: dedup by payload ID (keep newest updatedAt/packetAt).
    try {
      const bestById = new Map()

      for (const f of allFeatures) {
        try {
          const p = (f?.properties && typeof f.properties === 'object') ? f.properties : {}
          const tpl = Number(p?.templateId) || 0
          if (tpl !== 10) continue

          const phaseLineId = String(p?.phaseLineId || '').trim()
          if (!phaseLineId) continue
          if (String(f?.geometry?.type || '') !== 'LineString') continue

          const tsRaw = this.importedTimestampMs(p)
          const ts = (Number.isFinite(tsRaw) && tsRaw > 0) ? tsRaw : 0

          const prev = bestById.get(phaseLineId)
          if (!prev || ts > prev.ts) bestById.set(phaseLineId, { f, ts })
        } catch (_) {
          // ignore
        }
      }

      if (bestById.size) {
        allFeatures = allFeatures.filter((f) => {
          try {
            const p = (f?.properties && typeof f.properties === 'object') ? f.properties : {}
            const tpl = Number(p?.templateId) || 0
            if (tpl !== 10) return true

            const phaseLineId = String(p?.phaseLineId || '').trim()
            if (!phaseLineId) return true
            if (String(f?.geometry?.type || '') !== 'LineString') return true

            const best = bestById.get(phaseLineId)
            return best ? best.f === f : true
          } catch (_) {
            return true
          }
        })
      }
    } catch (_) {
      // ignore
    }

    if (!this._importedEnabled) {
      try { this.clearImportedMarkers() } catch (_) { /* ignore */ }
      allFeatures = []
    }

    // Normal, non-hidden geometries.
    const normalSrcFeatures = allFeatures.filter((f) => {
      try { return f?.geometry?.type !== 'Point' || isZoneCenter(f) } catch (_) { return true }
    }).filter((f) => {
      const hideId = this.importedHideIdForFeature(f)
      return !(hideId && hiddenIds.has(hideId))
    })
    const pointFeatures = allFeatures.filter((f) => {
      try { return f?.geometry?.type === 'Point' && !isZoneCenter(f) } catch (_) { return false }
    })

    // Hidden geometries (lines/polygons/zoneCenter) when "Show hidden" is enabled.
    let hiddenSrcFeatures = []
    if (showHidden && hiddenIds.size) {
      hiddenSrcFeatures = rawAllFeatures.filter((f) => {
        try {
          const isGeom = f?.geometry?.type !== 'Point' || isZoneCenter(f)
          if (!isGeom) return false
          const hideId = this.importedHideIdForFeature(f)
          return hideId && hiddenIds.has(hideId)
        } catch (_) {
          return false
        }
      })

      // Dedup hidden phase lines by payload ID (keep newest).
      try {
        const bestById = new Map()
        for (const f of hiddenSrcFeatures) {
          try {
            const p = (f?.properties && typeof f.properties === 'object') ? f.properties : {}
            const tpl = Number(p?.templateId) || 0
            if (tpl !== 10) continue
            const phaseLineId = String(p?.phaseLineId || '').trim()
            if (!phaseLineId) continue
            if (String(f?.geometry?.type || '') !== 'LineString') continue

            const tsRaw = this.importedTimestampMs(p)
            const ts = (Number.isFinite(tsRaw) && tsRaw > 0) ? tsRaw : 0
            const prev = bestById.get(phaseLineId)
            if (!prev || ts > prev.ts) bestById.set(phaseLineId, { f, ts })
          } catch (_) {
            // ignore
          }
        }

        if (bestById.size) {
          hiddenSrcFeatures = hiddenSrcFeatures.filter((f) => {
            try {
              const p = (f?.properties && typeof f.properties === 'object') ? f.properties : {}
              const tpl = Number(p?.templateId) || 0
              if (tpl !== 10) return true
              const phaseLineId = String(p?.phaseLineId || '').trim()
              if (!phaseLineId) return true
              if (String(f?.geometry?.type || '') !== 'LineString') return true
              const best = bestById.get(phaseLineId)
              return best ? best.f === f : true
            } catch (_) {
              return true
            }
          })
        }
      } catch (_) {
        // ignore
      }

      hiddenSrcFeatures = hiddenSrcFeatures.map(styleHidden)
    }

    const srcFeatures = [...normalSrcFeatures, ...hiddenSrcFeatures]

    try {
      const src = map.getSource(this._importedSourceId)
      if (src && typeof src.setData === 'function') {
        src.setData({ type: 'FeatureCollection', features: srcFeatures })
      }
    } catch (_) {
      // ignore
    }

    if (this._importedEnabled) {
      try { this.syncImportedMarkers(pointFeatures) } catch (_) { /* ignore */ }
    }

    const visible = srcFeatures.length > 0
    this.setImportedLayerVisibility(visible)

    try { this.updateImportedLegend() } catch (_) { /* ignore */ }
  }

  updateMeshLegend() {
    const el = this._meshLegendEl
    if (!el) return

    let nodes = []
    try {
      const s = globalThis.xcomMesh?.getState?.()
      nodes = Array.isArray(s?.nodes) ? s.nodes : (globalThis.meshGetNodes ? globalThis.meshGetNodes() : [])
    } catch (_) {
      nodes = []
    }

    const openmanet = Array.isArray(this._openmanetNodes) ? this._openmanetNodes : []
    const all = [...(Array.isArray(nodes) ? nodes : []), ...openmanet]

    const withPos = all.filter((n) => {
      const pos = n?.position
      const lat = Number(pos?.lat)
      const lon = Number(pos?.lon)
      return Number.isFinite(lat) && Number.isFinite(lon)
    }).length
    const hidden = !this._meshNodesEnabled
    el.textContent = `Mesh nodes: ${all.length} (${withPos} with position)${hidden ? ' (hidden)' : ''}`
  }

  getHiddenItems() {
    try {
      const list = globalThis.getTacticalMapHiddenItems ? globalThis.getTacticalMapHiddenItems() : []
      return Array.isArray(list) ? list : []
    } catch (_) {
      return []
    }
  }

  hideMapItem(kind, id, label) {
    const k = String(kind || '').trim()
    const i = String(id || '').trim()
    if (!k || !i) return

    try {
      globalThis.hideTacticalMapItem && globalThis.hideTacticalMapItem(k, i, label)
    } catch (_) {
      // ignore
    }

    try { if (this._importedPopup) this._importedPopup.remove() } catch (_) { /* ignore */ }
    try { this.updateHiddenUi() } catch (_) { /* ignore */ }

    if (k === 'imported') {
      try { this.syncImportedOverlay() } catch (_) { /* ignore */ }
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
      return
    }
    if (k === 'mesh') {
      try { this.syncMeshNodesOverlay() } catch (_) { /* ignore */ }
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
    }
  }

  unhideMapItem(kind, id) {
    const k = String(kind || '').trim()
    const i = String(id || '').trim()
    if (!k || !i) return

    try {
      globalThis.unhideTacticalMapItem && globalThis.unhideTacticalMapItem(k, i)
    } catch (_) {
      // ignore
    }

    try { this.updateHiddenUi() } catch (_) { /* ignore */ }

    if (k === 'imported') {
      try { this.syncImportedOverlay() } catch (_) { /* ignore */ }
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
      return
    }
    if (k === 'mesh') {
      try { this.syncMeshNodesOverlay() } catch (_) { /* ignore */ }
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
    }
  }

  updateHiddenUi() {
    const legendEl = this._hiddenLegendEl
    if (!legendEl) return

    const items = this.getHiddenItems()
    const count = items.length

    legendEl.textContent = count ? `${count} item(s) hidden` : 'None.'
  }

  bindHiddenHandlers() {
    if (this._hiddenHandlersBound) return
    this._hiddenHandlersBound = true

    try { if (globalThis.__xcomMapHiddenCleanup) globalThis.__xcomMapHiddenCleanup() } catch (_) { /* ignore */ }

    const onDocClick = (e) => {
      try {
        const t = e?.target
        const hideBtn = t && typeof t.closest === 'function' ? t.closest('.xcomHideFromMapBtn') : null
        const unhideBtn = !hideBtn && t && typeof t.closest === 'function' ? t.closest('.xcomUnhideFromMapBtn') : null
        const btn = hideBtn || unhideBtn
        if (!btn) return

        e.preventDefault()
        e.stopPropagation()

        const kind = String(btn.dataset?.kind || '').trim()
        const id = String(btn.dataset?.id || '').trim()
        if (hideBtn) {
          const label = String(btn.dataset?.label || '').trim()
          this.hideMapItem(kind, id, label)
          return
        }

        // Unhide
        try { if (this._importedPopup) this._importedPopup.remove() } catch (_) { /* ignore */ }
        this.unhideMapItem(kind, id)
      } catch (_) {
        // ignore
      }
    }

    try { document.addEventListener('click', onDocClick) } catch (_) { /* ignore */ }
    globalThis.__xcomMapHiddenCleanup = () => {
      try { document.removeEventListener('click', onDocClick) } catch (_) { /* ignore */ }
    }
  }

  openmanetSetStatus(text) {
    const el = this._openmanetStatusEl
    if (!el) return
    el.textContent = String(text || '').trim()
  }

  stopOpenmanetPolling() {
    try {
      if (this._openmanetTimer) clearInterval(this._openmanetTimer)
    } catch (_) {
      // ignore
    }
    this._openmanetTimer = null

    try {
      if (this._openmanetAbort) this._openmanetAbort.abort()
    } catch (_) {
      // ignore
    }
    this._openmanetAbort = null
  }

  restartOpenmanetPolling() {
    this.stopOpenmanetPolling()

    const normalizeBaseUrl = (url) => String(url || '').trim().replace(/\/$/, '')

    let apiBaseUrl = ''
    try {
      apiBaseUrl = globalThis.getOpenManetApiBaseUrl ? globalThis.getOpenManetApiBaseUrl() : ''
    } catch (_) {
      apiBaseUrl = ''
    }
    apiBaseUrl = normalizeBaseUrl(apiBaseUrl)

    let refreshMs = 2000
    try {
      refreshMs = globalThis.getOpenManetRefreshMs ? globalThis.getOpenManetRefreshMs() : 2000
    } catch (_) {
      refreshMs = 2000
    }
    refreshMs = Math.max(500, Math.min(60000, Math.floor(Number(refreshMs || 2000))))

    if (!apiBaseUrl) {
      this._openmanetNodes = []
      this.openmanetSetStatus('')
      try { this.syncMeshNodesOverlay() } catch (_) { /* ignore */ }
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
      try { this.updateMeshLegend() } catch (_) { /* ignore */ }
      return
    }

    const getBridgeBaseUrl = () => {
      // Prefer transport (if loaded), otherwise read from localStorage.
      let base = ''
      try { base = globalThis.xcomHaLow?.getConfig?.()?.baseUrl || '' } catch (_) { base = '' }
      if (base) return normalizeBaseUrl(base)
      try {
        const raw = localStorage.getItem('xcom.halow.config.v1')
        if (!raw) return ''
        const obj = JSON.parse(raw)
        return normalizeBaseUrl(obj?.baseUrl || '')
      } catch (_) {
        return ''
      }
    }

    const toNode = (raw, now) => {
      const hostname = String(raw?.hostname ?? raw?.hostName ?? '').trim()
      const mac = String(raw?.mac ?? '').trim()
      const ipaddr = String(raw?.ipaddr ?? raw?.ipAddr ?? raw?.ip_address ?? '').trim()
      const id = hostname || mac || ipaddr
      if (!id) return null

      const pos = raw?.position || null
      const lat = Number(pos?.latitude ?? pos?.lat)
      const lon = Number(pos?.longitude ?? pos?.lon)
      const alt = Number(pos?.altitude ?? pos?.alt)

      const position = (Number.isFinite(lat) && Number.isFinite(lon))
        ? { lat, lon, ...(Number.isFinite(alt) ? { alt } : {}), ts: now }
        : null

      return {
        driver: 'openmanet',
        id,
        shortName: hostname || id,
        longName: ipaddr || mac || '',
        ...(position ? { position } : {}),
      }
    }

    const fetchViaBridge = async (signal) => {
      const bridgeBaseUrl = getBridgeBaseUrl()
      if (!bridgeBaseUrl) throw new Error('Bridge URL is empty')
      const url = `${bridgeBaseUrl}/openmanet/nodes?base_url=${encodeURIComponent(apiBaseUrl)}`
      const res = await fetch(url, { cache: 'no-store', signal })
      if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`)
      const json = await res.json()
      if (!json?.ok) throw new Error(String(json?.error || 'Bridge error'))
      if (!Array.isArray(json?.nodes)) throw new Error('Bridge response missing nodes[]')
      return json.nodes
    }

    const fetchDirect = async (signal) => {
      const url = `${apiBaseUrl}/openmanet.service.v1.NodeService/ListNodes`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
        cache: 'no-store',
        signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const nodes = json?.nodes ?? json?.Nodes
      if (!Array.isArray(nodes)) throw new Error('Response missing nodes[]')
      return nodes
    }

    const ac = new AbortController()
    this._openmanetAbort = ac
    let inFlight = false

    const tick = async () => {
      if (inFlight) return
      inFlight = true
      this.openmanetSetStatus('Connecting…')

      const ctrl = new AbortController()
      const onAbort = () => ctrl.abort()
      try { ac.signal.addEventListener('abort', onAbort) } catch (_) { /* ignore */ }
      const t = setTimeout(() => ctrl.abort(), 2500)
      try {
        let rawNodes
        try {
          rawNodes = await fetchViaBridge(ctrl.signal)
        } catch (_) {
          rawNodes = await fetchDirect(ctrl.signal)
        }

        const now = Date.now()
        const nodes = (Array.isArray(rawNodes) ? rawNodes : []).map((n) => toNode(n, now)).filter(Boolean)
        this._openmanetNodes = nodes
        this.openmanetSetStatus(`OK • ${nodes.length} node(s)`)
        try { this.syncMeshNodesOverlay() } catch (_) { /* ignore */ }
        try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
        try { this.updateMeshLegend() } catch (_) { /* ignore */ }
      } catch (e) {
        if (String(e?.name) === 'AbortError') return
        this.openmanetSetStatus(`Error: ${String(e?.message || e)}`)
      } finally {
        try { clearTimeout(t) } catch (_) { /* ignore */ }
        try { ac.signal.removeEventListener('abort', onAbort) } catch (_) { /* ignore */ }
        inFlight = false
      }
    }

    tick()
    this._openmanetTimer = setInterval(tick, refreshMs)
  }

  meshNodeKeyForNode(node) {
    const n = node && typeof node === 'object' ? node : {}
    const num = Number(n?.num)

    let driver = String(n?.driver || '').trim()
    if (!driver) {
      try {
        const cfgDriver = globalThis.xcomMesh?.getState?.()?.config?.driver
        driver = cfgDriver === 'meshcore' ? 'meshcore' : 'meshtastic'
      } catch (_) {
        driver = 'meshtastic'
      }
    }
    if (driver !== 'meshcore' && driver !== 'openmanet') driver = 'meshtastic'

    let id = String(n?.id || '').trim()
    if (!id && driver === 'meshtastic' && Number.isFinite(num)) {
      id = formatMeshtasticNodeId(num) || ''
    }
    if (id) return `${driver}:${id}`
    if (Number.isFinite(num)) return `${driver}:#${Math.floor(num)}`
    return null
  }

  meshAssignedLabelByNodeKey() {
    const out = new Map()
    let members = []
    try {
      members = globalThis.xcomListRosterMembers ? globalThis.xcomListRosterMembers() : (globalThis.xcomGetTeamRoster?.()?.members || [])
    } catch (_) {
      members = []
    }
    for (const m of Array.isArray(members) ? members : []) {
      const key = String(m?.meshNodeId ?? m?.meshNodeKey ?? '').trim()
      if (!key) continue
      const unitId = Number(m?.unitId)
      if (!Number.isFinite(unitId) || unitId <= 0) continue
      let label = String(m?.label ?? '').trim()
      if (globalThis.xcomFormatUnitWithLabel) {
        try { label = globalThis.xcomFormatUnitWithLabel(unitId, label) } catch (_) { /* ignore */ }
      } else {
        label = label ? `U${unitId} (${label})` : `U${unitId}`
      }
      out.set(key, label)
    }
    return out
  }

  meshNodePopupHtml(node, assignedLabel, nodeKey) {
    const n = node && typeof node === 'object' ? node : {}
    const key = String(nodeKey || this.meshNodeKeyForNode(n) || '').trim()
    const driver = String(n?.driver || (key.split(':')[0] || '')).trim()
    const id = String(n?.id || (key.split(':').slice(1).join(':') || '')).trim()
    const name = String(n?.shortName || n?.longName || '').trim()
    const pos = n?.position || null
    const lat = Number(pos?.lat)
    const lon = Number(pos?.lon)
    const whenTs = Number(pos?.ts ?? n?.lastSeenTs ?? 0)
    const when = (Number.isFinite(whenTs) && whenTs > 0) ? new Date(whenTs).toLocaleString() : '-'

    const loc = (Number.isFinite(lat) && Number.isFinite(lon)) ? `${lat.toFixed(5)}, ${lon.toFixed(5)}` : '-'
    const assigned = String(assignedLabel || '').trim()

    const row = (k, v) => `<div style="font-size:12px; color:#444;"><span style="font-weight:700;">${this.escapeHtml(k)}:</span> ${this.escapeHtml(v)}</div>`

    const titleBase = name || id || key || 'Mesh node'
    const hideLabel = assigned ? `${titleBase} (${assigned})` : titleBase
    const isHidden = (() => {
      if (!key) return false
      try {
        if (typeof globalThis.isTacticalMapItemHidden === 'function') return !!globalThis.isTacticalMapItemHidden('mesh', key)
      } catch (_) {
        // ignore
      }
      try {
        return this.getHiddenItems().some((x) => String(x?.kind ?? '').trim() === 'mesh' && String(x?.id ?? '').trim() === key)
      } catch (_) {
        return false
      }
    })()

    const actionBtn = key
      ? `
        <button
          type="button"
          class="${isHidden ? 'xcomUnhideFromMapBtn' : 'xcomHideFromMapBtn'}"
          data-kind="mesh"
          data-id="${this.escapeHtml(key)}"
          data-label="${this.escapeHtml(hideLabel)}"
          style="margin-top:10px; width:100%; padding:8px; border-radius:10px; border:1px solid rgba(0,0,0,0.15); background:rgba(0,0,0,0.06); cursor:pointer; font-size:12px;"
        >
          ${isHidden ? 'Unhide' : 'Hide from map'}
        </button>
      `
      : ''

    // Optional: allow assigning this node to a roster unit (for labeling/tracking).
    let assignHtml = ''
    try {
      const members = globalThis.xcomListRosterMembers ? globalThis.xcomListRosterMembers() : []
      const list = Array.isArray(members) ? members : []
      if (list.length) {
        let selectedUnitId = ''
        for (const m of list) {
          if (String(m?.meshNodeId ?? '').trim() === key) {
            selectedUnitId = String(m?.unitId ?? '').trim()
            break
          }
        }

        let opts = '<option value="">Unassigned</option>'
        for (const m of list) {
          const unitId = Number(m?.unitId)
          if (!Number.isFinite(unitId) || unitId <= 0) continue
          let label = String(m?.label ?? '').trim()
          try {
            if (globalThis.xcomFormatUnitWithLabel) label = globalThis.xcomFormatUnitWithLabel(unitId, label)
          } catch (_) {
            // ignore
          }
          const value = String(unitId)
          const sel = value === selectedUnitId ? ' selected' : ''
          opts += `<option value="${this.escapeHtml(value)}"${sel}>${this.escapeHtml(label || `U${value}`)}</option>`
        }

        assignHtml = `
          <div style="margin-top:10px;">
            <div style="font-size:12px; font-weight:700; margin-bottom:4px;">Assign to team member</div>
            <select class="xcomMeshAssignSelect" data-node-key="${this.escapeHtml(key)}" style="width:100%; padding:6px; font-size:12px;">
              ${opts}
            </select>
          </div>
        `
      } else {
        assignHtml = `
          <div style="margin-top:10px; font-size:12px; color:#666;">
            Tip: import a roster in Comms → Team to assign nodes.
          </div>
        `
      }
    } catch (_) {
      assignHtml = ''
    }

    return `
      <div style="font-weight:700; margin-bottom:6px;">Mesh Node</div>
      ${assigned ? row('Assigned', assigned) : ''}
      ${name ? row('Name', name) : ''}
      ${driver ? row('Driver', driver) : ''}
      ${id ? row('ID', id) : ''}
      ${key ? row('Key', key) : ''}
      ${row('Location', loc)}
      ${row('Last', when)}
      ${assignHtml}
      ${actionBtn}
    `
  }

  ensureMeshNodesOverlay() {
    if (this._meshHandlersBound) return
    this._meshHandlersBound = true

    try { if (globalThis.__xcomMapMeshCleanup) globalThis.__xcomMapMeshCleanup() } catch (_) { /* ignore */ }

    const onRosterUpdated = () => {
      try { this.syncMeshNodesOverlay() } catch (_) { /* ignore */ }
      try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
    }
    try { globalThis.addEventListener('xcomTeamRosterUpdated', onRosterUpdated) } catch (_) { /* ignore */ }

    const onAssignChange = (e) => {
      try {
        const sel = e?.target
        if (!sel || !sel.classList || !sel.classList.contains('xcomMeshAssignSelect')) return
        const nodeKey = String(sel?.dataset?.nodeKey || '').trim()
        if (!nodeKey) return
        const unitId = sel?.value ?? ''
        if (typeof globalThis.xcomSetMeshNodeAssignment !== 'function') return
        globalThis.xcomSetMeshNodeAssignment(nodeKey, unitId)
      } catch (_) {
        // ignore
      }
    }
    try { document.addEventListener('change', onAssignChange) } catch (_) { /* ignore */ }

    let unsub = null
    try {
      if (globalThis.xcomMesh && typeof globalThis.xcomMesh.subscribe === 'function') {
        unsub = globalThis.xcomMesh.subscribe(() => {
          try { this.syncMeshNodesOverlay() } catch (_) { /* ignore */ }
          try { this.syncHiddenOverlay() } catch (_) { /* ignore */ }
        })
      }
    } catch (_) {
      unsub = null
    }
    this._meshUnsub = unsub

    globalThis.__xcomMapMeshCleanup = () => {
      try { if (this._meshUnsub) this._meshUnsub() } catch (_) { /* ignore */ }
      this._meshUnsub = null
      try { globalThis.removeEventListener('xcomTeamRosterUpdated', onRosterUpdated) } catch (_) { /* ignore */ }
      try { document.removeEventListener('change', onAssignChange) } catch (_) { /* ignore */ }
      try { this.stopOpenmanetPolling() } catch (_) { /* ignore */ }
    }

    // Start OpenMANET polling (if configured).
    try { this.restartOpenmanetPolling() } catch (_) { /* ignore */ }
  }

  syncMeshNodesOverlay() {
    if (!this.map || !globalThis.maplibregl?.Marker) return
    const map = this.map

    const hiddenKeys = new Set()
    try {
      for (const it of this.getHiddenItems()) {
        const kind = String(it?.kind ?? '').trim()
        if (kind !== 'mesh') continue
        const key = String(it?.id ?? '').trim()
        if (key) hiddenKeys.add(key)
      }
    } catch (_) {
      // ignore
    }

    let nodes = []
    try {
      const s = globalThis.xcomMesh?.getState?.()
      nodes = Array.isArray(s?.nodes) ? s.nodes : (globalThis.meshGetNodes ? globalThis.meshGetNodes() : [])
    } catch (_) {
      nodes = []
    }

    try {
      const openmanet = Array.isArray(this._openmanetNodes) ? this._openmanetNodes : []
      if (openmanet.length) nodes = [...(Array.isArray(nodes) ? nodes : []), ...openmanet]
    } catch (_) {
      // ignore
    }

    if (!this._meshNodesEnabled) {
      try {
        for (const m of this._meshMarkerByKey?.values?.() || []) {
          try { m.remove() } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
      try { this._meshMarkerByKey?.clear?.() } catch (_) { /* ignore */ }
      try { this._meshPopupByKey?.clear?.() } catch (_) { /* ignore */ }
      try { this.updateMeshLegend() } catch (_) { /* ignore */ }
      return
    }

    const assignedByKey = this.meshAssignedLabelByNodeKey()
    const want = new Map()

    for (const n of Array.isArray(nodes) ? nodes : []) {
      const pos = n?.position
      const lat = Number(pos?.lat)
      const lon = Number(pos?.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

      const key = this.meshNodeKeyForNode(n)
      if (!key) continue
      if (hiddenKeys.has(key)) continue
      want.set(key, { node: n, lat, lon })
    }

    // Remove markers that no longer exist
    for (const [key, m] of this._meshMarkerByKey.entries()) {
      if (!want.has(key)) {
        try { m.remove() } catch (_) { /* ignore */ }
        this._meshMarkerByKey.delete(key)
        this._meshPopupByKey.delete(key)
      }
    }

    // Add/update
    for (const [key, item] of want.entries()) {
      const n = item.node
      const assigned = assignedByKey.get(key) || ''
      const driver = String(n?.driver || (key.split(':')[0] || '')).trim()
      const shortName = String(n?.shortName || '').trim()
      const longName = String(n?.longName || '').trim()
      const name = driver === 'openmanet' ? (shortName || longName) : (longName || shortName)
      const titleBase = name || key
      const title = assigned ? `${titleBase}\n${assigned}` : titleBase
      const html = this.meshNodePopupHtml(n, assigned, key)

      let marker = this._meshMarkerByKey.get(key) || null
      if (!marker) {
        const el = document.createElement('div')
        el.className = 'xcomMapMarker xcomMapMarker--mesh'
        el.title = title
        el.appendChild(this.createMarkerIconSvg('mesh'))

        marker = new globalThis.maplibregl.Marker({ element: el }).setLngLat([item.lon, item.lat]).addTo(map)
        this._meshMarkerByKey.set(key, marker)
      } else {
        try { marker.setLngLat([item.lon, item.lat]) } catch (_) { /* ignore */ }
        try {
          const el = marker.getElement ? marker.getElement() : null
          if (el) el.title = title
        } catch (_) { /* ignore */ }
      }

      // Popup (best-effort)
      try {
        if (globalThis.maplibregl?.Popup) {
          let popup = this._meshPopupByKey.get(key) || null
          if (!popup) {
            popup = new globalThis.maplibregl.Popup({ closeButton: true, closeOnClick: true })
            this._meshPopupByKey.set(key, popup)
          }
          popup.setHTML(html)
          marker.setPopup(popup)
        }
      } catch (_) {
        // ignore
      }
    }

    try { this.updateMeshLegend() } catch (_) { /* ignore */ }
  }

  clearHiddenImportedMarkers() {
    try {
      for (const m of this._hiddenImportedMarkerById?.values?.() || []) {
        try { m.remove() } catch (_) { /* ignore */ }
      }
    } catch (_) {
      // ignore
    }
    try { this._hiddenImportedMarkerById?.clear?.() } catch (_) { /* ignore */ }
    try { this._hiddenImportedMarkerFeatureById?.clear?.() } catch (_) { /* ignore */ }
  }

  clearHiddenMeshMarkers() {
    try {
      for (const m of this._hiddenMeshMarkerByKey?.values?.() || []) {
        try { m.remove() } catch (_) { /* ignore */ }
      }
    } catch (_) {
      // ignore
    }
    try { this._hiddenMeshMarkerByKey?.clear?.() } catch (_) { /* ignore */ }
    try { this._hiddenMeshPopupByKey?.clear?.() } catch (_) { /* ignore */ }
  }

  syncHiddenOverlay() {
    if (!this.map) return

    if (!this._showHiddenEnabled) {
      try { this.clearHiddenImportedMarkers() } catch (_) { /* ignore */ }
      try { this.clearHiddenMeshMarkers() } catch (_) { /* ignore */ }
      return
    }

    try { this.syncHiddenImportedOverlay() } catch (_) { /* ignore */ }
    try { this.syncHiddenMeshNodesOverlay() } catch (_) { /* ignore */ }
  }

  syncHiddenImportedOverlay() {
    if (!this.map || !globalThis.maplibregl?.Marker) return

    const hiddenIds = new Set()
    try {
      for (const it of this.getHiddenItems()) {
        const kind = String(it?.kind ?? '').trim()
        if (kind !== 'imported') continue
        const id = String(it?.id ?? '').trim()
        if (id) hiddenIds.add(id)
      }
    } catch (_) {
      // ignore
    }

    if (!hiddenIds.size) {
      try { this.clearHiddenImportedMarkers() } catch (_) { /* ignore */ }
      return
    }

    const allFeatures = this.getImportedOverlayFeatures()

    const pointFeatures = allFeatures.filter((f) => {
      try { return f?.geometry?.type === 'Point' } catch (_) { return false }
    })

    try { this.syncHiddenImportedMarkers(pointFeatures, hiddenIds) } catch (_) { /* ignore */ }
  }

  syncHiddenImportedMarkers(pointFeatures, hiddenIds) {
    if (!this.map || !globalThis.maplibregl?.Marker) return
    const map = this.map

    const rosterLabelByUnitId = this.getRosterSafeLabelByUnitId()
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
      if (!hiddenIds.has(id)) continue
      want.set(id, { feature: f, lon, lat, templateId })
    }

    // Remove markers that no longer exist
    for (const [id, m] of this._hiddenImportedMarkerById.entries()) {
      if (!want.has(id)) {
        try { m.remove() } catch (_) { /* ignore */ }
        this._hiddenImportedMarkerById.delete(id)
        this._hiddenImportedMarkerFeatureById.delete(id)
      }
    }

    for (const [id, item] of want.entries()) {
      const { feature: f, lon, lat, templateId } = item
      const ts = this.importedTimestampMs(f?.properties)
      const isStale = (ts > 0 && ts < staleCutoff)
      const nonActiveKey = f?.properties?.nonActiveKey === true
      const iconKind = this.importedMarkerIconKind(templateId)

      let marker = this._hiddenImportedMarkerById.get(id) || null
      if (!marker) {
        const el = document.createElement('div')
        el.dataset.xcomImportedId = id
        el.dataset.xcomImportedIconKind = iconKind
        this.setImportedMarkerClasses(el, templateId, isStale, nonActiveKey)
        try { el.classList.add('xcomMapMarker--hidden') } catch (_) { /* ignore */ }
        el.appendChild(this.createMarkerIconSvg(iconKind))

        // Helpful hover text.
        try {
          const summary = this.withRosterLabels(String(f?.properties?.summary || '').trim())
          el.title = summary || `Imported T=${String(templateId || '')}`
        } catch (_) {
          // ignore
        }

        try { this.syncImportedTeamMarkerBadge(el, f, rosterLabelByUnitId) } catch (_) { /* ignore */ }

        el.addEventListener('click', (e) => {
          try {
            e.preventDefault()
            e.stopPropagation()
          } catch (_) {
            // ignore
          }
          const markerId = el.dataset.xcomImportedId
          if (!markerId) return
          const feat = this._hiddenImportedMarkerFeatureById.get(markerId)
          const mk = this._hiddenImportedMarkerById.get(markerId)
          const ll = mk && typeof mk.getLngLat === 'function' ? mk.getLngLat() : null
          if (feat && ll) this.openImportedPopup(ll, feat, markerId)
        })

        marker = new globalThis.maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([lon, lat])
          .addTo(map)
        this._hiddenImportedMarkerById.set(id, marker)
      } else {
        try { marker.setLngLat([lon, lat]) } catch (_) { /* ignore */ }
        const el = marker.getElement ? marker.getElement() : null
        if (el) {
          this.setImportedMarkerClasses(el, templateId, isStale, nonActiveKey)
          try { el.classList.add('xcomMapMarker--hidden') } catch (_) { /* ignore */ }

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

          try { this.syncImportedTeamMarkerBadge(el, f, rosterLabelByUnitId) } catch (_) { /* ignore */ }
        }
      }

      this._hiddenImportedMarkerFeatureById.set(id, f)
    }
  }

  syncHiddenMeshNodesOverlay() {
    if (!this.map || !globalThis.maplibregl?.Marker) return
    const map = this.map

    const hiddenKeys = new Set()
    try {
      for (const it of this.getHiddenItems()) {
        const kind = String(it?.kind ?? '').trim()
        if (kind !== 'mesh') continue
        const key = String(it?.id ?? '').trim()
        if (key) hiddenKeys.add(key)
      }
    } catch (_) {
      // ignore
    }

    if (!hiddenKeys.size) {
      try { this.clearHiddenMeshMarkers() } catch (_) { /* ignore */ }
      return
    }

    let nodes = []
    try {
      const s = globalThis.xcomMesh?.getState?.()
      nodes = Array.isArray(s?.nodes) ? s.nodes : (globalThis.meshGetNodes ? globalThis.meshGetNodes() : [])
    } catch (_) {
      nodes = []
    }

    try {
      const openmanet = Array.isArray(this._openmanetNodes) ? this._openmanetNodes : []
      if (openmanet.length) nodes = [...(Array.isArray(nodes) ? nodes : []), ...openmanet]
    } catch (_) {
      // ignore
    }

    const assignedByKey = this.meshAssignedLabelByNodeKey()
    const want = new Map()

    for (const n of Array.isArray(nodes) ? nodes : []) {
      const pos = n?.position
      const lat = Number(pos?.lat)
      const lon = Number(pos?.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

      const key = this.meshNodeKeyForNode(n)
      if (!key) continue
      if (!hiddenKeys.has(key)) continue
      want.set(key, { node: n, lat, lon })
    }

    // Remove markers that no longer exist
    for (const [key, m] of this._hiddenMeshMarkerByKey.entries()) {
      if (!want.has(key)) {
        try { m.remove() } catch (_) { /* ignore */ }
        this._hiddenMeshMarkerByKey.delete(key)
        this._hiddenMeshPopupByKey.delete(key)
      }
    }

    // Add/update
    for (const [key, item] of want.entries()) {
      const n = item.node
      const assigned = assignedByKey.get(key) || ''
      const driver = String(n?.driver || (key.split(':')[0] || '')).trim()
      const shortName = String(n?.shortName || '').trim()
      const longName = String(n?.longName || '').trim()
      const name = driver === 'openmanet' ? (shortName || longName) : (longName || shortName)
      const titleBase = name || key
      const title = assigned ? `${titleBase}\n${assigned}` : titleBase
      const html = this.meshNodePopupHtml(n, assigned, key)

      let marker = this._hiddenMeshMarkerByKey.get(key) || null
      if (!marker) {
        const el = document.createElement('div')
        el.className = 'xcomMapMarker xcomMapMarker--mesh xcomMapMarker--hidden'
        el.title = title
        el.appendChild(this.createMarkerIconSvg('mesh'))

        marker = new globalThis.maplibregl.Marker({ element: el }).setLngLat([item.lon, item.lat]).addTo(map)
        this._hiddenMeshMarkerByKey.set(key, marker)
      } else {
        try { marker.setLngLat([item.lon, item.lat]) } catch (_) { /* ignore */ }
        try {
          const el = marker.getElement ? marker.getElement() : null
          if (el) el.title = title
        } catch (_) { /* ignore */ }
      }

      // Popup (best-effort)
      try {
        if (globalThis.maplibregl?.Popup) {
          let popup = this._hiddenMeshPopupByKey.get(key) || null
          if (!popup) {
            popup = new globalThis.maplibregl.Popup({ closeButton: true, closeOnClick: true })
            this._hiddenMeshPopupByKey.set(key, popup)
          }
          popup.setHTML(html)
          marker.setPopup(popup)
        }
      } catch (_) {
        // ignore
      }
    }
  }

  applyOfflineDarkFilter() {
    // Prefer shared helper.
    if (globalThis.applyOfflineRasterDarkFilter) {
      globalThis.applyOfflineRasterDarkFilter(this.mapEl)
      return
    }

    const base = globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'
    const isDarkRaster = base === 'offlineRasterDark' || base === 'topoDark'
    if (!this.mapEl) return
    const canvas = this.mapEl.querySelector('canvas')
    if (!canvas) return
    canvas.style.filter = isDarkRaster ? 'invert(1) hue-rotate(180deg) brightness(0.95) contrast(1.05)' : ''
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
    const base = globalThis.getMapBaseStyle ? globalThis.getMapBaseStyle() : 'light'
    const tpl = (base === 'topo' || base === 'topoDark')
      ? MAP_TOPO_RASTER_TEMPLATE
      : (document.getElementById('mapRasterTemplate')?.value
        || (globalThis.getMapRasterTemplate ? globalThis.getMapRasterTemplate() : ''))

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
    const isRaster = base === 'offlineRaster' || base === 'offlineRasterDark' || base === 'topo' || base === 'topoDark'
    if (!isRaster) {
      const ok = confirm('Base is not set to a raster basemap (Topographic / Offline Raster). Download tiles anyway?')
      if (!ok) return
    }

    const tpl = (base === 'topo' || base === 'topoDark')
      ? MAP_TOPO_RASTER_TEMPLATE
      : (document.getElementById('mapRasterTemplate')?.value
        || (globalThis.getMapRasterTemplate ? globalThis.getMapRasterTemplate() : ''))
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

// Keep the tactical map basemap in sync with the internet reachability probe.
// (XCOM starts conservatively in offline fallback style, then upgrades when the probe succeeds.)
try {
  if (!globalThis.__xcomMapConnectivityHookInstalled && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('xcomConnectivityUpdated', (e) => {
      try {
        if (globalThis.mapModule && typeof globalThis.mapModule.onConnectivityUpdated === 'function') {
          globalThis.mapModule.onConnectivityUpdated(e)
        }
      } catch (_) {
        // ignore
      }
    })
    globalThis.__xcomMapConnectivityHookInstalled = true
  }
} catch (_) {
  // ignore
}
