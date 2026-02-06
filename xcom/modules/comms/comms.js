/**
 * XCOM Comms module
 * - XTOC-compatible packet creation (CLEAR/SECURE)
 * - Chunking + reassembly
 * - QR export + scan
 * - Key bundle import (XTOC-KEY...)
 *
 * Dependencies:
 * - globals: NobleCiphers, QRCodeLib, QrScanner (loaded in index.html)
 * - maplibregl (MapLibre GL) loaded by app-main module dependencies
 */

// Shared helpers (loaded by app-main.js as scripts)
// We rely on them being available as globals in the browser after script load.

// eslint-disable-next-line no-unused-vars
class CommsModule {
  constructor() {
    // Map popup state (only created when user chooses Pick Location / Draw Zone)
    this.map = null
    this.mapContainer = null
    this.mapOverlayEl = null
    this.mapIsOpen = false
    this.pickMode = null // 'loc' | 'zone'
    this.tempZonePoints = []
    this.tempZonePolyline = null
    this._boundMapKeydown = null

    this.qrScanner = null
    this._meshUnsub = null

    // Import preview state
    this._importMap = null
    this._importMapContainer = null
    this._importMapLoaded = false
    this._importGeoSourceId = null
    this._importPointLayerId = null
    this._importLineLayerId = null
    this._importFillLayerId = null
    this._importPendingFeatureCollection = null

    this._importMessages = []
    this._importParseTimer = null
    this._importSelectionTouchedAt = 0
    this._lastDecodedKey = null

    // Mesh auto-receive cursor (traffic log is a ring buffer)
    this._meshTrafficCursorTs = null
    this._meshTrafficCursorCountAtTs = 0
    this._lastMeshRxAt = null
    this._lastMeshRxFrom = null
    this._meshLastState = null

    this.init()
  }

  init() {
    this.createModuleStructure()
    this.bindEvents()
    this.updateKeySummary()
    this.updateTemplateFields()
    window.radioApp.updateStatus('XTOC Comm module loaded')
  }

  createModuleStructure() {
    const root = document.getElementById('comms')
    root.innerHTML = `
      <div class="xModuleIntro">
        <div class="xModuleIntroTitle">What you can do here</div>
        <div class="xModuleIntroText">
          Create XTOC packets (CLEAR or SECURE), split them for different transport limits, and move them via copy/paste, QR, or Meshtastic.
        </div>
      </div>
      <div class="commsShell">
        <div class="commsCard commsCard--create">
          <div class="commsCardTitle">Create Packet (XTOC format)</div>

          <div class="commsRow">
            <label>Template</label>
            <select id="commsTemplate">
              <option value="1">T=1 SITREP</option>
              <option value="2">T=2 CONTACT</option>
              <option value="3">T=3 TASK</option>
              <option value="4" selected>T=4 CHECKIN/LOC</option>
              <option value="5">T=5 RESOURCE</option>
              <option value="6">T=6 ASSET</option>
              <option value="7">T=7 ZONE</option>
            </select>
          </div>

          <div class="commsRow">
            <label>Mode</label>
            <div class="commsMode">
              <label class="commsInline"><input type="radio" name="commsMode" value="C" checked> CLEAR</label>
              <label class="commsInline"><input type="radio" name="commsMode" value="S"> SECURE</label>
            </div>
            <div class="commsSmallMuted">SECURE requires importing an <code>XTOC-KEY</code> bundle.</div>
          </div>

          <div class="commsRow">
            <label>Transport</label>
            <select id="commsTransport">
              <option value="CopyPaste" selected>Copy/Paste</option>
              <option value="JS8Call">JS8Call (50 chars)</option>
              <option value="APRS">APRS (67 chars)</option>
              <option value="HamOther">Ham Other (80 chars)</option>
              <option value="Meshtastic">Meshtastic (180 chars)</option>
              <option value="Winlink">Winlink (400 chars)</option>
              <option value="QR">QR</option>
            </select>
          </div>

          <div class="commsGrid2">
            <div class="commsRow" style="grid-column: 1 / -1">
              <div id="commsKeySummary"></div>
            </div>
          </div>

          <div class="commsDivider"></div>

          <div id="commsTemplateFields"></div>

          <div class="commsButtonRow">
            <button id="commsPickLocBtn" type="button">Pick Location</button>
            <button id="commsPickZoneBtn" type="button">Draw Zone</button>
            <button id="commsGenerateBtn" type="button" class="primary">Generate</button>
          </div>
        </div>

        <div class="commsCard commsCard--output">
          <div class="commsCardTitle">Output</div>
          <div class="commsRow">
            <label>Generated packets (one per line)</label>
            <textarea id="commsOutput" rows="10" placeholder="Generated packets will appear here"></textarea>
          </div>
          <div class="commsButtonRow commsOutputActions">
            <button id="commsCopyBtn" type="button">Copy</button>
            <button id="commsSendMeshBtn" type="button">Send via Mesh</button>
            <button id="commsMakeQrBtn" type="button">Make QR</button>
          </div>

          <div class="commsRow">
            <label>QR</label>
            <div class="commsQrWrap">
              <canvas id="commsQrCanvas" width="256" height="256"></canvas>
            </div>
            <div class="commsSmallMuted">QR uses the first packet line (best for Copy/Paste or QR transport).</div>
          </div>
        </div>

        <div class="commsCard commsCard--import">
          <div class="commsCardTitle">Import / Reassemble</div>

          <div class="commsRow">
            <label for="commsImportText">Input</label>
            <textarea id="commsImportText" rows="10" placeholder="Paste packet(s) here (multi-line supported)"></textarea>
            <div class="commsButtonRow">
              <button id="commsReassembleBtn" type="button">Reassemble</button>
              <button id="commsScanQrBtn" type="button">Scan QR</button>
              <button id="commsClearImportBtn" type="button" class="danger">Clear</button>
            </div>
            <div class="commsGrid2 commsImportToggles">
              <label class="commsInline commsInline--check">
                <input type="checkbox" id="commsAutoMeshRx" checked>
                Auto-receive from mesh
              </label>
              <div class="commsSmallMuted" id="commsMeshRxHint">Mesh: not connected</div>
            </div>
          </div>

          <div class="commsRow">
            <label for="commsImportMsgSelect">Detected messages</label>
            <select id="commsImportMsgSelect" disabled>
              <option value="">(paste a packet to populate)</option>
            </select>
            <div class="commsSmallMuted" id="commsImportMsgHint"></div>
          </div>

          <div class="commsImportPreview">
            <div class="commsImportPreviewText">
              <div class="commsRow">
                <label>Decoded (plain English)</label>
                <div id="commsDecodedHuman" class="commsDecodedHuman">
                  <div class="commsSmallMuted">Paste a packet, scan a QR, or receive one from mesh to see details here.</div>
                </div>
              </div>

              <details class="commsDetails">
                <summary>Raw decoded JSON</summary>
                <pre id="commsDecoded" class="commsPre"></pre>
              </details>
            </div>

            <div class="commsImportPreviewMap">
              <div class="commsRow">
                <label>Map preview</label>
                <div id="commsImportMap" class="commsImportMap"></div>
                <div class="commsSmallMuted" id="commsImportMapHint">Shows the location/zone when the packet includes it.</div>
              </div>
            </div>
          </div>
        </div>

        <div class="commsCard commsCard--keys">
          <div class="commsCardTitle">Key Bundle Import</div>
          <textarea id="commsKeyBundle" rows="3" placeholder="Paste XTOC-KEY... bundle here"></textarea>
          <div class="commsButtonRow">
            <button id="commsImportKeyBtn" type="button">Import Key</button>
            <button id="commsScanKeyQrBtn" type="button">Scan Key QR</button>
            <button id="commsDeleteKeyBtn" type="button" class="danger">Delete Key</button>
            <button id="commsClearKeyBtn" type="button" class="danger">Clear Key Input</button>
          </div>
          <div class="commsSmallMuted">Keys are stored locally only (localStorage).</div>
        </div>

        <div class="commsCard commsCard--mapInfo">
          <div class="commsCardTitle">Map</div>
          <div class="commsSmallMuted">Map opens as a popup when you use “Pick Location” or “Draw Zone”.</div>
        </div>
      </div>
    `
  }

  bindEvents() {
    const templateSel = document.getElementById('commsTemplate')
    const transportSel = document.getElementById('commsTransport')

    templateSel.addEventListener('change', () => {
      this.updateTemplateFields()
      this.updateZoneUiState()
    })
    if (transportSel) transportSel.addEventListener('change', () => this.updateMeshSendButtonState())

    // No Team ID / KID inputs in XCOM Comms (keys are purely “active key” based).

    document.getElementById('commsGenerateBtn').addEventListener('click', () => this.generate())
    document.getElementById('commsCopyBtn').addEventListener('click', () => this.copyOutput())
    document.getElementById('commsSendMeshBtn').addEventListener('click', () => this.sendViaMesh())
    document.getElementById('commsMakeQrBtn').addEventListener('click', () => this.makeQr())

    document.getElementById('commsReassembleBtn').addEventListener('click', () => this.reassembleAndDecode())
    document.getElementById('commsClearImportBtn').addEventListener('click', () => this.clearImport())

    const importText = document.getElementById('commsImportText')
    if (importText) importText.addEventListener('input', () => this.scheduleImportRefresh())

    const msgSel = document.getElementById('commsImportMsgSelect')
    if (msgSel) {
      msgSel.addEventListener('change', () => {
        this._importSelectionTouchedAt = Date.now()
        this.reassembleAndDecode({ fromSelect: true })
      })
    }

    const autoMeshRx = document.getElementById('commsAutoMeshRx')
    if (autoMeshRx) {
      try {
        const raw = localStorage.getItem('xcom.comms.autoMeshRx.v1')
        if (raw === '0') autoMeshRx.checked = false
      } catch (_) {
        // ignore
      }
      autoMeshRx.addEventListener('change', () => {
        try { localStorage.setItem('xcom.comms.autoMeshRx.v1', autoMeshRx.checked ? '1' : '0') } catch (_) { /* ignore */ }
        try { this.updateMeshRxHint() } catch (_) { /* ignore */ }
      })
    }

    document.getElementById('commsImportKeyBtn').addEventListener('click', () => this.importKey())
    document.getElementById('commsScanKeyQrBtn').addEventListener('click', () => this.scanKeyQr())
    document.getElementById('commsDeleteKeyBtn').addEventListener('click', () => this.deleteKey())
    document.getElementById('commsClearKeyBtn').addEventListener('click', () => (document.getElementById('commsKeyBundle').value = ''))

    document.getElementById('commsPickLocBtn').addEventListener('click', () => {
      this.openMapPicker('loc')
    })
    document.getElementById('commsPickZoneBtn').addEventListener('click', () => {
      this.openMapPicker('zone')

    })

    document.getElementById('commsScanQrBtn').addEventListener('click', () => this.scanQr())

    // initial state for zone-only controls
    this.updateZoneUiState()

    // Sync the mesh send button with transport + mesh connection status.
    this.updateMeshSendButtonState()
    try {
      // Avoid accumulating subscriptions across module reloads.
      if (globalThis.__xcomCommsCleanup) {
        try { globalThis.__xcomCommsCleanup() } catch (_) { /* ignore */ }
        globalThis.__xcomCommsCleanup = null
      } else if (globalThis.__xcomCommsMeshUnsub) {
        try { globalThis.__xcomCommsMeshUnsub() } catch (_) { /* ignore */ }
        globalThis.__xcomCommsMeshUnsub = null
      }

      globalThis.__xcomCommsCleanup = () => {
        try { if (this._meshUnsub) this._meshUnsub() } catch (_) { /* ignore */ }
        this._meshUnsub = null
        try { if (this._importMap) this._importMap.remove() } catch (_) { /* ignore */ }
        this._importMap = null
      }
      if (globalThis.xcomMesh && typeof globalThis.xcomMesh.subscribe === 'function') {
        this._meshUnsub = globalThis.xcomMesh.subscribe((state) => {
          try { this.updateMeshSendButtonState() } catch (_) { /* ignore */ }
          try { this.onMeshState(state) } catch (_) { /* ignore */ }
        })
        globalThis.__xcomCommsMeshUnsub = this._meshUnsub
      }
    } catch (_) {
      // ignore
    }

    // Initial import UI state
    try { this.refreshImportMessageList({ keepSelection: false, preferLatestComplete: true }) } catch (_) { /* ignore */ }
    try { this.updateMeshRxHint() } catch (_) { /* ignore */ }
    try { this.ensureImportMapInitialized() } catch (_) { /* ignore */ }
  }

  updateZoneUiState() {
    const templateId = Number(document.getElementById('commsTemplate')?.value)
    const isZone = templateId === 7

    const zoneBtn = document.getElementById('commsPickZoneBtn')
    const zonePts = document.getElementById('t_zone_points')

    // In XTOC, "Generate Shape" (zone drawing) is only active when sending a ZONE.
    // For XCOM, the equivalent is "Draw Zone" + the polygon textarea.
    if (zoneBtn) zoneBtn.disabled = !isZone
    if (zonePts) zonePts.disabled = !isZone
  }

  openMapPicker(kind) {
    if (kind !== 'loc' && kind !== 'zone') return
    this.pickMode = kind

    // reset zone drawing state each time we open
    this.tempZonePoints = []
    this.tempZonePolyline = null
    // If the map already exists, clear any rendered zone overlay.
    try {
      this.updateZoneOverlay()
    } catch (_) {
      // ignore
    }

    this.showMapOverlay()
    this.ensureMapInitialized()
    this.setMapOverlayHint(
      kind === 'loc'
        ? 'Click the map to set LAT/LON'
        : 'Click map to add polygon points. Double-click to finish (min 3).'
    )
    this.setMapOverlayCursor(true)

    // Ensure proper render after the overlay is in the DOM and has layout.
    setTimeout(() => {
      try {
        if (this.map) this.map.resize()
      } catch (_) {
        // ignore
      }
    }, 50)
  }

  showMapOverlay() {
    if (this.mapIsOpen && this.mapOverlayEl) return

    const overlay = document.createElement('div')
    overlay.className = 'commsMapOverlay'
    overlay.innerHTML = `
      <div class="commsMapModal" role="dialog" aria-modal="true" aria-label="Map picker">
        <div class="commsMapModalTop">
          <div class="commsMapModalTitle">Map</div>
          <button type="button" class="danger" id="commsMapCancelBtn">Cancel</button>
        </div>
        <div id="commsMapPopup" class="commsMapPopup"></div>
        <div class="commsSmallMuted" id="commsMapPopupHint"></div>
      </div>
    `

    document.body.appendChild(overlay)
    this.mapOverlayEl = overlay
    this.mapIsOpen = true

    // close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.cancelMapPicker()
    })

    const cancelBtn = overlay.querySelector('#commsMapCancelBtn')
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.cancelMapPicker())

    this._boundMapKeydown = (e) => {
      if (e.key === 'Escape') this.cancelMapPicker()
    }
    document.addEventListener('keydown', this._boundMapKeydown)
  }

  ensureMapInitialized() {
    // Create a MapLibre map once, and keep it alive between popup opens.
    if (this.map) return

    this.mapContainer = document.getElementById('commsMapPopup')
    if (!this.mapContainer) throw new Error('Map container not found')

    if (!globalThis.maplibregl) throw new Error('MapLibre not loaded')

    // Use shared saved view so Comms picks match the Map module AO.
    const c = globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 35.9606, lon: -83.9207 }
    const z = globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 6

    if (globalThis.createMapLibreMap) {
      this.map = globalThis.createMapLibreMap({
        container: this.mapContainer,
        centerLon: c.lon,
        centerLat: c.lat,
        zoom: z,
      })
    } else {
      this.map = new globalThis.maplibregl.Map({
        container: this.mapContainer,
        style: globalThis.buildMapLibreStyle ? globalThis.buildMapLibreStyle() : 'https://tiles.openfreemap.org/styles/liberty',
        center: [c.lon, c.lat],
        zoom: z,
        attributionControl: true,
      })
      this.map.addControl(new globalThis.maplibregl.NavigationControl(), 'top-right')
    }

    // Zone drawing layers
    this._zoneSourceId = `comms-zone-src-${Date.now()}`
    this._zoneLineLayerId = `comms-zone-line-${Date.now()}`
    this._zoneFillLayerId = `comms-zone-fill-${Date.now()}`

    const ensureZoneLayers = () => {
      if (!this.map) return
      if (this.map.getSource(this._zoneSourceId)) return

      this.map.addSource(this._zoneSourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      // Line
      this.map.addLayer({
        id: this._zoneLineLayerId,
        type: 'line',
        source: this._zoneSourceId,
        paint: {
          'line-color': '#66c2ff',
          'line-width': 3,
        },
      })

      // Fill (subtle)
      this.map.addLayer({
        id: this._zoneFillLayerId,
        type: 'fill',
        source: this._zoneSourceId,
        paint: {
          'fill-color': '#66c2ff',
          'fill-opacity': 0.15,
        },
      })
    }

    this.map.on('load', () => {
      ensureZoneLayers()
    })

    // Click-to-pick and click-to-add zone vertices
    this.map.on('click', (e) => {
      if (!this.pickMode) return
      const { lat, lng } = e.lngLat
      if (this.pickMode === 'loc') {
        const latEl = document.getElementById('t_lat')
        const lonEl = document.getElementById('t_lon')
        if (latEl) latEl.value = lat.toFixed(5)
        if (lonEl) lonEl.value = lng.toFixed(5)
        this.setMapOverlayHint('Location set.')
        this.finishMapPicker()
      } else if (this.pickMode === 'zone') {
        this.tempZonePoints.push([lat, lng])
        this.updateZoneOverlay()
      }
    })

    // Double-click finishes zone (MapLibre default is zoom; we disable it).
    this.map.doubleClickZoom.disable()
    this.map.on('dblclick', () => {
      if (this.pickMode !== 'zone') return
      if (this.tempZonePoints.length < 3) {
        alert('Zone needs at least 3 points')
        return
      }
      const pts = this.tempZonePoints.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join('\\n')
      const el = document.getElementById('t_zone_points')
      if (el) el.value = pts
      this.setMapOverlayHint('Zone points set.')
      this.finishMapPicker()
    })
  }

  updateZoneOverlay() {
    if (!this.map || !this._zoneSourceId) return
    const src = this.map.getSource(this._zoneSourceId)
    if (!src) return

    const coords = this.tempZonePoints.map(([lat, lon]) => [lon, lat])

    // If 3+ points, close polygon ring for fill.
    const features = []
    if (coords.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {},
      })
    }
    if (coords.length >= 3) {
      const ring = coords.concat([coords[0]])
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {},
      })
    }

    src.setData({ type: 'FeatureCollection', features })
  }

  finishMapPicker() {
    this.pickMode = null
    this.setMapOverlayCursor(false)
    this.hideMapOverlay()
  }

  cancelMapPicker() {
    this.pickMode = null
    this.setMapOverlayCursor(false)
    this.hideMapOverlay()
  }

  hideMapOverlay() {
    if (!this.mapOverlayEl) return
    if (this._boundMapKeydown) {
      document.removeEventListener('keydown', this._boundMapKeydown)
      this._boundMapKeydown = null
    }

    // If we remove the overlay from the DOM, destroy the MapLibre map as well.
    try {
      if (this.map) this.map.remove()
    } catch (_) {
      // ignore
    }
    this.map = null
    this.mapContainer = null
    this.tempZonePolyline = null
    this._zoneSourceId = null
    this._zoneLineLayerId = null
    this._zoneFillLayerId = null

    try {
      this.mapOverlayEl.remove()
    } catch (_) {
      if (this.mapOverlayEl.parentNode) this.mapOverlayEl.parentNode.removeChild(this.mapOverlayEl)
    }
    this.mapOverlayEl = null
    this.mapIsOpen = false
  }

  setMapOverlayHint(text) {
    const el = document.getElementById('commsMapPopupHint')
    if (el) el.textContent = text
  }

  setMapOverlayCursor(active) {
    const el = document.getElementById('commsMapPopup')
    if (!el) return
    el.classList.toggle('map-pick-mode', !!active)
  }

  updateKeySummary() {
    const activeKey = window.getCommsActiveKey ? window.getCommsActiveKey() : null
    const el = document.getElementById('commsKeySummary')
    if (!el) return

    if (!activeKey) {
      el.innerHTML = `
        <div class="commsWarn">
          No <strong>ACTIVE</strong> key loaded for Comms SECURE.
          Import an XTOC-KEY bundle to use SECURE.
        </div>
      `
      return
    }

    const activeLabel = activeKey.teamId ? `${activeKey.teamId} KID ${activeKey.kid}` : `KID ${activeKey.kid}`
    el.innerHTML = `
      <div class="commsOk">
        ACTIVE key loaded for SECURE: <strong>${activeLabel}</strong>.
      </div>
    `
  }

  updateTemplateFields() {
    const t = Number(document.getElementById('commsTemplate').value)
    const wrap = document.getElementById('commsTemplateFields')
    const now = Date.now()

    const commonSrcDstPri = (withDst = true) => `
      <div class="commsGrid2">
        <div class="commsRow"><label>Src (unit #)</label><input id="t_src" type="number" min="0" step="1" value="1" /></div>
        ${withDst ? '<div class="commsRow"><label>Dst (unit #)</label><input id="t_dst" type="number" min="0" step="1" value="0" /></div>' : '<div></div>'}
      </div>
      <div class="commsGrid2">
        <div class="commsRow"><label>Pri</label><input id="t_pri" type="number" min="0" max="9" step="1" value="1" /></div>
        <div class="commsRow"><label>Time (ms)</label><input id="t_time" type="number" value="${now}" /></div>
      </div>
      <div class="commsGrid2">
        <div class="commsRow"><label>Lat</label><input id="t_lat" type="number" step="0.00001" placeholder="" /></div>
        <div class="commsRow"><label>Lon</label><input id="t_lon" type="number" step="0.00001" placeholder="" /></div>
      </div>
      <div class="commsRow"><label>Note</label><input id="t_note" type="text" placeholder="(optional)" /></div>
    `

    if (t === 4) {
      wrap.innerHTML = `
        <div class="commsGrid2">
          <div class="commsRow"><label>Unit ID</label><input id="t_unit" type="number" min="0" step="1" value="1" /></div>
          <div class="commsRow"><label>Status</label><input id="t_status" type="number" min="0" max="255" step="1" value="0" /></div>
        </div>
        <div class="commsGrid2">
          <div class="commsRow"><label>Lat</label><input id="t_lat" type="number" step="0.00001" /></div>
          <div class="commsRow"><label>Lon</label><input id="t_lon" type="number" step="0.00001" /></div>
        </div>
        <div class="commsRow"><label>Time (ms)</label><input id="t_time" type="number" value="${now}" /></div>
      `
      return
    }

    if (t === 7) {
      wrap.innerHTML = `
        <div class="commsGrid2">
          <div class="commsRow"><label>Src (unit #)</label><input id="t_src" type="number" min="0" step="1" value="1" /></div>
          <div class="commsRow"><label>Time (ms)</label><input id="t_time" type="number" value="${now}" /></div>
        </div>
        <div class="commsGrid2">
          <div class="commsRow"><label>Threat</label><input id="t_threat" type="number" min="0" max="255" step="1" value="0" /></div>
          <div class="commsRow"><label>Meaning Code</label><input id="t_meaning" type="number" min="0" max="255" step="1" value="0" /></div>
        </div>
        <div class="commsRow"><label>Label</label><input id="t_label" type="text" placeholder="(optional)" /></div>
        <div class="commsRow"><label>Note</label><input id="t_note" type="text" placeholder="(optional)" /></div>
        <div class="commsRow">
          <label>Polygon points (lat,lon per line)</label>
          <textarea id="t_zone_points" rows="4" placeholder="43.70000,-79.40000\n43.71000,-79.39000\n..."></textarea>
        </div>
      `
      return
    }

    if (t === 6) {
      wrap.innerHTML = `
        <div class="commsGrid2">
          <div class="commsRow"><label>Src (unit #)</label><input id="t_src" type="number" min="0" step="1" value="1" /></div>
          <div class="commsRow"><label>Type Code</label><input id="t_type" type="number" min="0" max="255" step="1" value="0" /></div>
        </div>
        <div class="commsGrid2">
          <div class="commsRow"><label>Condition</label><input id="t_condition" type="number" min="0" max="255" step="1" value="0" /></div>
          <div class="commsRow"><label>Time (ms)</label><input id="t_time" type="number" value="${now}" /></div>
        </div>
        <div class="commsGrid2">
          <div class="commsRow"><label>Lat</label><input id="t_lat" type="number" step="0.00001" /></div>
          <div class="commsRow"><label>Lon</label><input id="t_lon" type="number" step="0.00001" /></div>
        </div>
        <div class="commsRow"><label>Label</label><input id="t_label" type="text" placeholder="(optional)" /></div>
        <div class="commsRow"><label>Note</label><input id="t_note" type="text" placeholder="(optional)" /></div>
      `
      return
    }

    if (t === 5) {
      wrap.innerHTML = `
        ${commonSrcDstPri(false)}
        <div class="commsGrid2">
          <div class="commsRow"><label>Item Code</label><input id="t_item" type="number" min="0" max="255" step="1" value="0" /></div>
          <div class="commsRow"><label>Qty</label><input id="t_qty" type="number" min="0" max="65535" step="1" value="1" /></div>
        </div>
      `
      return
    }

    if (t === 3) {
      wrap.innerHTML = `
        ${commonSrcDstPri(true)}
        <div class="commsGrid2">
          <div class="commsRow"><label>Action Code</label><input id="t_action" type="number" min="0" max="255" step="1" value="0" /></div>
          <div class="commsRow"><label>Due (mins)</label><input id="t_due" type="number" min="0" max="65535" step="1" value="60" /></div>
        </div>
      `
      return
    }

    if (t === 2) {
      wrap.innerHTML = `
        ${commonSrcDstPri(false)}
        <div class="commsGrid2">
          <div class="commsRow"><label>Type Code</label><input id="t_type" type="number" min="0" max="255" step="1" value="0" /></div>
          <div class="commsRow"><label>Count</label><input id="t_count" type="number" min="0" max="65535" step="1" value="1" /></div>
        </div>
        <div class="commsRow"><label>Direction</label><input id="t_dir" type="number" min="0" max="255" step="1" value="0" /></div>
      `
      return
    }

    // default t=1
    wrap.innerHTML = `
      ${commonSrcDstPri(true)}
      <div class="commsRow"><label>Status</label><input id="t_status" type="number" min="0" max="255" step="1" value="0" /></div>
    `
  }

  getMode() {
    const sel = document.querySelector('input[name="commsMode"]:checked')
    return sel ? sel.value : 'C'
  }

  getTransportMax() {
    const profile = document.getElementById('commsTransport').value
    return window.getTransportMaxPacketChars ? window.getTransportMaxPacketChars(profile) : 800
  }

  updateMeshSendButtonState() {
    const btn = document.getElementById('commsSendMeshBtn')
    if (!btn) return

    const transport = String(document.getElementById('commsTransport')?.value || '').trim()
    const shouldShow = transport === 'Meshtastic'
    btn.style.display = shouldShow ? '' : 'none'
    if (!shouldShow) return

    const hasApi =
      globalThis.xcomMesh &&
      typeof globalThis.xcomMesh.getState === 'function' &&
      typeof globalThis.meshConnect === 'function' &&
      typeof globalThis.meshSendText === 'function'

    if (!hasApi) {
      btn.disabled = true
      btn.textContent = 'Mesh Unavailable'
      btn.title = 'Mesh transport not loaded. Reload or open the Mesh module once.'
      return
    }

    btn.disabled = false
    let ready = false
    try {
      const s = globalThis.xcomMesh.getState().status
      ready = !!s?.connected || !!s?.linkConnected
    } catch (_) {
      ready = false
    }

    btn.textContent = ready ? 'Send via Mesh' : 'Connect + Send'
    btn.title = ready ? 'Send packet line(s) directly over Meshtastic' : 'Connect, then send over Meshtastic'
  }

  importKey() {
    const text = document.getElementById('commsKeyBundle').value
    if (!window.importKeyBundle) {
      alert('Key import helpers not loaded')
      return
    }
    const res = window.importKeyBundle(text, { setActive: true })
    if (!res.ok) {
      alert(res.reason || 'Import failed')
      return
    }
    // Clear input after successful import (avoids looking like it never saved).
    document.getElementById('commsKeyBundle').value = ''
    this.updateKeySummary()
    alert(`Imported key. ACTIVE for SECURE: team ${res.teamId} KID ${res.kid}`)
  }

  deleteKey() {
    const activeKey = window.getCommsActiveKey ? window.getCommsActiveKey() : null
    if (!activeKey) {
      alert('No ACTIVE key to delete.')
      return
    }

    const label = activeKey.teamId ? `${activeKey.teamId} KID ${activeKey.kid}` : `KID ${activeKey.kid}`
    const ok = confirm(`Delete ACTIVE key from this device?\n\n${label}\n\nThis cannot be undone.`)
    if (!ok) return

    try {
      // Remove from the stored team-key map as well (wipe from device).
      if (activeKey.teamId && typeof window.deleteTeamKey === 'function') {
        try {
          window.deleteTeamKey(activeKey.teamId, activeKey.kid)
        } catch (_) {
          // ignore
        }
      }

      if (typeof window.clearCommsActiveKey === 'function') window.clearCommsActiveKey()
      this.updateKeySummary()
      alert('Key deleted.')
    } catch (e) {
      alert(e.message || String(e))
    }
  }

  async scanKeyQr() {
    if (!globalThis.QrScanner) {
      alert('QrScanner not loaded')
      return
    }

    const overlay = document.createElement('div')
    overlay.className = 'commsQrOverlay'
    overlay.innerHTML = `
      <div class="commsQrModal">
        <div class="commsQrModalTitle">Scan Key QR</div>
        <video id="commsKeyQrVideo"></video>
        <div class="commsButtonRow">
          <button id="commsKeyQrStopBtn" type="button" class="danger">Stop</button>
        </div>
        <div class="commsSmallMuted" style="margin-top:8px">Point the camera at an <code>XTOC-KEY</code> QR.</div>
      </div>
    `
    document.body.appendChild(overlay)
    const video = overlay.querySelector('#commsKeyQrVideo')
    const stopBtn = overlay.querySelector('#commsKeyQrStopBtn')

    let scanner
    const stop = () => {
      try {
        if (scanner) scanner.stop()
      } catch (_) {
        // ignore
      }
      scanner = null
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    }

    try {
      globalThis.QrScanner.WORKER_PATH = 'assets/vendor/qr-scanner-worker.min.js'
      scanner = new globalThis.QrScanner(
        video,
        (result) => {
          const text = (result && result.data) ? result.data : String(result)
          const trimmed = String(text || '').trim()

          if (trimmed.startsWith('XTOC-KEY.')) {
            document.getElementById('commsKeyBundle').value = trimmed
            try {
              this.importKey()
            } finally {
              stop()
            }
            return
          }

          // If they scanned a packet instead, be helpful.
          if (trimmed.startsWith('X1.')) {
            document.getElementById('commsImportText').value = trimmed
            this.reassembleAndDecode()
            stop()
            return
          }

          alert('QR did not look like an XTOC-KEY bundle.')
          stop()
        },
        { returnDetailedScanResult: true },
      )
      await scanner.start()
      stopBtn.addEventListener('click', stop)
    } catch (e) {
      console.error(e)
      stop()
      alert(`QR scan failed: ${e.message || e}`)
    }
  }

  // -----------------------------
  // XTOC-style SECURE packet generation
  // -----------------------------

  generateSecurePacket(templateId, payloadObj, activeKey) {
    if (!activeKey) throw new Error('Missing active key')
    if (!globalThis.wrapSecure) throw new Error('wrapSecure helper not loaded')
    if (!globalThis.makeSecureAad) throw new Error('makeSecureAad helper not loaded')
    if (!globalThis.encodeSecurePayloadV2Compact) throw new Error('encodeSecurePayloadV2Compact helper not loaded')

    // Prefer XTOC canonical behavior: encrypt underlying template bytes.
    if (typeof globalThis.getTemplatePlainBytes === 'function') {
      const kid = Number(activeKey.kid)
      const plain = globalThis.getTemplatePlainBytes(templateId, payloadObj)
      const id = globalThis.generatePacketId ? globalThis.generatePacketId(8) : String(Date.now())
      const aad = globalThis.makeSecureAad('X1', templateId, 'S', id, 1, 1, kid)
      const enc = globalThis.encodeSecurePayloadV2Compact(plain, activeKey.keyB64Url, aad)
      return globalThis.wrapSecure(templateId, id, 1, 1, kid, enc)
    }

    // Fallback (legacy XCOM behavior): encrypt the CLEAR payload *string*.
    const clearPacket = this.buildClearPacket(templateId, payloadObj)
    const parsed = globalThis.parsePacket(clearPacket)
    const kid = Number(activeKey.kid)
    const aad = globalThis.makeSecureAad('X1', parsed.templateId, 'S', parsed.id, 1, 1, kid)
    const plain = new TextEncoder().encode(parsed.payload)
    const enc = globalThis.encodeSecurePayloadV2Compact(plain, activeKey.keyB64Url, aad)
    return globalThis.wrapSecure(parsed.templateId, parsed.id, 1, 1, kid, enc)
  }

  // Helper used by secure fallback path.
  buildClearPacket(templateId, payloadObj) {
    if (templateId === 4) return globalThis.makeCheckinLocClearPacket(payloadObj)
    if (templateId === 7) return `X1.7.C.${globalThis.generatePacketId(8)}.1/1.${globalThis.encodeZoneClear(payloadObj)}`
    if (templateId === 6) return `X1.6.C.${globalThis.generatePacketId(8)}.1/1.${globalThis.encodeAssetClear(payloadObj)}`
    if (templateId === 5) return `X1.5.C.${globalThis.generatePacketId(8)}.1/1.${globalThis.encodeResourceClear(payloadObj)}`
    if (templateId === 3) return `X1.3.C.${globalThis.generatePacketId(8)}.1/1.${globalThis.encodeTaskClear(payloadObj)}`
    if (templateId === 2) return `X1.2.C.${globalThis.generatePacketId(8)}.1/1.${globalThis.encodeContactClear(payloadObj)}`
    return `X1.1.C.${globalThis.generatePacketId(8)}.1/1.${globalThis.encodeSitrepClear(payloadObj)}`
  }

  generate() {
    const templateId = Number(document.getElementById('commsTemplate').value)
    const mode = this.getMode()
    const maxChars = this.getTransportMax()

    try {
      let clearPacket
      let payloadObj
      if (templateId === 4) {
        const p = {
          unitId: Number(document.getElementById('t_unit').value || 0),
          lat: Number(document.getElementById('t_lat').value),
          lon: Number(document.getElementById('t_lon').value),
          t: Number(document.getElementById('t_time').value || Date.now()),
          status: Number(document.getElementById('t_status').value || 0),
        }
        payloadObj = p
        clearPacket = window.makeCheckinLocClearPacket(p)
      } else if (templateId === 7) {
        const points = String(document.getElementById('t_zone_points').value || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((line) => {
            const [a, b] = line.split(',').map((x) => x.trim())
            return { lat: Number(a), lon: Number(b) }
          })
          .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        const payload = {
          src: Number(document.getElementById('t_src').value || 1),
          t: Number(document.getElementById('t_time').value || Date.now()),
          threat: Number(document.getElementById('t_threat').value || 0),
          meaningCode: Number(document.getElementById('t_meaning').value || 0),
          label: document.getElementById('t_label').value || '',
          note: document.getElementById('t_note').value || '',
          shape: { kind: 'poly', points },
        }
        payloadObj = payload
        clearPacket = `X1.7.C.${window.generatePacketId(8)}.1/1.${window.encodeZoneClear(payload)}`
      } else if (templateId === 6) {
        const payload = {
          src: Number(document.getElementById('t_src').value || 1),
          condition: Number(document.getElementById('t_condition').value || 0),
          t: Number(document.getElementById('t_time').value || Date.now()),
          typeCode: Number(document.getElementById('t_type').value || 0),
          lat: Number(document.getElementById('t_lat').value),
          lon: Number(document.getElementById('t_lon').value),
          label: document.getElementById('t_label').value || '',
          note: document.getElementById('t_note').value || '',
        }
        payloadObj = payload
        clearPacket = `X1.6.C.${window.generatePacketId(8)}.1/1.${window.encodeAssetClear(payload)}`
      } else if (templateId === 5) {
        const payload = {
          src: Number(document.getElementById('t_src').value || 1),
          pri: Number(document.getElementById('t_pri').value || 1),
          t: Number(document.getElementById('t_time').value || Date.now()),
          itemCode: Number(document.getElementById('t_item').value || 0),
          qty: Number(document.getElementById('t_qty').value || 1),
          lat: Number(document.getElementById('t_lat').value),
          lon: Number(document.getElementById('t_lon').value),
          note: document.getElementById('t_note').value || '',
        }
        payloadObj = payload
        clearPacket = `X1.5.C.${window.generatePacketId(8)}.1/1.${window.encodeResourceClear(payload)}`
      } else if (templateId === 3) {
        const payload = {
          src: Number(document.getElementById('t_src').value || 1),
          dst: Number(document.getElementById('t_dst').value || 0),
          pri: Number(document.getElementById('t_pri').value || 1),
          t: Number(document.getElementById('t_time').value || Date.now()),
          actionCode: Number(document.getElementById('t_action').value || 0),
          dueMins: Number(document.getElementById('t_due').value || 60),
          lat: Number(document.getElementById('t_lat').value),
          lon: Number(document.getElementById('t_lon').value),
          note: document.getElementById('t_note').value || '',
        }
        payloadObj = payload
        clearPacket = `X1.3.C.${window.generatePacketId(8)}.1/1.${window.encodeTaskClear(payload)}`
      } else if (templateId === 2) {
        const payload = {
          src: Number(document.getElementById('t_src').value || 1),
          pri: Number(document.getElementById('t_pri').value || 1),
          t: Number(document.getElementById('t_time').value || Date.now()),
          typeCode: Number(document.getElementById('t_type').value || 0),
          count: Number(document.getElementById('t_count').value || 1),
          dir: Number(document.getElementById('t_dir').value || 0),
          lat: Number(document.getElementById('t_lat').value),
          lon: Number(document.getElementById('t_lon').value),
          note: document.getElementById('t_note').value || '',
        }
        payloadObj = payload
        clearPacket = `X1.2.C.${window.generatePacketId(8)}.1/1.${window.encodeContactClear(payload)}`
      } else {
        const payload = {
          src: Number(document.getElementById('t_src').value || 1),
          dst: Number(document.getElementById('t_dst').value || 0),
          pri: Number(document.getElementById('t_pri').value || 1),
          status: Number(document.getElementById('t_status').value || 0),
          t: Number(document.getElementById('t_time').value || Date.now()),
          lat: Number(document.getElementById('t_lat').value),
          lon: Number(document.getElementById('t_lon').value),
          note: document.getElementById('t_note').value || '',
        }
        payloadObj = payload
        clearPacket = `X1.1.C.${window.generatePacketId(8)}.1/1.${window.encodeSitrepClear(payload)}`
      }

      let finalPacket = clearPacket
      if (mode === 'S') {
        const activeKey = window.getCommsActiveKey ? window.getCommsActiveKey() : null
        if (!activeKey) throw new Error('No ACTIVE key loaded for SECURE. Import an XTOC-KEY bundle.')

        finalPacket = this.generateSecurePacket(templateId, payloadObj, activeKey)
      }

      const parsedFinal = window.parsePacket(finalPacket)
      const chunkFn = globalThis.chunkPacketByMaxChars
      if (typeof chunkFn !== 'function') {
        throw new Error('Chunking helpers not loaded (chunkPacketByMaxChars). Check modules/shared/xtoc/chunking.js')
      }
      const lines = chunkFn(parsedFinal, maxChars)
      document.getElementById('commsOutput').value = lines.join('\n')
      window.radioApp.updateStatus(`Generated ${lines.length} packet(s)`)
      this.makeQr()
      this.scrollOutputIntoView()
    } catch (e) {
      console.error(e)
      alert(e.message || String(e))
    }
  }

  scrollOutputIntoView() {
    try {
      const isMobile = window.matchMedia && window.matchMedia('(max-width: 900px)').matches
      if (!isMobile) return
      const out = document.getElementById('commsOutput')
      const card = out?.closest?.('.commsCard')
      if (card && typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    } catch (_) {
      // ignore
    }
  }

  async copyOutput() {
    const text = document.getElementById('commsOutput').value || ''
    try {
      await navigator.clipboard.writeText(text)
      window.radioApp.updateStatus('Copied to clipboard')
    } catch {
      alert('Clipboard copy failed (browser permissions).')
    }
  }

  async makeQr() {
    const out = (document.getElementById('commsOutput').value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    const first = out[0] || ''
    const canvas = document.getElementById('commsQrCanvas')
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!first) return
    if (!globalThis.QRCodeLib || !globalThis.QRCodeLib.QRCode) {
      alert('QRCodeLib not loaded')
      return
    }
    await globalThis.QRCodeLib.QRCode.toCanvas(canvas, first, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 6,
      color: { dark: '#e9eef8', light: '#0b0f16' },
    })
  }

  async sendViaMesh() {
    const formatMeshError = (e) => {
      if (e == null) return 'Unknown error'
      if (typeof e === 'string') return e
      if (typeof e === 'number' || typeof e === 'boolean' || typeof e === 'bigint') return String(e)
      if (e instanceof Error) return e.message ? `${e.name}: ${e.message}` : e.name
      if (typeof e === 'object') {
        const any = e

        // Common Meshtastic error shape: { id, error } where error is a Routing_Error enum value.
        try {
          const code = any?.error
          const n = Number(code)
          const Enum =
            globalThis?.Meshtastic?.Protobuf?.Routing_Error ||
            globalThis?.Meshtastic?.Protobuf?.Mesh?.Routing_Error ||
            globalThis?.Meshtastic?.Protobufs?.Routing_Error ||
            globalThis?.Meshtastic?.Protobufs?.Mesh?.Routing_Error
          const label = Number.isFinite(n) && Enum ? Enum[n] : null
          if (typeof label === 'string' && label) {
            const id = any?.id ?? any?.requestId ?? null
            return `Routing error: ${label} (${String(code)})${id != null ? ` id=${String(id)}` : ''}`
          }
        } catch (_) {
          // ignore
        }

        try {
          const json = JSON.stringify(any)
          return json && json !== '{}' ? json : Object.prototype.toString.call(e)
        } catch (_) {
          return Object.prototype.toString.call(e)
        }
      }
      return String(e)
    }

    const transport = String(document.getElementById('commsTransport')?.value || '').trim()
    if (transport !== 'Meshtastic') {
      alert('Set Transport to Meshtastic first.')
      return
    }

    const text = String(document.getElementById('commsOutput').value || '').trim()
    if (!text) {
      alert('Nothing to send. Generate a packet first.')
      return
    }

    const mesh = globalThis.xcomMesh
    const canConnect = typeof globalThis.meshConnect === 'function'
    const canSend = typeof globalThis.meshSendText === 'function'
    if (!mesh || typeof mesh.getState !== 'function' || !canConnect || !canSend) {
      alert('Mesh transport not available. Reload or open the Mesh module once.')
      return
    }

    // If not connected, prompt to connect (must be a user gesture for Web Bluetooth).
    try {
      const s = mesh.getState().status
      const ready = !!s?.connected || !!s?.linkConnected
      if (!ready) {
        const ok = confirm('Mesh not connected.\n\nConnect now?')
        if (!ok) return
        try {
          await globalThis.meshConnect()
        } catch (e) {
          this.updateMeshSendButtonState()
          alert(`Mesh connect failed: ${formatMeshError(e)}`)
          return
        }
      }
    } catch (_) {
      // ignore
    }

    // Re-check ready
    {
      const s = mesh.getState().status
      const ready = !!s?.connected || !!s?.linkConnected
      this.updateMeshSendButtonState()
      if (!ready) {
        alert('Mesh not connected. Open Mesh and click Connect first.')
        return
      }
    }

    // Send each line (chunk) as its own mesh text message.
    // This keeps the mesh messages aligned with the transport max profile.
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (lines.length === 0) {
      alert('Nothing to send')
      return
    }

    const parsedList = typeof window.parsePacket === 'function' ? lines.map((l) => window.parsePacket(l)).filter(Boolean) : []
    if (parsedList.length === 0) {
      alert('Paste or generate a valid XCOM packet wrapper first.')
      return
    }

    // If a single unchunked wrapper is present, chunk it to the Meshtastic target length.
    const meshMax = window.getTransportMaxPacketChars ? window.getTransportMaxPacketChars('Meshtastic') : 180
    let sendLines = lines
    if (lines.length === 1) {
      try {
        const parseFn = window.parsePacket
        const chunkFn = globalThis.chunkPacketByMaxChars
        if (typeof parseFn === 'function' && typeof chunkFn === 'function') {
          const p = parsedList[0] || parseFn(lines[0])
          if (p && Number(p.total) > 1) {
            const ok = confirm(`This looks like 1 part of a multi-part packet (${p.part}/${p.total}).\n\nSend this part anyway?`)
            if (!ok) return
          } else if (p && Number(p.total) === 1) {
            const parts = chunkFn(p, meshMax)
            if (Array.isArray(parts) && parts.length > 0) {
              sendLines = parts.map((s) => String(s || '').trim()).filter(Boolean)
            }
          }
        }
      } catch (_) {
        // ignore
      }
    }

    // Confirm batch sends so users don't accidentally spam the mesh.
    if (sendLines.length > 1) {
      const ok = confirm(`Send ${sendLines.length} line(s) via mesh? (Each line is sent as its own Meshtastic message.)`)
      if (!ok) return
    }

    // Basic guard: if someone is about to send very long lines, warn about truncation.
    const tooLong = sendLines.find((l) => l.length > 200)
    if (tooLong) {
      const ok = confirm('Some lines are longer than ~200 chars.\nMeshtastic text may truncate.\n\nSend anyway?')
      if (!ok) return
    }

    try {
      for (const line of sendLines) {
        await globalThis.meshSendText(line)
      }
      window.radioApp.updateStatus(`Sent ${sendLines.length} line(s) via mesh`)
      this.updateMeshSendButtonState()
    } catch (e) {
      console.error(e)
      this.updateMeshSendButtonState()
      alert(`Mesh send failed: ${formatMeshError(e)}`)
    }
  }

  // -----------------------------
  // Import UI helpers
  // -----------------------------

  clearImport() {
    const t = document.getElementById('commsImportText')
    if (t) t.value = ''

    const decoded = document.getElementById('commsDecoded')
    if (decoded) decoded.textContent = ''

    const human = document.getElementById('commsDecodedHuman')
    if (human) {
      human.innerHTML = '<div class="commsSmallMuted">Paste a packet, scan a QR, or receive one from mesh to see details here.</div>'
    }

    try { this.setImportMapFeatures([]) } catch (_) { /* ignore */ }
    try { this.refreshImportMessageList({ keepSelection: false, preferLatestComplete: true }) } catch (_) { /* ignore */ }
    try { window.radioApp?.updateStatus?.('Import cleared') } catch (_) { /* ignore */ }
  }

  scheduleImportRefresh() {
    if (this._importParseTimer) {
      try { clearTimeout(this._importParseTimer) } catch (_) { /* ignore */ }
    }
    this._importParseTimer = setTimeout(() => {
      this._importParseTimer = null
      try { this.refreshImportMessageList({ keepSelection: true, preferLatestComplete: false }) } catch (_) { /* ignore */ }
    }, 150)
  }

  templateName(templateId) {
    const t = Number(templateId)
    switch (t) {
      case 1: return 'SITREP'
      case 2: return 'CONTACT'
      case 3: return 'TASK'
      case 4: return 'CHECKIN/LOC'
      case 5: return 'RESOURCE'
      case 6: return 'ASSET'
      case 7: return 'ZONE'
      default: return `T=${String(templateId)}`
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

  formatTimeParts(tsMs) {
    const n = Number(tsMs)
    if (!Number.isFinite(n) || n <= 0) return { local: '—', utc: '—' }
    const d = new Date(n)
    if (Number.isNaN(d.getTime())) return { local: '—', utc: '—' }
    return {
      local: d.toLocaleString(),
      utc: d.toISOString(),
    }
  }

  scanImportMessages(text) {
    const parse = globalThis.parsePacket
    if (typeof parse !== 'function') return []

    const lines = String(text || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    const groups = new Map()

    for (let i = 0; i < lines.length; i++) {
      const p = parse(lines[i])
      if (!p) continue
      const kidPart = p.mode === 'S' ? `.${String(p.kid)}` : ''
      const key = `${p.templateId}.${p.mode}.${p.id}.${p.total}${kidPart}`
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          templateId: p.templateId,
          mode: p.mode,
          id: p.id,
          kid: p.mode === 'S' ? p.kid : null,
          total: p.total,
          parts: new Map(),
          firstIdx: i,
          lastIdx: i,
        })
      }
      const g = groups.get(key)
      g.parts.set(p.part, p)
      g.firstIdx = Math.min(g.firstIdx, i)
      g.lastIdx = Math.max(g.lastIdx, i)
    }

    const out = []
    for (const g of Array.from(groups.values())) {
      const total = Math.max(1, Math.floor(Number(g.total) || 1))
      const missing = []
      for (let part = 1; part <= total; part++) {
        if (!g.parts.has(part)) missing.push(part)
      }
      out.push({
        ...g,
        total,
        partsReceived: g.parts.size,
        missingParts: missing,
        complete: missing.length === 0,
      })
    }

    out.sort((a, b) => Number(b.lastIdx) - Number(a.lastIdx))
    return out
  }

  refreshImportMessageList(opts = {}) {
    const sel = document.getElementById('commsImportMsgSelect')
    const hint = document.getElementById('commsImportMsgHint')
    const text = document.getElementById('commsImportText')?.value || ''
    const messages = this.scanImportMessages(text)
    this._importMessages = messages

    if (!sel) return messages

    const keepSelection = opts.keepSelection !== false
    const prevKey = keepSelection ? String(sel.value || '') : ''

    sel.innerHTML = ''

    if (messages.length === 0) {
      sel.disabled = true
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '(no packets found)'
      sel.appendChild(opt)
      if (hint) hint.textContent = 'Paste X1.* packet line(s) to decode.'
      return messages
    }

    sel.disabled = false
    for (const m of messages) {
      const modeLabel = m.mode === 'S' ? 'SECURE' : 'CLEAR'
      const kid = m.mode === 'S' ? ` KID ${String(m.kid)}` : ''
      const parts = `${m.partsReceived}/${m.total}`
      const status = m.complete ? 'complete' : `missing ${m.missingParts.join(',')}`
      const opt = document.createElement('option')
      opt.value = m.key
      opt.textContent = `${this.templateName(m.templateId)} (${modeLabel}) • ID ${m.id}${kid} • ${parts} • ${status}`
      sel.appendChild(opt)
    }

    let nextKey = ''
    if (prevKey && messages.some((m) => m.key === prevKey)) {
      nextKey = prevKey
    } else if (opts.preferLatestComplete) {
      const firstComplete = messages.find((m) => m.complete) || null
      nextKey = firstComplete ? firstComplete.key : messages[0].key
    } else {
      nextKey = messages[0].key
    }

    sel.value = nextKey

    const active = messages.find((m) => m.key === nextKey) || null
    if (hint) {
      if (!active) hint.textContent = ''
      else if (!active.complete) hint.textContent = `Selected packet is incomplete (missing: ${active.missingParts.join(', ')}).`
      else hint.textContent = `Selected packet is complete (${active.partsReceived}/${active.total}).`
    }

    return messages
  }

  decodeParsedWrapper(parsed) {
    if (!parsed) throw new Error('No packet selected')

    if (parsed.mode === 'C') {
      return this.decodeTemplate(parsed.templateId, parsed.payload)
    }

    // SECURE: decrypt to get underlying template bytes, then decode.
    let key = null

    // 1) Prefer the ACTIVE key slot (XCOM Comms model)
    if (window.getCommsActiveKey) {
      const activeKey = window.getCommsActiveKey()
      if (activeKey && activeKey.kid === parsed.kid) key = { keyB64Url: activeKey.keyB64Url }
    }

    // 2) Fallback: search all stored team keys by KID
    if (!key && window.getTeamKeysMap) {
      const map = window.getTeamKeysMap()
      const kidStr = String(Number(parsed.kid))
      for (const team of Object.keys(map || {})) {
        const rec = map?.[team]?.[kidStr]
        if (rec && rec.keyB64Url) {
          key = { keyB64Url: rec.keyB64Url }
          break
        }
      }
    }

    if (!key) throw new Error(`No key found for KID ${parsed.kid}. Import the matching XTOC-KEY bundle.`)
    const aad = window.makeSecureAad('X1', parsed.templateId, 'S', parsed.id, parsed.part, parsed.total, parsed.kid)
    const plainBytes = window.decodeSecurePayload(parsed.payload, key.keyB64Url, aad)

    // Prefer XTOC canonical behavior if helper is present.
    try {
      if (typeof window.decodeTemplatePlainBytes === 'function') {
        return window.decodeTemplatePlainBytes(parsed.templateId, plainBytes)
      }
      throw new Error('decodeTemplatePlainBytes not loaded')
    } catch (_) {
      // Legacy fallback: treat bytes as UTF-8 encoded base64url string.
      const payloadB64Url = new TextDecoder().decode(plainBytes)
      return this.decodeTemplate(parsed.templateId, payloadB64Url)
    }
  }

  renderDecodedHuman(wrapper, decodedObj) {
    const el = document.getElementById('commsDecodedHuman')
    if (!el) return

    const modeLabel = wrapper?.mode === 'S' ? 'SECURE' : 'CLEAR'
    const templateLabel = this.templateName(wrapper?.templateId)

    const time = this.formatTimeParts(decodedObj?.t)
    const title = `${templateLabel} (${modeLabel})`

    const kv = []
    const addKV = (k, v) => {
      const s = (v == null) ? '' : String(v)
      if (!s.trim()) return
      kv.push([k, s])
    }

    addKV('Message ID', wrapper?.id)
    addKV('Template', templateLabel)
    addKV('Mode', modeLabel)
    if (wrapper?.mode === 'S') addKV('KID', wrapper?.kid)
    addKV('Timestamp (Local)', time.local)
    addKV('Timestamp (UTC)', time.utc)

    const t = Number(wrapper?.templateId)
    if (t === 4) {
      addKV('Unit ID', decodedObj?.unitId)
      addKV('Status code', decodedObj?.status)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
    } else if (t === 1) {
      addKV('From (src)', decodedObj?.src)
      addKV('To (dst)', decodedObj?.dst)
      addKV('Priority', decodedObj?.pri)
      addKV('Status code', decodedObj?.status)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 2) {
      addKV('From (src)', decodedObj?.src)
      addKV('Priority', decodedObj?.pri)
      addKV('Contact type code', decodedObj?.typeCode)
      addKV('Count', decodedObj?.count)
      addKV('Direction code', decodedObj?.dir)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 3) {
      addKV('From (src)', decodedObj?.src)
      addKV('To (dst)', decodedObj?.dst)
      addKV('Priority', decodedObj?.pri)
      addKV('Action code', decodedObj?.actionCode)
      addKV('Due (minutes)', decodedObj?.dueMins)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 5) {
      addKV('From (src)', decodedObj?.src)
      addKV('Priority', decodedObj?.pri)
      addKV('Item code', decodedObj?.itemCode)
      addKV('Quantity', decodedObj?.qty)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 6) {
      addKV('From (src)', decodedObj?.src)
      addKV('Condition code', decodedObj?.condition)
      addKV('Type code', decodedObj?.typeCode)
      if (decodedObj?.label) addKV('Label', decodedObj.label)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 7) {
      addKV('From (src)', decodedObj?.src)
      addKV('Threat code', decodedObj?.threat)
      addKV('Meaning code', decodedObj?.meaningCode)
      if (decodedObj?.label) addKV('Label', decodedObj.label)
      if (decodedObj?.note) addKV('Note', decodedObj.note)

      const shape = decodedObj?.shape
      if (shape && shape.kind === 'circle') {
        addKV('Zone shape', `Circle (${Math.round(Number(shape.radiusM || 0))} m radius)`)
        if (Number.isFinite(shape.centerLat) && Number.isFinite(shape.centerLon)) {
          addKV('Center', `${Number(shape.centerLat).toFixed(5)}, ${Number(shape.centerLon).toFixed(5)}`)
        }
      } else if (shape && (shape.kind === 'poly' || shape.kind === 'polygon')) {
        const pts = Array.isArray(shape.points) ? shape.points : []
        addKV('Zone shape', `Polygon (${pts.length} points)`)
      }
    }

    const rowsHtml = kv
      .map(([k, v]) => `<div class="commsKVKey">${this.escapeHtml(k)}</div><div class="commsKVVal">${this.escapeHtml(v)}</div>`)
      .join('')

    let extra = ''
    if (t === 7) {
      const shape = decodedObj?.shape
      const pts = (shape && Array.isArray(shape.points)) ? shape.points : []
      if (shape && (shape.kind === 'poly' || shape.kind === 'polygon') && pts.length) {
        const ptsText = pts
          .map((p) => `${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`)
          .join('\n')
        extra = `
          <details class="commsDetails commsDetails--inline">
            <summary>Zone points</summary>
            <pre class="commsPre commsPre--small">${this.escapeHtml(ptsText)}</pre>
          </details>
        `
      }
    }

    el.innerHTML = `
      <div class="commsDecodedHumanTitle">${this.escapeHtml(title)}</div>
      <div class="commsDecodedHumanSub">${this.escapeHtml(time.local)} <span class="commsSmallMuted">(UTC ${this.escapeHtml(time.utc)})</span></div>
      <div class="commsKV">${rowsHtml}</div>
      ${extra}
    `
  }

  // -----------------------------
  // Import map preview (mini map)
  // -----------------------------

  ensureImportMapInitialized() {
    const container = document.getElementById('commsImportMap')
    if (!container) return false

    if (this._importMap && this._importMapContainer === container) return true

    // If a previous instance exists (module reload), clean it up.
    try { if (this._importMap) this._importMap.remove() } catch (_) { /* ignore */ }
    this._importMap = null
    this._importMapContainer = container
    this._importMapLoaded = false

    if (!globalThis.maplibregl) {
      const hint = document.getElementById('commsImportMapHint')
      if (hint) hint.textContent = 'Map unavailable (MapLibre not loaded).'
      return false
    }

    // Use shared saved view so the preview matches the Map module AO.
    const c = globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 35.9606, lon: -83.9207 }
    const z = globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 6

    const style = globalThis.buildMapLibreStyle ? globalThis.buildMapLibreStyle() : 'https://tiles.openfreemap.org/styles/liberty'

    const map = new globalThis.maplibregl.Map({
      container,
      style,
      center: [c.lon, c.lat],
      zoom: z,
      attributionControl: false,
    })

    try { map.addControl(new globalThis.maplibregl.AttributionControl({ compact: true }), 'bottom-right') } catch (_) { /* ignore */ }
    try { map.addControl(new globalThis.maplibregl.NavigationControl({ showCompass: false }), 'top-right') } catch (_) { /* ignore */ }

    // Make this mini map less scroll-hijacky.
    try { map.scrollZoom.disable() } catch (_) { /* ignore */ }
    try { map.dragRotate.disable() } catch (_) { /* ignore */ }
    try { map.touchZoomRotate.disableRotation() } catch (_) { /* ignore */ }

    // Offline raster dark filter (if user chose it in Map settings)
    map.on('render', () => {
      try {
        if (globalThis.applyOfflineRasterDarkFilter) globalThis.applyOfflineRasterDarkFilter(container)
      } catch (_) {
        // ignore
      }
    })

    const id = Date.now()
    this._importGeoSourceId = `comms-import-src-${id}`
    this._importPointLayerId = `comms-import-pt-${id}`
    this._importLineLayerId = `comms-import-ln-${id}`
    this._importFillLayerId = `comms-import-fl-${id}`

    map.on('load', () => {
      this._importMapLoaded = true

      try {
        if (!map.getSource(this._importGeoSourceId)) {
          map.addSource(this._importGeoSourceId, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          })

          // Zone fill
          map.addLayer({
            id: this._importFillLayerId,
            type: 'fill',
            source: this._importGeoSourceId,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {
              'fill-color': '#66c2ff',
              'fill-opacity': 0.15,
            },
          })

          // Line outlines (polygons + optional lines)
          map.addLayer({
            id: this._importLineLayerId,
            type: 'line',
            source: this._importGeoSourceId,
            filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'LineString']],
            paint: {
              'line-color': '#66c2ff',
              'line-width': 3,
            },
          })

          // Points
          map.addLayer({
            id: this._importPointLayerId,
            type: 'circle',
            source: this._importGeoSourceId,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
              'circle-radius': 6,
              'circle-color': '#2ee6a6',
              'circle-stroke-color': '#0b0f16',
              'circle-stroke-width': 2,
            },
          })
        }

        if (this._importPendingFeatureCollection) {
          const src = map.getSource(this._importGeoSourceId)
          if (src && typeof src.setData === 'function') src.setData(this._importPendingFeatureCollection)
          this._importPendingFeatureCollection = null
        }
      } catch (_) {
        // ignore
      }
    })

    this._importMap = map

    // Ensure proper render after layout.
    setTimeout(() => {
      try { map.resize() } catch (_) { /* ignore */ }
    }, 50)

    return true
  }

  setImportMapHint(text) {
    const hint = document.getElementById('commsImportMapHint')
    if (hint) hint.textContent = String(text || '')
  }

  setImportMapFeatures(features) {
    const ok = this.ensureImportMapInitialized()
    if (!ok || !this._importMap) return

    const fc = {
      type: 'FeatureCollection',
      features: Array.isArray(features) ? features : [],
    }

    const map = this._importMap
    const src = this._importGeoSourceId ? map.getSource(this._importGeoSourceId) : null
    if (src && typeof src.setData === 'function') {
      try { src.setData(fc) } catch (_) { /* ignore */ }
    } else {
      this._importPendingFeatureCollection = fc
    }
  }

  circleToPolygon(centerLat, centerLon, radiusM, steps = 64) {
    const lat = Number(centerLat)
    const lon = Number(centerLon)
    const r = Math.max(0, Number(radiusM) || 0)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(r) || r <= 0) return null

    // Very lightweight approximation suitable for small preview maps.
    const R = 6378137
    const latRad = (lat * Math.PI) / 180
    const angDist = r / R

    const coords = []
    const n = Math.max(12, Math.min(180, Math.floor(Number(steps) || 64)))
    for (let i = 0; i < n; i++) {
      const brng = (i / n) * 2 * Math.PI
      const sinLat = Math.sin(latRad)
      const cosLat = Math.cos(latRad)
      const sinAd = Math.sin(angDist)
      const cosAd = Math.cos(angDist)

      const lat2 = Math.asin(sinLat * cosAd + cosLat * sinAd * Math.cos(brng))
      const lon2 = ((lon * Math.PI) / 180) + Math.atan2(Math.sin(brng) * sinAd * cosLat, cosAd - sinLat * Math.sin(lat2))

      coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI])
    }
    if (coords.length) coords.push(coords[0])
    return coords
  }

  fitImportMapToFeatures(features) {
    if (!this._importMap || !globalThis.maplibregl) return

    let minLon = Infinity
    let minLat = Infinity
    let maxLon = -Infinity
    let maxLat = -Infinity

    const extend = (lon, lat) => {
      const x = Number(lon)
      const y = Number(lat)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      minLon = Math.min(minLon, x)
      maxLon = Math.max(maxLon, x)
      minLat = Math.min(minLat, y)
      maxLat = Math.max(maxLat, y)
    }

    for (const f of Array.isArray(features) ? features : []) {
      const g = f?.geometry
      if (!g) continue
      if (g.type === 'Point' && Array.isArray(g.coordinates)) {
        extend(g.coordinates[0], g.coordinates[1])
      } else if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
        const ring = g.coordinates[0] || []
        for (const c of ring) extend(c?.[0], c?.[1])
      } else if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
        for (const c of g.coordinates) extend(c?.[0], c?.[1])
      }
    }

    if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) return

    const map = this._importMap
    if (minLon === maxLon && minLat === maxLat) {
      try {
        map.easeTo({ center: [minLon, minLat], zoom: Math.max(6, Math.min(13, map.getZoom() || 10)) })
      } catch (_) {
        // ignore
      }
      return
    }

    try {
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 28, duration: 0, maxZoom: 13 })
    } catch (_) {
      // ignore
    }
  }

  updateImportMapPreview(wrapper, decodedObj) {
    const t = Number(wrapper?.templateId)

    // Default map text
    this.setImportMapHint('Shows the location/zone when the packet includes it.')

    const features = []

    if (t === 7 && decodedObj && typeof decodedObj === 'object') {
      const shape = decodedObj?.shape
      if (shape && shape.kind === 'circle') {
        const ring = this.circleToPolygon(shape.centerLat, shape.centerLon, shape.radiusM, 72)
        if (ring) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { kind: 'zone' },
          })
        }
        if (Number.isFinite(shape.centerLat) && Number.isFinite(shape.centerLon)) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [Number(shape.centerLon), Number(shape.centerLat)] },
            properties: { kind: 'center' },
          })
        }
        this.setImportMapHint('Zone preview (circle).')
      } else if (shape && (shape.kind === 'poly' || shape.kind === 'polygon')) {
        const pts = Array.isArray(shape.points) ? shape.points : []
        const ring = pts
          .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
          .map((p) => [Number(p.lon), Number(p.lat)])
        if (ring.length >= 3) {
          ring.push(ring[0])
          features.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { kind: 'zone' },
          })

          // Simple centroid-ish marker (average of vertices) for visibility.
          const avg = ring.slice(0, -1).reduce((acc, c) => {
            acc.lon += Number(c[0])
            acc.lat += Number(c[1])
            acc.n += 1
            return acc
          }, { lon: 0, lat: 0, n: 0 })
          if (avg.n > 0) {
            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [avg.lon / avg.n, avg.lat / avg.n] },
              properties: { kind: 'center' },
            })
          }

          this.setImportMapHint('Zone preview (polygon).')
        } else {
          this.setImportMapHint('Zone preview unavailable (not enough valid points).')
        }
      } else {
        this.setImportMapHint('No zone shape found in this packet.')
      }
    } else if (decodedObj && typeof decodedObj === 'object' && Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(decodedObj.lon), Number(decodedObj.lat)] },
        properties: { kind: 'loc' },
      })
      this.setImportMapHint('Location preview.')
    } else {
      this.setImportMapHint('This packet does not include a location or zone.')
    }

    this.setImportMapFeatures(features)
    this.fitImportMapToFeatures(features)
  }

  // -----------------------------
  // Mesh auto-receive (Meshtastic)
  // -----------------------------

  isAutoMeshRxEnabled() {
    const el = document.getElementById('commsAutoMeshRx')
    return el ? !!el.checked : true
  }

  updateMeshRxHint(state = null) {
    const el = document.getElementById('commsMeshRxHint')
    if (!el) return

    let s = state
    if (!s) {
      try { s = globalThis.xcomMesh?.getState?.() } catch (_) { s = null }
    }

    const status = s?.status || {}
    const connected = !!status?.connected || !!status?.linkConnected
    const auto = this.isAutoMeshRxEnabled()

    let tail = ''
    if (this._lastMeshRxAt) {
      try {
        const t = new Date(Number(this._lastMeshRxAt)).toLocaleTimeString()
        const from = this._lastMeshRxFrom != null ? ` from ${String(this._lastMeshRxFrom)}` : ''
        tail = ` • last rx ${t}${from}`
      } catch (_) {
        // ignore
      }
    }

    el.textContent = `Mesh: ${connected ? 'connected' : 'not connected'} • auto-receive ${auto ? 'ON' : 'OFF'}${tail}`
  }

  _meshSetTrafficCursorToEnd(traffic) {
    const arr = Array.isArray(traffic) ? traffic : []
    if (arr.length === 0) {
      this._meshTrafficCursorTs = 0
      this._meshTrafficCursorCountAtTs = 0
      return
    }

    const lastTs = Number(arr[arr.length - 1]?.ts || 0)
    let count = 0
    for (let i = arr.length - 1; i >= 0; i--) {
      const ts = Number(arr[i]?.ts || 0)
      if (ts !== lastTs) break
      count++
    }

    this._meshTrafficCursorTs = lastTs
    this._meshTrafficCursorCountAtTs = count
  }

  _meshComputeTrafficStartIndex(traffic) {
    const arr = Array.isArray(traffic) ? traffic : []
    const cursorTs = this._meshTrafficCursorTs

    // First call: don't import history; set cursor to end.
    if (cursorTs == null) {
      this._meshSetTrafficCursorToEnd(arr)
      return arr.length
    }

    const cursorCount = Number(this._meshTrafficCursorCountAtTs || 0)
    let seenAtTs = 0

    for (let i = 0; i < arr.length; i++) {
      const ts = Number(arr[i]?.ts || 0)
      if (ts < cursorTs) continue
      if (ts === cursorTs) {
        seenAtTs++
        if (seenAtTs <= cursorCount) continue
        return i
      }
      // ts > cursorTs
      return i
    }

    return arr.length
  }

  extractPacketLinesFromText(text) {
    const parse = globalThis.parsePacket
    if (typeof parse !== 'function') return []

    const out = []
    const tokens = String(text || '').split(/\s+/).map((s) => s.trim()).filter(Boolean)
    for (const tok of tokens) {
      const idx = tok.indexOf('X1.')
      if (idx < 0) continue
      let cand = tok.slice(idx)
      cand = cand.replace(/[^A-Za-z0-9._/-]+$/g, '')
      const p = parse(cand)
      if (p) out.push(p.raw || cand)
    }
    return out
  }

  appendImportLines(lines) {
    const el = document.getElementById('commsImportText')
    if (!el) return 0

    const existing = String(el.value || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    const seen = new Set(existing)

    const add = []
    for (const line of Array.isArray(lines) ? lines : []) {
      const t = String(line || '').trim()
      if (!t) continue
      if (seen.has(t)) continue
      seen.add(t)
      add.push(t)
    }

    if (add.length === 0) return 0

    const prefix = String(el.value || '').trim()
    el.value = prefix ? `${prefix}\n${add.join('\n')}\n` : `${add.join('\n')}\n`
    return add.length
  }

  maybeAutoDecodeLatestComplete() {
    const messages = this.refreshImportMessageList({ keepSelection: false, preferLatestComplete: true })
    const sel = document.getElementById('commsImportMsgSelect')
    if (!sel) return

    const key = String(sel.value || '').trim()
    if (!key) return

    // Avoid re-decoding the same message on each traffic tick.
    if (this._lastDecodedKey && this._lastDecodedKey === key) return

    const active = messages.find((m) => m.key === key) || null
    if (!active || !active.complete) return

    this.reassembleAndDecode({ auto: true })
  }

  processIncomingMeshTraffic(state) {
    const s = state || null
    const traffic = Array.isArray(s?.traffic) ? s.traffic : []

    const status = s?.status || {}
    const connected = !!status?.connected || !!status?.linkConnected
    if (!connected) {
      this._meshSetTrafficCursorToEnd(traffic)
      return
    }

    if (!this.isAutoMeshRxEnabled()) {
      this._meshSetTrafficCursorToEnd(traffic)
      return
    }

    const startIdx = this._meshComputeTrafficStartIndex(traffic)
    const slice = traffic.slice(startIdx)

    // Advance cursor immediately so even if decoding throws, we don't re-import the same entries forever.
    this._meshSetTrafficCursorToEnd(traffic)

    const lines = []
    for (const e of slice) {
      if (!e || typeof e !== 'object') continue
      if (e.dir !== 'in') continue
      if (e.kind !== 'message') continue
      const text = e.text
      if (typeof text !== 'string' || !text.trim()) continue
      const extracted = this.extractPacketLinesFromText(text)
      for (const line of extracted) lines.push(line)

      if (extracted.length) {
        this._lastMeshRxAt = Date.now()
        this._lastMeshRxFrom = e.from ?? null
      }
    }

    if (lines.length === 0) return

    const added = this.appendImportLines(lines)
    if (added > 0) {
      try { window.radioApp?.updateStatus?.(`Received ${added} packet line(s) from mesh`) } catch (_) { /* ignore */ }
      try { this.updateMeshRxHint(s) } catch (_) { /* ignore */ }

      // If the user recently manually selected a different message, don't steal focus.
      const touchedAt = Number(this._importSelectionTouchedAt || 0)
      const recentlyTouched = touchedAt > 0 && (Date.now() - touchedAt) < 8000
      if (!recentlyTouched) {
        this.maybeAutoDecodeLatestComplete()
      } else {
        // Still refresh list so the new message appears.
        this.refreshImportMessageList({ keepSelection: true, preferLatestComplete: false })
      }
    }
  }

  onMeshState(state) {
    this._meshLastState = state || null
    this.updateMeshRxHint(state)
    this.processIncomingMeshTraffic(state)
  }

  reassembleAndDecode(opts = {}) {
    const decoded = document.getElementById('commsDecoded')
    if (decoded) decoded.textContent = ''

    try {
      const messages = this.refreshImportMessageList({ keepSelection: true, preferLatestComplete: true })
      const selKey = String(document.getElementById('commsImportMsgSelect')?.value || '').trim()
      const active = messages.find((m) => m.key === selKey) || messages[0] || null
      if (!active) throw new Error('No valid packets found')

      if (!active.complete) {
        throw new Error(`Selected packet is incomplete (missing: ${active.missingParts.join(', ')}).`)
      }

      let parsed = null
      if (active.total === 1) {
        parsed = active.parts.get(1) || Array.from(active.parts.values())[0] || null
      } else {
        if (typeof window.reassemblePackets !== 'function' || typeof window.parsePacket !== 'function') {
          throw new Error('Chunking helpers not loaded')
        }
        const res = window.reassemblePackets(Array.from(active.parts.values()))
        if (!res.ok) throw new Error(res.reason)
        parsed = window.parsePacket(res.packet)
        if (!parsed) throw new Error('Failed to parse reassembled packet')
      }

      const obj = this.decodeParsedWrapper(parsed)
      if (decoded) decoded.textContent = JSON.stringify({ wrapper: parsed, decoded: obj }, null, 2)

      this.renderDecodedHuman(parsed, obj)
      try { this.updateImportMapPreview(parsed, obj) } catch (_) { /* ignore */ }

      this._lastDecodedKey = active?.key || selKey || null
    } catch (e) {
      const msg = e?.message ? String(e.message) : String(e)
      if (decoded) decoded.textContent = `Error: ${msg}`
      const human = document.getElementById('commsDecodedHuman')
      if (human) {
        human.innerHTML = `<div class="commsWarn">Error: ${this.escapeHtml(msg)}</div>`
      }
      try { this.setImportMapFeatures([]) } catch (_) { /* ignore */ }
    }
  }

  decodeTemplate(templateId, payloadB64Url) {
    switch (templateId) {
      case 1:
        return window.decodeSitrepClear(payloadB64Url)
      case 2:
        return window.decodeContactClear(payloadB64Url)
      case 3:
        return window.decodeTaskClear(payloadB64Url)
      case 4:
        return window.decodeCheckinLocClear(payloadB64Url)
      case 5:
        return window.decodeResourceClear(payloadB64Url)
      case 6:
        return window.decodeAssetClear(payloadB64Url)
      case 7:
        return window.decodeZoneClear(payloadB64Url)
      default:
        return { payloadB64Url }
    }
  }

  async scanQr() {
    if (!globalThis.QrScanner) {
      alert('QrScanner not loaded')
      return
    }

    const overlay = document.createElement('div')
    overlay.className = 'commsQrOverlay'
    overlay.innerHTML = `
      <div class="commsQrModal">
        <div class="commsQrModalTitle">Scan QR</div>
        <video id="commsQrVideo"></video>
        <div class="commsButtonRow">
          <button id="commsQrStopBtn" type="button" class="danger">Stop</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    const video = overlay.querySelector('#commsQrVideo')
    const stopBtn = overlay.querySelector('#commsQrStopBtn')

    try {
      // required for worker
      globalThis.QrScanner.WORKER_PATH = 'assets/vendor/qr-scanner-worker.min.js'
      this.qrScanner = new globalThis.QrScanner(
        video,
        (result) => {
          const text = (result && result.data) ? result.data : String(result)
          document.getElementById('commsImportText').value = text
          this.reassembleAndDecode()
          this.stopQr(overlay)
        },
        { returnDetailedScanResult: true },
      )
      await this.qrScanner.start()
      stopBtn.addEventListener('click', () => this.stopQr(overlay))
    } catch (e) {
      console.error(e)
      this.stopQr(overlay)
      alert(`QR scan failed: ${e.message || e}`)
    }
  }

  stopQr(overlay) {
    try {
      if (this.qrScanner) this.qrScanner.stop()
    } catch (_) {
      // ignore
    }
    this.qrScanner = null
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
  }
}
