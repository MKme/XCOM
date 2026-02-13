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

function parseUnitIdListText(s, max = 32) {
  const text = String(s ?? '').trim()
  if (!text) return []
  const matches = text.match(/\d+/g) || []
  const out = []
  const seen = new Set()
  for (const m of matches) {
    const n = Math.floor(Number(m))
    if (!Number.isFinite(n) || n <= 0 || n > 65535) continue
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= max) break
  }
  return out
}

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
    this._halowUnsub = null

    // Voice (TTS) state
    this._voiceSession = 0

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

    // HaLow auto-receive cursor (traffic log is a ring buffer)
    this._halowTrafficCursorTs = null
    this._halowTrafficCursorCountAtTs = 0
    this._lastHaLowRxAt = null
    this._lastHaLowRxFrom = null
    this._halowLastState = null

    // Source hint for storing decoded packets (mesh/manet/manual/etc)
    this._importAutoSourceHint = null
    this._importStoredKeys = new Set()

    this.init()
  }

  init() {
    this.createModuleStructure()
    this.bindEvents()
    this.updateKeySummary()
    try { this.updateRosterStatus() } catch (_) { /* ignore */ }
    this.updateTemplateFields()
    try { this.refreshImportedRawList() } catch (_) { /* ignore */ }
    window.radioApp.updateStatus('XTOC Comm module loaded')
  }

  createModuleStructure() {
    const root = document.getElementById('comms')
    root.innerHTML = `
      <div class="xModuleIntro">
          <div class="xModuleIntroTitle">What you can do here</div>
          <div class="xModuleIntroText">
          Create XTOC packets (CLEAR or SECURE), split them for different transport limits, and move them via copy/paste, Voice (TTS), QR, Meshtastic/MeshCore, or MANET (LAN).
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
              <option value="8">T=8 MISSION</option>
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
              <option value="Voice">Voice (TTS)</option>
              <option value="Meshtastic">Meshtastic (180 chars)</option>
              <option value="MeshCore">MeshCore (160 bytes)</option>
              <option value="HaLow">MANET (LAN)</option>
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
            <button id="commsUseGpsBtn" type="button" title="Fill Lat/Lon from your device location">Use GPS</button>
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
            <button id="commsOutputVoiceBtn" type="button" style="display:none" title="Text-to-speech spelling of the output. Click again while speaking to stop.">Output Voice</button>
            <button id="commsVoiceUnitPriorityBtn" type="button" style="display:none" title="Canned voice relay intro">Unit / Priority</button>
            <button id="commsVoiceRepeatBtn" type="button" style="display:none" title="Canned voice relay phrase">I repeat</button>
            <button id="commsVoiceEndBtn" type="button" style="display:none" title="Canned voice relay outro">End of message</button>
            <button id="commsSendMeshBtn" type="button">Send via Mesh</button>
            <button id="commsSendHaLowBtn" type="button">Send via MANET</button>
            <button id="commsMakeQrBtn" type="button">Make QR</button>
            <button id="commsPrintQrBtn" type="button">Print QR</button>
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
              <button id="commsImportToMapBtn" type="button" class="primary" title="Import the selected decoded packet so it appears on the Map under the Imported overlay" disabled>Import</button>
              <button id="commsScanQrBtn" type="button">Scan QR</button>
              <button id="commsClearImportBtn" type="button" class="danger">Clear</button>
            </div>
            <div class="commsGrid2 commsImportToggles">
              <label class="commsInline commsInline--check">
                <input type="checkbox" id="commsAutoMeshRx" checked>
                Auto-receive from mesh
              </label>
              <div class="commsSmallMuted" id="commsMeshRxHint">Mesh: not connected</div>
              <label class="commsInline commsInline--check">
                <input type="checkbox" id="commsAutoHaLowRx" checked>
                Auto-receive from MANET
              </label>
              <div class="commsSmallMuted" id="commsHaLowRxHint">MANET: not connected</div>
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

        <div class="commsCard commsCard--imported">
          <div class="commsCardTitle">Imported (raw)</div>
          <div class="commsRow">
            <label for="commsImportedRaw">Raw list</label>
            <textarea id="commsImportedRaw" rows="4" placeholder="Imported packet wrappers will appear here" readonly></textarea>
            <div class="commsButtonRow">
              <button id="commsCopyImportedBtn" type="button">Copy</button>
              <button id="commsClearImportedBtn" type="button" class="danger">Clear Imported</button>
            </div>
            <div class="commsSmallMuted">These appear on the Map module under the Imported overlay.</div>
          </div>
        </div>

        <div class="commsCard commsCard--xtocImport">
          <div class="commsCardTitle">XTOC -&gt; XCOM Import</div>
          <div class="commsCardSub">Merges the full roster (including personal fields; prefers <code>label</code>), SECURE keys (KID), and ALL XTOC packets (location + non-location) into this device. Does not wipe existing XCOM data.</div>

          <div class="commsRow" style="margin-top:10px">
            <label>XTOC Backup (.json)</label>
            <div class="commsButtonRow">
              <button id="commsImportXtocBackupBtn" type="button" class="primary">Import Backup</button>
            </div>
            <div class="commsSmallMuted">Use XTOC Topbar Export (e.g. <code>xtoc-backup-*.json</code>). XCOM merges roster/keys/packets and ignores XTOC settings/missions/KML layers.</div>
            <div class="commsSmallMuted" id="commsXtocImportStatus"></div>
          </div>

          <div class="commsDivider"></div>

          <div class="commsRow">
            <label for="commsTeamBundle">Team roster bundle</label>
            <textarea id="commsTeamBundle" rows="2" placeholder="XTOC-TEAM.&lt;base64(json)&gt;"></textarea>
            <div class="commsButtonRow">
              <button id="commsImportTeamBtn" type="button">Import Team</button>
              <button id="commsScanTeamQrBtn" type="button">Scan Team QR</button>
              <button id="commsClearTeamBtn" type="button" class="danger">Clear</button>
              <button id="commsClearRosterBtn" type="button" class="danger">Clear Roster</button>
            </div>
            <div class="commsSmallMuted" id="commsRosterStatus">Roster: none loaded</div>
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
    if (transportSel) transportSel.addEventListener('change', () => {
      this.updateMeshSendButtonState()
      this.updateHaLowSendButtonState()
      this.updateVoiceButtonsState()
    })

    // No Team ID / KID inputs in XCOM Comms (keys are purely “active key” based).

    document.getElementById('commsGenerateBtn').addEventListener('click', () => this.generate())
    document.getElementById('commsCopyBtn').addEventListener('click', () => this.copyOutput())
    document.getElementById('commsOutputVoiceBtn').addEventListener('click', () => void this.outputVoice())
    document.getElementById('commsVoiceUnitPriorityBtn').addEventListener('click', () => {
      const unitId = this.tryGetAnnounceUnitIdFromCurrentOutputText()
      const phrase = unitId
        ? `Unit ${unitId} priority message for X C O M command`
        : 'Priority message for X C O M command'
      void this.speakPlainText(phrase)
    })
    document.getElementById('commsVoiceRepeatBtn').addEventListener('click', () => void this.speakPlainText('I repeat'))
    document.getElementById('commsVoiceEndBtn').addEventListener('click', () => void this.speakPlainText('End of message for X C O M command'))
    document.getElementById('commsSendMeshBtn').addEventListener('click', () => this.sendViaMesh())
    document.getElementById('commsSendHaLowBtn').addEventListener('click', () => this.sendViaHaLow())
    document.getElementById('commsMakeQrBtn').addEventListener('click', () => this.makeQr())
    document.getElementById('commsPrintQrBtn').addEventListener('click', () => void this.printQr())

    document.getElementById('commsReassembleBtn').addEventListener('click', () => this.reassembleAndDecode())
    document.getElementById('commsImportToMapBtn').addEventListener('click', () => this.importSelectedToMap())
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

    const autoHaLowRx = document.getElementById('commsAutoHaLowRx')
    if (autoHaLowRx) {
      try {
        const raw = localStorage.getItem('xcom.comms.autoHaLowRx.v1')
        if (raw === '0') autoHaLowRx.checked = false
      } catch (_) {
        // ignore
      }
      autoHaLowRx.addEventListener('change', () => {
        try { localStorage.setItem('xcom.comms.autoHaLowRx.v1', autoHaLowRx.checked ? '1' : '0') } catch (_) { /* ignore */ }
        try { this.updateHaLowRxHint() } catch (_) { /* ignore */ }
      })
    }

    document.getElementById('commsImportKeyBtn').addEventListener('click', () => this.importKey())
    document.getElementById('commsScanKeyQrBtn').addEventListener('click', () => this.scanKeyQr())
    document.getElementById('commsDeleteKeyBtn').addEventListener('click', () => this.deleteKey())
    document.getElementById('commsClearKeyBtn').addEventListener('click', () => (document.getElementById('commsKeyBundle').value = ''))

    document.getElementById('commsCopyImportedBtn').addEventListener('click', () => this.copyImportedRaw())
    document.getElementById('commsClearImportedBtn').addEventListener('click', () => this.clearImported())

    document.getElementById('commsImportXtocBackupBtn').addEventListener('click', () => void this.importXtocBackup())
    document.getElementById('commsImportTeamBtn').addEventListener('click', () => this.importTeamRoster())
    document.getElementById('commsScanTeamQrBtn').addEventListener('click', () => this.scanTeamQr())
    document.getElementById('commsClearTeamBtn').addEventListener('click', () => (document.getElementById('commsTeamBundle').value = ''))
    document.getElementById('commsClearRosterBtn').addEventListener('click', () => this.clearRoster())

    document.getElementById('commsPickLocBtn').addEventListener('click', () => {
      this.openMapPicker('loc')
    })
    document.getElementById('commsUseGpsBtn').addEventListener('click', () => {
      void this.fillTemplateLocationFromGps()
    })
    document.getElementById('commsPickZoneBtn').addEventListener('click', () => {
      this.openMapPicker('zone')

    })

    document.getElementById('commsScanQrBtn').addEventListener('click', () => this.scanQr())

    // initial state for zone-only controls
    this.updateZoneUiState()

    // Sync the mesh send button with transport + mesh connection status.
    this.updateMeshSendButtonState()
    this.updateHaLowSendButtonState()
    this.updateVoiceButtonsState()
    try {
      // Avoid accumulating subscriptions across module reloads.
      if (globalThis.__xcomCommsCleanup) {
        try { globalThis.__xcomCommsCleanup() } catch (_) { /* ignore */ }
        globalThis.__xcomCommsCleanup = null
      } else if (globalThis.__xcomCommsMeshUnsub) {
        try { globalThis.__xcomCommsMeshUnsub() } catch (_) { /* ignore */ }
        globalThis.__xcomCommsMeshUnsub = null
      } else if (globalThis.__xcomCommsHaLowUnsub) {
        try { globalThis.__xcomCommsHaLowUnsub() } catch (_) { /* ignore */ }
        globalThis.__xcomCommsHaLowUnsub = null
      }

      globalThis.__xcomCommsCleanup = () => {
        try { if (this._meshUnsub) this._meshUnsub() } catch (_) { /* ignore */ }
        this._meshUnsub = null
        try { if (this._halowUnsub) this._halowUnsub() } catch (_) { /* ignore */ }
        this._halowUnsub = null
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

      if (globalThis.xcomHaLow && typeof globalThis.xcomHaLow.subscribe === 'function') {
        this._halowUnsub = globalThis.xcomHaLow.subscribe((state) => {
          try { this.updateHaLowSendButtonState() } catch (_) { /* ignore */ }
          try { this.onHaLowState(state) } catch (_) { /* ignore */ }
        })
        globalThis.__xcomCommsHaLowUnsub = this._halowUnsub
      }
    } catch (_) {
      // ignore
    }

    // Initial import UI state
    try { this.refreshImportMessageList({ keepSelection: false, preferLatestComplete: true }) } catch (_) { /* ignore */ }
    try { this.updateMeshRxHint() } catch (_) { /* ignore */ }
    try { this.updateHaLowRxHint() } catch (_) { /* ignore */ }
    try { this.ensureImportMapInitialized() } catch (_) { /* ignore */ }
  }

  updateZoneUiState() {
    const templateId = Number(document.getElementById('commsTemplate')?.value)
    const isZone = templateId === 7

    const pickLocBtn = document.getElementById('commsPickLocBtn')
    const gpsBtn = document.getElementById('commsUseGpsBtn')
    const zoneBtn = document.getElementById('commsPickZoneBtn')
    const zonePts = document.getElementById('t_zone_points')

    // In XTOC, "Generate Shape" (zone drawing) is only active when sending a ZONE.
    // For XCOM, the equivalent is "Draw Zone" + the polygon textarea.
    if (pickLocBtn) pickLocBtn.disabled = isZone
    if (gpsBtn) gpsBtn.disabled = isZone
    if (zoneBtn) zoneBtn.disabled = !isZone
    if (zonePts) zonePts.disabled = !isZone
  }

  async fillTemplateLocationFromGps() {
    const latEl = document.getElementById('t_lat')
    const lonEl = document.getElementById('t_lon')
    if (!latEl || !lonEl) {
      alert('This template does not include Lat/Lon fields.')
      return
    }

    const onError = (error) => {
      console.error('Geolocation error:', error)
      const code = Number(error?.code)
      let message = 'Unable to get your location.'
      if (code === 1) message = 'Unable to get your location: permission denied.'
      else if (code === 2) message = 'Unable to get your location: position unavailable.'
      else if (code === 3) message = 'Unable to get your location: timed out.'

      try { window.radioApp.updateStatus(message) } catch (_) { /* ignore */ }
      alert(message)
    }

    const setValues = (lat, lon) => {
      const latNum = Number(lat)
      const lonNum = Number(lon)
      if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
        onError({ code: 2 })
        return
      }

      latEl.value = latNum.toFixed(5)
      lonEl.value = lonNum.toFixed(5)

      const labelEl = document.getElementById('t_location_label')
      if (labelEl && !String(labelEl.value || '').trim()) labelEl.value = 'Current position'

      try { window.radioApp.updateStatus('Set Lat/Lon from GPS') } catch (_) { /* ignore */ }
    }

    try { window.radioApp.updateStatus('Requesting GPS fix...') } catch (_) { /* ignore */ }

    if (window.electronAPI && window.electronAPI.isElectron && typeof window.electronAPI.getCurrentPosition === 'function') {
      try {
        const pos = await window.electronAPI.getCurrentPosition()
        setValues(pos?.coords?.latitude, pos?.coords?.longitude)
      } catch (e) {
        onError(e)
      }
      return
    }

    if (!navigator.geolocation) {
      const message = 'Geolocation is not supported in this environment.'
      try { window.radioApp.updateStatus(message) } catch (_) { /* ignore */ }
      alert(message)
      return
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => setValues(pos.coords.latitude, pos.coords.longitude),
      (err) => onError(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    )
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
          'line-color': 'rgba(246,201,69,0.95)',
          'line-width': 3,
        },
      })

      // Fill (subtle)
      this.map.addLayer({
        id: this._zoneFillLayerId,
        type: 'fill',
        source: this._zoneSourceId,
        paint: {
          'fill-color': 'rgba(246,201,69,0.18)',
          'fill-outline-color': 'rgba(246,201,69,0.95)',
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

    let roster = null
    try {
      roster = (typeof globalThis.xcomGetTeamRoster === 'function') ? globalThis.xcomGetTeamRoster() : null
    } catch (_) {
      roster = null
    }

    const rosterMembers = Array.isArray(roster?.members) ? roster.members : []
    const rosterSquads = Array.isArray(roster?.squads) ? roster.squads : []

    const squadLabelById = new Map()
    for (const s of rosterSquads) {
      const id = String(s?.id ?? '').trim()
      if (!id) continue
      const callsign = String(s?.callsign ?? '').trim()
      const name = String(s?.name ?? '').trim()
      const label = callsign || name
      if (label) squadLabelById.set(id, label)
    }

    const rosterNormalized = rosterMembers
      .map((m) => {
        const unitId = Math.floor(Number(m?.unitId))
        const label = String(m?.label || '').trim()
        const squadId = String(m?.squadId ?? '').trim() || undefined
        const squadLabel = squadId ? String(squadLabelById.get(squadId) || '').trim() : ''
        return { unitId, label, squadId, squadLabel }
      })
      .filter((m) => Number.isFinite(m.unitId) && m.unitId > 0 && m.unitId <= 65535)
      .sort((a, b) => a.unitId - b.unitId)

    const buildUnitMultiSelect = ({ selectId, textId, placeholder, title, tip, sizeMax = 8 }) => {
      if (!rosterNormalized.length) {
        const ph = placeholder ? this.escapeHtml(String(placeholder)) : 'e.g. 12,14,27'
        return `<input id="${textId}" type="text" placeholder="${ph}" />`
      }

      const size = Math.min(sizeMax, Math.max(3, rosterNormalized.length))
      let selectedAny = false

      const groupsById = new Map()
      for (const m of rosterNormalized) {
        const sid = String(m.squadId || '').trim()
        const existing = groupsById.get(sid)
        if (existing) {
          existing.members.push(m)
          continue
        }
        const shortId = sid ? sid.slice(0, 8) : ''
        const squadLabel = sid ? (m.squadLabel || `Squad ${shortId}`) : 'Unassigned'
        groupsById.set(sid, { sid, label: squadLabel, members: [m] })
      }

      const groups = Array.from(groupsById.values())
        .sort((a, b) => {
          if (!a.sid && b.sid) return 1
          if (a.sid && !b.sid) return -1
          return String(a.label || '').localeCompare(String(b.label || ''), undefined, { sensitivity: 'base' })
        })
        .map((g) => ({ ...g, members: g.members.slice().sort((a, b) => a.unitId - b.unitId) }))

      const renderOpt = (m) => {
        const label = m.label || `U${m.unitId}`
        const selected = selectedAny ? '' : ((selectedAny = true), ' selected')
        return `<option value="${m.unitId}"${selected}>U${m.unitId} — ${this.escapeHtml(label)}</option>`
      }

      const opts = groups
        .map((g) => {
          const gl = g.label || (g.sid ? `Squad ${String(g.sid).slice(0, 8)}` : 'Unassigned')
          const inner = g.members.map(renderOpt).join('')
          return `<optgroup label="${this.escapeHtml(gl)}">${inner}</optgroup>`
        })
        .join('')
      const titleAttr = title ? ` title="${this.escapeHtml(String(title))}"` : ''
      const tipHtml = tip ? `<div class="commsSmallMuted">${this.escapeHtml(String(tip))}</div>` : ''
      return `
        <select id="${selectId}" multiple size="${size}"${titleAttr}>
          ${opts}
        </select>
        ${tipHtml}
      `
    }

    const srcPicker = buildUnitMultiSelect({
      selectId: 't_src_units',
      textId: 't_src_units_text',
      placeholder: 'e.g. 12,14,27',
      title: 'Select one or more units for a squad/group packet.',
    })

    const missionTeamPicker = buildUnitMultiSelect({
      selectId: 't_team_units',
      textId: 't_team_units_text',
      placeholder: 'e.g. 12,14,19',
      title: 'Select one or more mission assignees.',
    })

    const commonSrcDstPri = (withDst = true) => `
      <div class="commsGrid2">
        <div class="commsRow"><label>Source Unit(s)</label>${srcPicker}</div>
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
      const unitPicker = buildUnitMultiSelect({
        selectId: 't_units',
        textId: 't_units_text',
        placeholder: 'e.g. 12,14,27',
        title: 'Select one or more units for a squad check-in.',
        tip: 'Tip: select multiple for squad/group check-ins.',
      })

      wrap.innerHTML = `
        <div class="commsRow"><label>Units</label>${unitPicker}</div>
        <div class="commsGrid2">
          <div class="commsRow"><label>Status</label><input id="t_status" type="number" min="0" max="255" step="1" value="0" /></div>
          <div class="commsRow"><label>Time (ms)</label><input id="t_time" type="number" value="${now}" /></div>
        </div>
        <div class="commsGrid2">
          <div class="commsRow"><label>Lat</label><input id="t_lat" type="number" step="0.00001" /></div>
          <div class="commsRow"><label>Lon</label><input id="t_lon" type="number" step="0.00001" /></div>
        </div>
      `
      return
    }

    if (t === 7) {
      wrap.innerHTML = `
        <div class="commsGrid2">
          <div class="commsRow"><label>Source Unit(s)</label>${srcPicker}</div>
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

    if (t === 8) {
      wrap.innerHTML = `
        <div class="commsGrid2">
          <div class="commsRow"><label>Mission ID</label><input id="t_mission_id" type="text" placeholder="(optional)" /></div>
          <div class="commsRow"><label>Status</label>
            <select id="t_mission_status">
              <option value="PLANNED">PLANNED</option>
              <option value="ASSIGNED">ASSIGNED</option>
              <option value="IN_PROGRESS">IN_PROGRESS</option>
              <option value="ON_HOLD">ON_HOLD</option>
              <option value="COMPLETE">COMPLETE</option>
              <option value="ABORTED">ABORTED</option>
            </select>
          </div>
        </div>
        <div class="commsRow"><label>Title</label><input id="t_mission_title" type="text" placeholder="\"Deliver supplies\" / \"Recon\" / ..." /></div>
        <div class="commsGrid2">
          <div class="commsRow"><label>Pri</label><input id="t_pri" type="number" min="0" max="3" step="1" value="0" /></div>
          <div class="commsRow"><label>Team Unit ID(s)</label>${missionTeamPicker}</div>
        </div>
        <div class="commsGrid2">
          <div class="commsRow"><label>Lat</label><input id="t_lat" type="number" step="0.00001" placeholder="" /></div>
          <div class="commsRow"><label>Lon</label><input id="t_lon" type="number" step="0.00001" placeholder="" /></div>
        </div>
        <div class="commsRow"><label>Location label</label><input id="t_location_label" type="text" placeholder="(optional)" /></div>
        <div class="commsGrid2">
          <div class="commsRow"><label>Due At (ms)</label><input id="t_due_at" type="number" value="" placeholder="(optional)" /></div>
          <div class="commsRow"><label>Time (ms)</label><input id="t_time" type="number" value="${now}" /></div>
        </div>
        <div class="commsRow"><label>Notes</label><input id="t_note" type="text" placeholder="(optional)" /></div>
      `
      return
    }

    if (t === 6) {
      wrap.innerHTML = `
        <div class="commsGrid2">
          <div class="commsRow"><label>Source Unit(s)</label>${srcPicker}</div>
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
    const shouldShow = transport === 'Meshtastic' || transport === 'MeshCore'
    btn.style.display = shouldShow ? '' : 'none'
    if (!shouldShow) return

    const meshLabel = transport === 'MeshCore' ? 'MeshCore' : 'Meshtastic'
    const desiredDriver = transport === 'MeshCore' ? 'meshcore' : 'meshtastic'

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
      const connected = !!s?.connected || !!s?.linkConnected
      const driverOk = String(s?.driver || '') === desiredDriver
      ready = connected && driverOk
    } catch (_) {
      ready = false
    }

    btn.textContent = ready ? 'Send via Mesh' : 'Connect + Send'
    btn.title = ready ? `Send packet line(s) directly over ${meshLabel}` : `Connect, then send over ${meshLabel}`
  }

  updateHaLowSendButtonState() {
    const btn = document.getElementById('commsSendHaLowBtn')
    if (!btn) return

    const transport = String(document.getElementById('commsTransport')?.value || '').trim()
    const shouldShow = transport === 'HaLow'
    btn.style.display = shouldShow ? '' : 'none'
    if (!shouldShow) return

    const hasApi =
      globalThis.xcomHaLow &&
      typeof globalThis.xcomHaLow.getState === 'function' &&
      typeof globalThis.halowConnect === 'function' &&
      typeof globalThis.halowSendPacketText === 'function'

    if (!hasApi) {
      btn.disabled = true
      btn.textContent = 'MANET Unavailable'
      btn.title = 'MANET transport not loaded. Reload or open the MANET module once.'
      return
    }

    btn.disabled = false
    let ready = false
    try {
      const s = globalThis.xcomHaLow.getState().status
      ready = !!s?.connected
    } catch (_) {
      ready = false
    }

    btn.textContent = ready ? 'Send via MANET' : 'Connect + Send'
    btn.title = ready ? 'Send packet text over MANET LAN link' : 'Connect, then send over MANET LAN link'
  }

  updateVoiceButtonsState() {
    const transport = String(document.getElementById('commsTransport')?.value || '').trim()
    const shouldShow = transport === 'Voice'

    const ids = ['commsOutputVoiceBtn', 'commsVoiceUnitPriorityBtn', 'commsVoiceRepeatBtn', 'commsVoiceEndBtn']
    for (const id of ids) {
      const el = document.getElementById(id)
      if (!el) continue
      el.style.display = shouldShow ? '' : 'none'
    }

    // If leaving Voice mode, stop any ongoing speech so it doesn't continue without a visible stop button.
    if (!shouldShow) this.stopVoiceTts()
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
    if (templateId === 8) return `X1.8.C.${globalThis.generatePacketId(8)}.1/1.${globalThis.encodeMissionClear(payloadObj)}`
    return `X1.1.C.${globalThis.generatePacketId(8)}.1/1.${globalThis.encodeSitrepClear(payloadObj)}`
  }

  generate() {
    const templateId = Number(document.getElementById('commsTemplate').value)
    const mode = this.getMode()
    const maxChars = this.getTransportMax()

    try {
      const now = Date.now()
      let clearPacket
      let payloadObj

      const readUnitIds = (selectId, textId, max = 32) => {
        let unitIds = []

        const sel = document.getElementById(selectId)
        if (sel && sel.selectedOptions) {
          unitIds = Array.from(sel.selectedOptions)
            .map((o) => Math.floor(Number(o.value)))
            .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535)
        }

        if (unitIds.length === 0) {
          const text = String(document.getElementById(textId)?.value || '').trim()
          unitIds = parseUnitIdListText(text, max)
        }

        return unitIds
      }

      const readSrc = () => {
        const srcIds = readUnitIds('t_src_units', 't_src_units_text', 32)
        const src = srcIds[0] || 0
        if (!Number.isFinite(src) || src <= 0) throw new Error('Pick at least one source unit')
        return { src, srcIds }
      }

      if (templateId === 4) {
        const unitIds = readUnitIds('t_units', 't_units_text', 32)

        const primaryUnitId = unitIds[0] || 0
        if (!Number.isFinite(primaryUnitId) || primaryUnitId <= 0) throw new Error('Pick at least one unit')

        const p = {
          unitId: primaryUnitId,
          ...(unitIds.length > 1 ? { unitIds } : {}),
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
        const { src, srcIds } = readSrc()
        const payload = {
          src,
          ...(srcIds.length > 1 ? { srcIds } : {}),
          t: Number(document.getElementById('t_time').value || Date.now()),
          threat: Number(document.getElementById('t_threat').value || 0),
          meaningCode: Number(document.getElementById('t_meaning').value || 0),
          label: document.getElementById('t_label').value || '',
          note: document.getElementById('t_note').value || '',
          shape: { kind: 'poly', points },
        }
        payloadObj = payload
        clearPacket = `X1.7.C.${window.generatePacketId(8)}.1/1.${window.encodeZoneClear(payload)}`
      } else if (templateId === 8) {
        const tVal = Number(document.getElementById('t_time')?.value || now)
        const ts = (Number.isFinite(tVal) && tVal > 0) ? tVal : now
        const team = readUnitIds('t_team_units', 't_team_units_text', 32)
        const assignedTo = team[0] || 0
        const payload = {
          id: String(document.getElementById('t_mission_id')?.value || '').trim(),
          createdAt: ts,
          updatedAt: ts,
          title: String(document.getElementById('t_mission_title')?.value || '').trim(),
          status: String(document.getElementById('t_mission_status')?.value || 'PLANNED').trim() || 'PLANNED',
          pri: Number(document.getElementById('t_pri')?.value || 0) || 0,
          assignedTo,
          ...(team.length > 1 ? { assignedToList: team } : {}),
          lat: Number(document.getElementById('t_lat')?.value),
          lon: Number(document.getElementById('t_lon')?.value),
          locationLabel: String(document.getElementById('t_location_label')?.value || '').trim(),
          dueAt: Number(document.getElementById('t_due_at')?.value || 0) || 0,
          notes: String(document.getElementById('t_note')?.value || '').trim(),
        }
        payloadObj = payload
        clearPacket = `X1.8.C.${window.generatePacketId(8)}.1/1.${window.encodeMissionClear(payload)}`
      } else if (templateId === 6) {
        const { src, srcIds } = readSrc()
        const payload = {
          src,
          ...(srcIds.length > 1 ? { srcIds } : {}),
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
        const { src, srcIds } = readSrc()
        const payload = {
          src,
          ...(srcIds.length > 1 ? { srcIds } : {}),
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
        const { src, srcIds } = readSrc()
        const payload = {
          src,
          ...(srcIds.length > 1 ? { srcIds } : {}),
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
        const { src, srcIds } = readSrc()
        const payload = {
          src,
          ...(srcIds.length > 1 ? { srcIds } : {}),
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
        const { src, srcIds } = readSrc()
        const payload = {
          src,
          ...(srcIds.length > 1 ? { srcIds } : {}),
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

      // Persist generated packet (full, pre-chunk wrapper) for history + XTOC Data module.
      try {
        const receivedAt = Date.now()
        const key = this.makeXtocPacketStoreKey(parsedFinal)
        const summary = this.summaryFromDecoded(parsedFinal, payloadObj)
        const feats = this.buildImportedFeatures({ key, wrapper: parsedFinal, decodedObj: payloadObj, summary, receivedAt })
        void this.storeXtocPacketToDb({
          key,
          wrapper: parsedFinal,
          decodedObj: payloadObj,
          summary,
          receivedAt,
          source: 'commsOut',
          features: feats,
          hasGeo: feats.length > 0,
        })
      } catch (_) {
        // ignore
      }
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

  stopVoiceTts() {
    try {
      const synth = window.speechSynthesis
      if (!synth) return
      if (!synth.speaking && !synth.pending) return
      this._voiceSession++
      synth.cancel()
    } catch (_) {
      // ignore
    }
  }

  getVoiceTokensForChar(ch) {
    if (ch >= 'A' && ch <= 'Z') return [ch]
    if (ch >= 'a' && ch <= 'z') return ['lowercase', ch.toUpperCase()]
    if (ch >= '0' && ch <= '9') return [ch]

    switch (ch) {
      case '.':
        return ['dot']
      case '/':
        return ['slash']
      case '-':
        return ['dash']
      case '_':
        return ['underscore']
      case ':':
        return ['colon']
      case ';':
        return ['semicolon']
      case ',':
        return ['comma']
      case '=':
        return ['equals']
      case '+':
        return ['plus']
      case ' ':
        return ['space']
      case '\t':
        return ['tab']
      default:
        return ['symbol', ch]
    }
  }

  async pickEnglishVoice() {
    const synth = window.speechSynthesis
    if (!synth) return null

    const lower = (s) => (s ?? '').toLowerCase()
    const findBest = (voices) =>
      voices.find((v) => lower(v.lang) === 'en-us') ?? voices.find((v) => lower(v.lang).startsWith('en')) ?? null

    const initial = synth.getVoices()
    if (initial?.length) return findBest(initial)

    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(done, 800)
      try { synth.addEventListener('voiceschanged', done, { once: true }) } catch (_) { /* ignore */ }
    })

    const voices = synth.getVoices()
    return voices?.length ? findBest(voices) : null
  }

  chunkVoiceTokens(tokens, maxTokensPerChunk = 70) {
    if (tokens.length === 0) return []
    const out = []
    for (let i = 0; i < tokens.length; i += maxTokensPerChunk) out.push(tokens.slice(i, i + maxTokensPerChunk).join(' '))
    return out
  }

  tryGetAnnounceUnitIdFromCurrentOutputText() {
    const text = String(document.getElementById('commsOutput')?.value || '')
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    if (lines.length === 0) return null

    const parsePacket = globalThis.parsePacket
    if (typeof parsePacket !== 'function') return null

    const parsedList = lines.map(parsePacket).filter((p) => !!p)
    if (parsedList.length === 0) return null

    let p = parsedList[0]
    if (parsedList.length > 1) {
      const reassemblePackets = globalThis.reassemblePackets
      if (typeof reassemblePackets !== 'function') return null
      const res = reassemblePackets(parsedList)
      if (!res.ok) return null
      const p2 = parsePacket(res.packet)
      if (!p2) return null
      p = p2
    } else {
      if (p.total > 1) return null
    }

    if (p.mode !== 'C') return null

    const asUnitId = (v) => {
      const n = Math.floor(Number(v))
      return Number.isFinite(n) && n > 0 ? n : null
    }

    try {
      switch (p.templateId) {
        case 1:
          return asUnitId(globalThis.decodeSitrepClear(p.payload).src)
        case 2:
          return asUnitId(globalThis.decodeContactClear(p.payload).src)
        case 3:
          return asUnitId(globalThis.decodeTaskClear(p.payload).src)
        case 4:
          return asUnitId(globalThis.decodeCheckinLocClear(p.payload).unitId)
        case 5:
          return asUnitId(globalThis.decodeResourceClear(p.payload).src)
        case 6:
          return asUnitId(globalThis.decodeAssetClear(p.payload).src)
        case 7:
          return asUnitId(globalThis.decodeZoneClear(p.payload).src)
        default:
          return null
      }
    } catch {
      return null
    }
  }

  async speakPlainText(textToSpeak) {
    const synth = window.speechSynthesis
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      alert('Voice output requires Text-to-Speech (Speech Synthesis). Try Chrome/Edge.')
      return
    }

    // Toggle behavior: click again while speaking to stop.
    if (synth.speaking || synth.pending) {
      this.stopVoiceTts()
      return
    }

    try {
      // Defensive: clear any queued utterances.
      synth.cancel()
    } catch {
      // ignore
    }

    const session = ++this._voiceSession
    const voice = await this.pickEnglishVoice()

    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(textToSpeak)
      u.lang = 'en-US'
      if (voice) u.voice = voice
      // Normal speed for canned phrases.
      u.rate = 1.0
      u.onend = () => resolve()
      u.onerror = () => resolve()
      synth.speak(u)
    })

    // If user stopped mid-utterance, ensure we don't proceed (keeps behavior consistent with outputVoice).
    if (this._voiceSession !== session) return
  }

  async outputVoice() {
    const synth = window.speechSynthesis
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      alert('Voice output requires Text-to-Speech (Speech Synthesis). Try Chrome/Edge.')
      return
    }

    // Toggle behavior: click again while speaking to stop.
    if (synth.speaking || synth.pending) {
      this.stopVoiceTts()
      return
    }

    const lines = String(document.getElementById('commsOutput')?.value || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      alert('Generate a packet first.')
      return
    }

    try {
      // Defensive: clear any queued utterances.
      synth.cancel()
    } catch {
      // ignore
    }

    const session = ++this._voiceSession
    const voice = await this.pickEnglishVoice()

    const speak = (chunk) =>
      new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(chunk)
        u.lang = 'en-US'
        if (voice) u.voice = voice
        // Extremely slow for copy-by-ear workflows.
        u.rate = 0.1
        u.onend = () => resolve()
        u.onerror = () => resolve()
        synth.speak(u)
      })

    const tokens = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const ch of line) tokens.push(...this.getVoiceTokensForChar(ch))
      if (i < lines.length - 1) tokens.push('new', 'line')
    }

    for (const chunk of this.chunkVoiceTokens(tokens, 70)) {
      if (this._voiceSession !== session) break
      await speak(chunk)
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

  async printQr() {
    const out = (document.getElementById('commsOutput').value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    const first = out[0] || ''
    if (!first) {
      alert('Nothing to print. Generate a packet first.')
      return
    }

    if (!globalThis.QRCodeLib || !globalThis.QRCodeLib.QRCode) {
      alert('QRCodeLib not loaded')
      return
    }

    let dataUrl = ''
    try {
      dataUrl = await globalThis.QRCodeLib.QRCode.toDataURL(first, {
        errorCorrectionLevel: 'M',
        margin: 2,
        scale: 10,
        color: { dark: '#000000', light: '#ffffff' },
      })
    } catch (e) {
      console.error(e)
      alert(e?.message || String(e))
      return
    }

    const overlayId = 'xcomPrintQrOverlay'
    const styleId = 'xcomPrintQrStyle'

    const cleanup = () => {
      try { delete document.body.dataset.xcomPrintQr } catch (_) { /* ignore */ }
      try { document.getElementById(overlayId)?.remove() } catch (_) { /* ignore */ }
      try { document.getElementById(styleId)?.remove() } catch (_) { /* ignore */ }
    }

    try {
      cleanup()

      const overlay = document.createElement('div')
      overlay.id = overlayId
      overlay.style.display = 'none'

      const img = document.createElement('img')
      img.alt = 'QR Code'
      img.src = dataUrl
      overlay.appendChild(img)

      const style = document.createElement('style')
      style.id = styleId
      style.textContent = `
@page { margin: 4mm; }
@media print {
  body[data-xcom-print-qr="1"] * { display: none !important; }
  body[data-xcom-print-qr="1"] #${overlayId} { display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: flex-start !important; background: #fff !important; }
  body[data-xcom-print-qr="1"] #${overlayId} img { display: block !important; width: 100% !important; max-width: 180mm !important; height: auto !important; image-rendering: pixelated !important; }
}
      `.trim()

      document.head.appendChild(style)
      document.body.appendChild(overlay)

      if (!img.complete) {
        if (typeof img.decode === 'function') {
          try { await img.decode() } catch (_) { /* ignore */ }
        }
      }
      if (!img.complete) {
        await new Promise((resolve, reject) => {
          const onLoad = () => resolve()
          const onError = () => reject(new Error('QR image failed to load'))
          img.addEventListener('load', onLoad, { once: true })
          img.addEventListener('error', onError, { once: true })
        })
      }

      document.body.dataset.xcomPrintQr = '1'
      window.addEventListener('afterprint', cleanup, { once: true })
      setTimeout(() => {
        try {
          if (document.body.dataset.xcomPrintQr === '1') cleanup()
        } catch (_) {
          // ignore
        }
      }, 600_000)

      if (typeof requestAnimationFrame === 'function') {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      window.focus()
      window.print()
    } catch (e) {
      cleanup()
      alert(e?.message || String(e))
    }
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
    const meshLabel = transport === 'MeshCore' ? 'MeshCore' : 'Meshtastic'
    const desiredDriver = transport === 'MeshCore' ? 'meshcore' : 'meshtastic'

    if (transport !== 'Meshtastic' && transport !== 'MeshCore') {
      alert('Set Transport to Meshtastic or MeshCore first.')
      return
    }

    // Keep mesh driver aligned with the selected transport profile.
    try {
      if (typeof globalThis.setMeshConfig === 'function') {
        globalThis.setMeshConfig({ driver: desiredDriver })
      }
    } catch (_) {
      // ignore
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
      const connected = !!s?.connected || !!s?.linkConnected
      const driverOk = String(s?.driver || '') === desiredDriver
      const ready = connected && driverOk
      if (!ready) {
        const prompt = connected && !driverOk
          ? `Mesh is connected using ${String(s?.driver || 'unknown')}, but Transport is set to ${meshLabel}.\n\nSwitch and reconnect now?`
          : `Mesh not connected.\n\nConnect now?`
        const ok = confirm(prompt)
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
      const connected = !!s?.connected || !!s?.linkConnected
      const driverOk = String(s?.driver || '') === desiredDriver
      const ready = connected && driverOk
      this.updateMeshSendButtonState()
      if (!ready) {
        alert(`Mesh not connected to ${meshLabel}. Open Mesh and click Connect first.`)
        return
      }
    }

    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (lines.length === 0) {
      alert('Nothing to send')
      return
    }

    const parseFn = window.parsePacket
    const chunkFn = globalThis.chunkPacketByMaxChars
    const parsedList = typeof parseFn === 'function' ? lines.map((l) => parseFn(l)).filter(Boolean) : []
    if (parsedList.length === 0) {
      alert('Paste or generate a valid XCOM packet wrapper first.')
      return
    }

    // Chunk any single-part wrappers to the selected transport max so sends are reliable.
    const meshMax = window.getTransportMaxPacketChars ? window.getTransportMaxPacketChars(transport) : (transport === 'MeshCore' ? 160 : 180)
    const sendLines = []

    if (lines.length === 1 && parsedList.length === 1) {
      const p = parsedList[0]
      if (p && Number(p.total) > 1) {
        const ok = confirm(`This looks like 1 part of a multi-part packet (${p.part}/${p.total}).\n\nSend this part anyway?`)
        if (!ok) return
      }
    }

    for (const p of parsedList) {
      if (!p) continue
      const raw = String(p.raw || '').trim()
      if (!raw) continue

      // Already multi-part: send as-is (user likely has all parts in Output).
      if (Number(p.total) > 1) {
        sendLines.push(raw)
        continue
      }

      // Single-part wrapper: chunk if it exceeds the target.
      if (raw.length > meshMax && typeof chunkFn === 'function') {
        try {
          const parts = chunkFn(p, meshMax)
          if (Array.isArray(parts) && parts.length > 0) {
            for (const part of parts) {
              const t = String(part || '').trim()
              if (t) sendLines.push(t)
            }
            continue
          }
        } catch (_) {
          // ignore
        }
      }

      sendLines.push(raw)
    }

    if (sendLines.length === 0) {
      alert('Nothing to send')
      return
    }

    // Confirm batch sends so users don't accidentally spam the mesh.
    if (sendLines.length > 1) {
      const ok = confirm(`Send ${sendLines.length} line(s) via mesh? (Each line is sent as its own ${meshLabel} message.)`)
      if (!ok) return
    }

    // Guard: MeshCore hard limit is 160 bytes; Meshtastic can truncate on long payloads.
    const overMax = sendLines.find((l) => String(l || '').length > meshMax)
    if (overMax && transport === 'MeshCore') {
      alert(`One or more lines exceed the MeshCore limit (${meshMax}).\n\nChoose a shorter template/note, or use a different transport.`)
      return
    }
    const tooLong = sendLines.find((l) => String(l || '').length > 200)
    if (tooLong && transport === 'Meshtastic') {
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

  async sendViaHaLow() {
    const formatHaLowError = (e) => {
      if (e == null) return 'Unknown error'
      if (typeof e === 'string') return e
      if (typeof e === 'number' || typeof e === 'boolean' || typeof e === 'bigint') return String(e)
      if (e instanceof Error) return e.message ? `${e.name}: ${e.message}` : e.name
      try {
        const json = JSON.stringify(e)
        return json && json !== '{}' ? json : Object.prototype.toString.call(e)
      } catch (_) {
        return Object.prototype.toString.call(e)
      }
    }

    const transport = String(document.getElementById('commsTransport')?.value || '').trim()
    if (transport !== 'HaLow') {
      alert('Set Transport to MANET first.')
      return
    }

    const text = String(document.getElementById('commsOutput').value || '').trim()
    if (!text) {
      alert('Nothing to send. Generate a packet first.')
      return
    }

    const halow = globalThis.xcomHaLow
    const canConnect = typeof globalThis.halowConnect === 'function'
    const canSend = typeof globalThis.halowSendPacketText === 'function'
    if (!halow || typeof halow.getState !== 'function' || !canConnect || !canSend) {
      alert('MANET transport not available. Reload or open the MANET module once.')
      return
    }

    // If not connected, prompt to connect.
    try {
      const s = halow.getState().status
      const ready = !!s?.connected
      if (!ready) {
        const ok = confirm('MANET not connected.\n\nConnect now?')
        if (!ok) return
        try {
          await globalThis.halowConnect()
        } catch (e) {
          this.updateHaLowSendButtonState()
          alert(`MANET connect failed: ${formatHaLowError(e)}`)
          return
        }
      }
    } catch (_) {
      // ignore
    }

    // Re-check ready
    {
      const s = halow.getState().status
      const ready = !!s?.connected
      this.updateHaLowSendButtonState()
      if (!ready) {
        alert('MANET not connected. Open MANET and click Connect first.')
        return
      }
    }

    // Basic validation: ensure at least one wrapper line is present.
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const parsedList = typeof window.parsePacket === 'function' ? lines.map((l) => window.parsePacket(l)).filter(Boolean) : []
    if (parsedList.length === 0) {
      alert('Paste or generate a valid XCOM packet wrapper first.')
      return
    }

    if (text.length > 180000) {
      const ok = confirm('This payload is very large and may be rejected by the bridge.\n\nSend anyway?')
      if (!ok) return
    }

    try {
      await globalThis.halowSendPacketText(text)
      window.radioApp.updateStatus('Sent via MANET')
      this.updateHaLowSendButtonState()
    } catch (e) {
      console.error(e)
      this.updateHaLowSendButtonState()
      alert(`MANET send failed: ${formatHaLowError(e)}`)
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
    try { this.updateImportToMapButtonState(null) } catch (_) { /* ignore */ }
    try { window.radioApp?.updateStatus?.('Import cleared') } catch (_) { /* ignore */ }
  }

  refreshImportedRawList() {
    const el = document.getElementById('commsImportedRaw')
    if (!el) return
    if (typeof globalThis.getImportedPackets !== 'function') {
      el.value = ''
      return
    }
    try {
      const entries = globalThis.getImportedPackets()
      const lines = Array.isArray(entries)
        ? entries.map((e) => String(e?.raw || '').trim()).filter(Boolean)
        : []
      el.value = lines.join('\n')
    } catch (_) {
      el.value = ''
    }
  }

  async copyImportedRaw() {
    const text = String(document.getElementById('commsImportedRaw')?.value || '').trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      window.radioApp.updateStatus('Copied imported list')
    } catch (_) {
      alert('Clipboard copy failed (browser permissions).')
    }
  }

  clearImported() {
    const ok = confirm('Clear Imported overlay packets from this device?\n\nThis only clears the Map Imported overlay list (localStorage). Stored packets in XTOC Data remain.')
    if (!ok) return
    if (typeof globalThis.clearImportedPackets !== 'function') {
      alert('Imported storage helpers not loaded')
      return
    }
    try {
      globalThis.clearImportedPackets()
      this.refreshImportedRawList()
      window.radioApp.updateStatus('Imported overlay cleared')
    } catch (e) {
      alert(e?.message || String(e))
    }
  }

  // -----------------------------
  // Team roster import (XTOC-TEAM bundle)
  // -----------------------------

  parseTeamRosterBundle(text) {
    const t = String(text || '').trim()
    if (!t.startsWith('XTOC-TEAM.')) return null
    try {
      const json = atob(t.slice('XTOC-TEAM.'.length))
      const obj = JSON.parse(json)
      if (obj?.v !== 1) return null
      if (!Array.isArray(obj?.members)) return null
      return obj
    } catch (_) {
      return null
    }
  }

  importTeamRoster(opts = {}) {
    const quiet = !!opts.quiet
    const input = document.getElementById('commsTeamBundle')
    const text = String(input?.value || '').trim()
    if (!text) {
      if (!quiet) alert('Paste an XTOC-TEAM bundle first.')
      return
    }

    const b = this.parseTeamRosterBundle(text)
    if (!b) {
      if (!quiet) alert('Invalid roster bundle. Expected: XTOC-TEAM.<base64(json)>')
      return
    }

    if (typeof globalThis.xcomUpsertRosterMembers !== 'function') {
      if (!quiet) alert('Roster helpers not loaded')
      return
    }

    const res = globalThis.xcomUpsertRosterMembers(b.members, { replace: false })
    if (!res?.ok) {
      if (!quiet) alert(res?.reason || 'Roster import failed')
      return
    }

    // Optional: squad metadata (if provided by XTOC).
    try {
      if (Array.isArray(b?.squads) && typeof globalThis.xcomUpsertSquads === 'function') {
        globalThis.xcomUpsertSquads(b.squads, { replace: false })
      }
    } catch (_) {
      // ignore
    }

    try { input.value = '' } catch (_) { /* ignore */ }
    this.updateRosterStatus()
    if (!quiet) alert(`Imported roster: ${res.total} member(s).`)
  }

  updateRosterStatus() {
    const el = document.getElementById('commsRosterStatus')
    if (!el) return

    if (typeof globalThis.xcomGetTeamRoster !== 'function') {
      el.textContent = 'Roster: helpers not loaded'
      return
    }

    let roster = null
    try { roster = globalThis.xcomGetTeamRoster() } catch (_) { roster = null }
    const members = Array.isArray(roster?.members) ? roster.members : []
    const squads = Array.isArray(roster?.squads) ? roster.squads : []
    const updatedAt = Number(roster?.updatedAt || 0) || 0

    if (members.length === 0) {
      el.textContent = 'Roster: none loaded'
      return
    }

    let when = '—'
    if (updatedAt > 0) {
      try { when = new Date(updatedAt).toLocaleString() } catch (_) { when = '—' }
    }

    const squadText = squads.length ? `, ${squads.length} squad(s)` : ''
    el.textContent = `Roster: ${members.length} member(s)${squadText} loaded (${when})`
  }

  clearRoster() {
    const ok = confirm('Clear roster labels from this device?\n\nThis only removes friendly label mapping (no packets/keys).')
    if (!ok) return

    try {
      if (typeof globalThis.xcomClearTeamRoster === 'function') globalThis.xcomClearTeamRoster()
    } catch (_) {
      // ignore
    }
    this.updateRosterStatus()
  }

  async scanTeamQr() {
    if (!globalThis.QrScanner) {
      alert('QrScanner not loaded')
      return
    }

    const overlay = document.createElement('div')
    overlay.className = 'commsQrOverlay'
    overlay.innerHTML = `
      <div class="commsQrModal">
        <div class="commsQrModalTitle">Scan Team QR</div>
        <video id="commsTeamQrVideo"></video>
        <div class="commsButtonRow">
          <button id="commsTeamQrStopBtn" type="button" class="danger">Stop</button>
        </div>
      </div>
    `
    document.body.appendChild(overlay)
    const video = overlay.querySelector('#commsTeamQrVideo')
    const stopBtn = overlay.querySelector('#commsTeamQrStopBtn')

    let scanner = null
    const stop = () => {
      try { scanner && scanner.stop() } catch (_) { /* ignore */ }
      try { overlay.remove() } catch (_) { /* ignore */ }
    }

    try {
      globalThis.QrScanner.WORKER_PATH = 'assets/vendor/qr-scanner-worker.min.js'
      scanner = new globalThis.QrScanner(
        video,
        (result) => {
          const text = (result && result.data) ? result.data : String(result)
          const trimmed = String(text || '').trim()

          if (trimmed.startsWith('XTOC-TEAM.')) {
            document.getElementById('commsTeamBundle').value = trimmed
            try {
              this.importTeamRoster()
            } finally {
              stop()
            }
            return
          }

          // Be helpful if they scanned a key or packet instead.
          if (trimmed.startsWith('XTOC-KEY.')) {
            document.getElementById('commsKeyBundle').value = trimmed
            try {
              this.importKey()
            } finally {
              stop()
            }
            return
          }

          if (trimmed.startsWith('X1.')) {
            document.getElementById('commsImportText').value = trimmed
            this.reassembleAndDecode()
            stop()
            return
          }

          alert('QR did not look like an XTOC-TEAM roster bundle.')
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
  // XTOC backup import (xtoc-backup-*.json)
  // -----------------------------

  setXtocImportStatus(text) {
    const el = document.getElementById('commsXtocImportStatus')
    if (el) el.textContent = String(text || '').trim()
  }

  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      try {
        if (file && typeof file.text === 'function') {
          file.text().then(resolve, reject)
          return
        }
      } catch (_) {
        // ignore, fall back to FileReader
      }

      const r = new FileReader()
      r.onerror = () => reject(r.error ?? new Error('Failed to read file'))
      r.onload = () => resolve(String(r.result ?? ''))
      r.readAsText(file)
    })
  }

  parseXtocBackupJson(jsonText) {
    const obj = JSON.parse(String(jsonText || '')) || null
    if (!obj || typeof obj !== 'object') throw new Error('Invalid backup JSON (not an object).')
    if (obj.v !== 1 || obj.app !== 'xtoc') throw new Error('Not an XTOC backup file (expected v=1 app=xtoc).')
    if (!Array.isArray(obj.members) || !Array.isArray(obj.teamKeys) || !Array.isArray(obj.packets)) {
      throw new Error('Invalid XTOC backup file (missing arrays).')
    }
    return obj
  }

  async importXtocBackupObject(backup) {
    const members = Array.isArray(backup?.members) ? backup.members : []
    const squads = Array.isArray(backup?.squads) ? backup.squads : []
    const teamKeys = Array.isArray(backup?.teamKeys) ? backup.teamKeys : []
    const packets = Array.isArray(backup?.packets) ? backup.packets : []

    // 0) Squads (optional metadata)
    try {
      if (squads.length && typeof globalThis.xcomUpsertSquads === 'function') {
        globalThis.xcomUpsertSquads(squads, { replace: false })
      }
    } catch (_) {
      // ignore
    }

    // 1) Roster (full member records)
    let rosterTotal = 0
    try {
      if (typeof globalThis.xcomUpsertRosterMembers === 'function') {
        const res = globalThis.xcomUpsertRosterMembers(members, { replace: false })
        if (res?.ok) rosterTotal = Number(res.total || 0) || 0
      }
    } catch (_) {
      rosterTotal = 0
    }

    // 2) Team keys
    let keysImported = 0
    let keysFailed = 0
    if (typeof globalThis.putTeamKey === 'function') {
      for (const k of teamKeys) {
        try {
          const teamId = String(k?.teamId || '').trim()
          const kid = Number(k?.kid)
          const keyB64Url = String(k?.keyB64Url || '').trim()
          if (!teamId || !Number.isFinite(kid) || !keyB64Url) {
            keysFailed++
            continue
          }
          globalThis.putTeamKey(teamId, kid, keyB64Url)
          keysImported++
        } catch (_) {
          keysFailed++
        }
      }
    }

    // 3) Packets: store ALL packets in IndexedDB, and add geo packets to the Imported overlay
    let packetsParsed = 0
    let packetsStored = 0
    let packetsStoreSkipped = 0
    let packetsNoGeo = 0
    let markersAdded = 0
    let markersDup = 0
    let zoneDecoded = 0
    let zoneDecodeFailed = 0

    const parse = globalThis.parsePacket
    const canStore = typeof globalThis.xcomPutXtocPackets === 'function'
    const canOverlay = typeof globalThis.addImportedPackets === 'function' || typeof globalThis.addImportedPacket === 'function'

    const toStore = []
    const toOverlay = []

    for (const rec of packets) {
      const raw = String(rec?.raw || '').trim()
      if (!raw) continue
      if (typeof parse !== 'function') continue
      const wrapper = parse(raw)
      if (!wrapper) continue
      packetsParsed++

      const key = this.makeXtocPacketStoreKey(wrapper)
      const receivedAt = Number(rec?.createdAt || 0) || Number(backup?.exportedAt || 0) || Date.now()
      const summaryFromBackup = String(rec?.summary || '').trim()
      let summary = summaryFromBackup
      if (!summary) {
        const modeLabel = wrapper?.mode === 'S' ? 'SECURE' : 'CLEAR'
        summary = `${this.templateName(wrapper?.templateId)} (${modeLabel}) ID ${String(wrapper?.id || '').trim()}`.trim()
      }

      let decodedObj = null
      let decodeError = ''
      let features = []
      let hasGeo = false

      // Zones require decode to get geometry.
      if (Number(wrapper?.templateId) === 7) {
        try {
          decodedObj = this.decodeParsedWrapper(wrapper)
          zoneDecoded++
          if (!summaryFromBackup) summary = this.summaryFromDecoded(wrapper, decodedObj)
          features = this.buildImportedFeatures({ key, wrapper, decodedObj, summary, receivedAt })
          hasGeo = Array.isArray(features) && features.length > 0
        } catch (e) {
          zoneDecodeFailed++
          decodeError = e?.message ? String(e.message) : String(e)
          features = []
          hasGeo = false
        }
      } else {
        // Location-bearing templates: use the lat/lon that XTOC already normalized into the backup record.
        const lat = Number(rec?.lat)
        const lon = Number(rec?.lon)
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          hasGeo = true
          const mode = wrapper?.mode === 'S' ? 'S' : 'C'
          const kid = mode === 'S' ? Number(wrapper?.kid) : undefined
          const baseProps = {
            source: 'imported',
            templateId: Number(wrapper?.templateId) || 0,
            mode,
            packetId: String(wrapper?.id || '').trim(),
            kid: Number.isFinite(kid) ? kid : undefined,
            summary,
            note: raw,
            receivedAt,
            ...this.keyStatusForWrapper(wrapper),
          }
          features = [
            {
              type: 'Feature',
              id: `imported:${key}:loc`,
              geometry: { type: 'Point', coordinates: [lon, lat] },
              properties: { ...baseProps, kind: 'loc' },
            },
          ]
        }
      }

      if (!hasGeo) packetsNoGeo++

      // Store packet (even without geo)
      toStore.push({
        key,
        templateId: Number(wrapper?.templateId) || 0,
        mode: wrapper?.mode === 'S' ? 'S' : 'C',
        id: String(wrapper?.id || '').trim(),
        ...(wrapper?.mode === 'S' && Number.isFinite(Number(wrapper?.kid)) ? { kid: Number(wrapper.kid) } : {}),
        ...this.keyStatusForWrapper(wrapper),
        part: Number(wrapper?.part) || 1,
        total: Number(wrapper?.total) || 1,
        raw,
        storedAt: Date.now(),
        receivedAt,
        source: 'xtocBackup',
        summary,
        ...(decodedObj ? { decoded: decodedObj } : {}),
        ...(decodeError ? { decodeError } : {}),
        hasGeo,
        features: Array.isArray(features) ? features : [],
      })

      // Map overlay (Imported) - batch to avoid N localStorage rewrites for large imports.
      if (hasGeo && canOverlay) {
        toOverlay.push({
          key,
          raw,
          templateId: wrapper.templateId,
          mode: wrapper.mode,
          packetId: wrapper.id,
          kid: wrapper.mode === 'S' ? wrapper.kid : undefined,
          summary,
          features,
        })
      }
    }

    if (canOverlay && toOverlay.length > 0) {
      try {
        if (typeof globalThis.addImportedPackets === 'function') {
          const addRes = globalThis.addImportedPackets(toOverlay)
          if (addRes?.ok) {
            markersAdded = Number(addRes.added || 0) || 0
            markersDup = Number(addRes.dup || 0) || 0
          }
        } else if (typeof globalThis.addImportedPacket === 'function') {
          for (const e of toOverlay) {
            try {
              const addRes = globalThis.addImportedPacket(e)
              if (addRes?.ok) {
                if (addRes.added) markersAdded++
                else markersDup++
              }
            } catch (_) {
              // ignore
            }
          }
        }
      } catch (_) {
        // ignore
      }
    }

    if (canStore && toStore.length > 0) {
      const putRes = await globalThis.xcomPutXtocPackets(toStore, { mergeSources: true })
      if (putRes?.ok) {
        packetsStored = Number(putRes.put || 0) || 0
        packetsStoreSkipped = Number(putRes.skipped || 0) || 0
        this.notifyXtocPacketsUpdated()
      } else {
        packetsStored = 0
        packetsStoreSkipped = toStore.length
      }
    }

    return {
      ok: true,
      rosterTotal,
      keysImported,
      keysFailed,
      packetsParsed,
      packetsStored,
      packetsStoreSkipped,
      packetsNoGeo,
      markersAdded,
      markersDup,
      zoneDecoded,
      zoneDecodeFailed,
    }
  }

  async importXtocBackup() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0]
      if (!file) return

      try {
        this.setXtocImportStatus('Importing...')
        const text = await this.readFileAsText(file)
        const backup = this.parseXtocBackupJson(text)
        const res = await this.importXtocBackupObject(backup)

        // Refresh UI bits that rely on localStorage
        try { this.updateKeySummary() } catch (_) { /* ignore */ }
        try { this.updateRosterStatus() } catch (_) { /* ignore */ }
        try { this.refreshImportedRawList() } catch (_) { /* ignore */ }

        const msg =
          `Imported XTOC backup: ` +
          `${res.rosterTotal ? `${res.rosterTotal} roster member(s), ` : ''}` +
          `${res.keysImported} key(s), ` +
          `${res.packetsStored || 0} packet(s), ` +
          `${res.markersAdded} marker(s)` +
          `${res.markersDup ? ` (${res.markersDup} already present)` : ''}.`

        this.setXtocImportStatus(msg)
        alert(msg)
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e)
        this.setXtocImportStatus(`Import failed: ${msg}`)
        alert(msg)
      } finally {
        try { input.value = '' } catch (_) { /* ignore */ }
      }
    }, { once: true })

    input.click()
  }

  scheduleImportRefresh() {
    if (this._importParseTimer) {
      try { clearTimeout(this._importParseTimer) } catch (_) { /* ignore */ }
    }
    this._importParseTimer = setTimeout(() => {
      this._importParseTimer = null
      try { this.refreshImportMessageList({ keepSelection: true, preferLatestComplete: false }) } catch (_) { /* ignore */ }
      try { this.updateImportToMapButtonState(null) } catch (_) { /* ignore */ }
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
      case 8: return 'MISSION'
      default: return `T=${String(templateId)}`
    }
  }

  notifyXtocPacketsUpdated() {
    try {
      globalThis.dispatchEvent(new Event('xcomXtocPacketsUpdated'))
    } catch (_) {
      // ignore
    }
  }

  makeXtocPacketStoreKey(wrapper) {
    const tpl = Number(wrapper?.templateId) || 0
    const mode = wrapper?.mode === 'S' ? 'S' : 'C'
    const id = String(wrapper?.id || '').trim()
    const kid = mode === 'S' ? Number(wrapper?.kid) : undefined

    if (mode === 'S' && Number.isFinite(kid)) return `X1:${tpl}:${mode}:${id}:${kid}`
    return `X1:${tpl}:${mode}:${id}`
  }

  keyStatusForWrapper(wrapper) {
    try {
      const mode = wrapper?.mode === 'S' ? 'S' : 'C'
      if (mode !== 'S') return {}

      const packetKid = Number(wrapper?.kid)
      if (!Number.isFinite(packetKid) || packetKid <= 0) return {}

      const activeKey = window.getCommsActiveKey ? window.getCommsActiveKey() : null
      const activeKid = activeKey ? Number(activeKey.kid) : NaN
      if (!Number.isFinite(activeKid) || activeKid <= 0) return {}

      if (packetKid === activeKid) return {}
      return { nonActiveKey: true, activeKidAtStore: activeKid }
    } catch (_) {
      return {}
    }
  }

  packetAtFromDecoded(wrapper, decodedObj) {
    try {
      const tpl = Number(wrapper?.templateId) || 0
      if (!decodedObj || typeof decodedObj !== 'object') return null
      const n = tpl === 8 ? Number(decodedObj?.updatedAt) : Number(decodedObj?.t)
      return Number.isFinite(n) && n > 0 ? n : null
    } catch (_) {
      return null
    }
  }

  async storeXtocPacketToDb(args) {
    if (typeof globalThis.xcomPutXtocPacket !== 'function') return { ok: false, reason: 'Packet store helpers not loaded' }

    const wrapper = args?.wrapper
    const raw = String(wrapper?.raw || '').trim()
    if (!raw) return { ok: false, reason: 'Missing wrapper raw' }

    const storedAt = Date.now()
    const receivedAt = Number(args?.receivedAt || 0) || storedAt

    const templateId = Number(wrapper?.templateId) || 0
    const mode = wrapper?.mode === 'S' ? 'S' : 'C'
    const packetId = String(wrapper?.id || '').trim()
    const kid = mode === 'S' ? Number(wrapper?.kid) : undefined

    const packetAt = this.packetAtFromDecoded(wrapper, args?.decodedObj)

    const decodeError = args?.decodeError ? String(args.decodeError) : ''
    const features = Array.isArray(args?.features) ? args.features : []
    const hasGeo = args?.hasGeo === true ? true : (features.length > 0)

    const rec = {
      key: String(args?.key || this.makeXtocPacketStoreKey(wrapper)),
      templateId,
      mode,
      id: packetId,
      ...(mode === 'S' && Number.isFinite(kid) ? { kid } : {}),
      ...this.keyStatusForWrapper(wrapper),
      part: Number(wrapper?.part) || 1,
      total: Number(wrapper?.total) || 1,
      raw,
      storedAt,
      receivedAt,
      ...(packetAt != null ? { packetAt } : {}),
      source: String(args?.source || 'unknown'),
      ...(args?.summary ? { summary: String(args.summary) } : {}),
      ...(args?.decodedObj ? { decoded: args.decodedObj } : {}),
      ...(decodeError ? { decodeError } : {}),
      hasGeo,
      features,
    }

    const res = await globalThis.xcomPutXtocPacket(rec)
    if (res?.ok && args?.notify !== false) this.notifyXtocPacketsUpdated()
    return res
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

  summaryFromDecoded(wrapper, decoded) {
    const tpl = Number(wrapper?.templateId) || 0
    const isSecure = wrapper?.mode === 'S'

    const priLabel = (n) => {
      const i = Math.max(0, Math.min(3, Math.floor(Number(n) || 0)))
      return ['P1', 'P2', 'P3', 'UNK'][i] || 'UNK'
    }
    const statusLabel = (n) => {
      const i = Math.max(0, Math.min(3, Math.floor(Number(n) || 0)))
      return ['OK', 'HELP', 'RTB', 'UNK'][i] || 'UNK'
    }

    const srcLabel = (d) => {
      const ids = Array.isArray(d?.srcIds) && d.srcIds.length ? d.srcIds : (d?.src != null ? [d.src] : [])
      const out = []
      const seen = new Set()
      for (const v of ids) {
        const n = Math.floor(Number(v))
        if (!Number.isFinite(n) || n <= 0) continue
        if (seen.has(n)) continue
        seen.add(n)
        out.push(n)
      }
      return out.length ? out.map((n) => `U${n}`).join(',') : ''
    }

    if (tpl === 4) {
      const unitId = Number(decoded?.unitId)
      const unitIds = Array.isArray(decoded?.unitIds) && decoded.unitIds.length
        ? decoded.unitIds
        : (Number.isFinite(unitId) ? [unitId] : [])
      const unitsLabel = unitIds.length ? unitIds.map((n) => `U${n}`).join(',') : ''
      const lat = Number(decoded?.lat)
      const lon = Number(decoded?.lon)
      if (isSecure) return `SECURE CHECKIN ${unitsLabel}`.trim()
      if (Number.isFinite(lat) && Number.isFinite(lon) && unitIds.length) {
        return `CHECKIN ${unitsLabel} ${lat.toFixed(4)},${lon.toFixed(4)}`.trim()
      }
      return `CHECKIN${unitsLabel ? ` ${unitsLabel}` : ''}`.trim()
    }

    if (tpl === 1) {
      const pri = priLabel(decoded?.pri)
      const st = statusLabel(decoded?.status)
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const dst = Number(decoded?.dst)
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `${pri} ${st} FROM${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} TO ${dst === 0 ? 'ALL' : `U${Number.isFinite(dst) ? dst : ''}`}`.trim()
      if (isSecure) return `SECURE ${head}`.trim()
      return `${head}${note ? ` — ${note}` : ''}`.trim()
    }

    if (tpl === 2) {
      const pri = priLabel(decoded?.pri)
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const typeCode = Number(decoded?.typeCode)
      const count = Number(decoded?.count)
      const dir = Number(decoded?.dir)
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `${pri} CONTACT${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} type=${Number.isFinite(typeCode) ? typeCode : ''} count=${Number.isFinite(count) ? count : ''} dir=${Number.isFinite(dir) ? dir : ''}`.trim()
      if (isSecure) return `SECURE ${head}`.trim()
      return `${head}${note ? ` — ${note}` : ''}`.trim()
    }

    if (tpl === 3) {
      const pri = priLabel(decoded?.pri)
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const dst = Number(decoded?.dst)
      const actionCode = Number(decoded?.actionCode)
      const dueMins = Number(decoded?.dueMins)
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `${pri} TASK${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''}→${dst === 0 ? 'ALL' : `U${Number.isFinite(dst) ? dst : ''}`} action=${Number.isFinite(actionCode) ? actionCode : ''} due=${Number.isFinite(dueMins) ? dueMins : ''}m`.trim()
      if (isSecure) return `SECURE ${head}`.trim()
      return `${head}${note ? ` — ${note}` : ''}`.trim()
    }

    if (tpl === 5) {
      const pri = priLabel(decoded?.pri)
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const itemCode = Number(decoded?.itemCode)
      const qty = Number(decoded?.qty)
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `${pri} RESOURCE${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} item=${Number.isFinite(itemCode) ? itemCode : ''} qty=${Number.isFinite(qty) ? qty : ''}`.trim()
      if (isSecure) return `SECURE ${head}`.trim()
      return `${head}${note ? ` — ${note}` : ''}`.trim()
    }

    if (tpl === 6) {
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const condition = Number(decoded?.condition)
      const typeCode = Number(decoded?.typeCode)
      const label = String(decoded?.label || '').trim()
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `ASSET${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} cond=${Number.isFinite(condition) ? condition : ''} type=${Number.isFinite(typeCode) ? typeCode : ''}`.trim()
      if (isSecure) return `SECURE ${head}${label ? ` \"${label}\"` : ''}`.trim()
      return `${head}${label ? ` \"${label}\"` : ''}${note ? ` — ${note}` : ''}`.trim()
    }

    if (tpl === 7) {
      const threat = Number(decoded?.threat)
      const meaningCode = Number(decoded?.meaningCode)
      const label = String(decoded?.label || '').trim()
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)

      const threatLabel = ['SAFE', 'DANGER', 'UNKNOWN'][Math.max(0, Math.min(2, Math.floor(threat || 0)))] || 'UNKNOWN'
      const head = `${threatLabel} ZONE${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} meaning=${Number.isFinite(meaningCode) ? meaningCode : ''}`.trim()

      if (isSecure) return `SECURE ${head}${label ? ` \"${label}\"` : ''}`.trim()
      return `${head}${label ? ` \"${label}\"` : ''}${note ? ` — ${note}` : ''}`.trim()
    }

    if (tpl === 8) {
      const pri = priLabel(decoded?.pri)
      const status = String(decoded?.status || '').trim() || 'PLANNED'
      const missionId = String(decoded?.id || '').trim()
      const title = String(decoded?.title || '').trim()
      const notes = !isSecure && decoded?.notes ? String(decoded.notes).trim() : ''

      const head = `${pri} ${status} MISSION`.trim()
      const mid = missionId ? ` ${missionId}` : ''
      const team = Array.isArray(decoded?.assignedToList)
        ? decoded.assignedToList
        : (decoded?.assignedTo ? [decoded.assignedTo] : [])
      const teamText = team.length ? ` -> ${team.map((n) => `U${Math.floor(Number(n))}`).join(',')}` : ''
      const quotedTitle = (title ? ` \"${title}\"` : '') + teamText

      if (isSecure) return `SECURE ${head}${mid}${quotedTitle}`.trim()
      return `${head}${mid}${quotedTitle}${notes ? ` — ${notes}` : ''}`.trim()
    }

    const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
    return `${isSecure ? 'SECURE ' : ''}T=${String(tpl || '')}${note ? ` — ${note}` : ''}`.trim()
  }

  buildImportedFeatures(args) {
    const key = String(args?.key || '')
    const wrapper = args?.wrapper
    const decodedObj = args?.decodedObj
    const summary = String(args?.summary || '').trim()
    const receivedAtRaw = Number(args?.receivedAt || 0)
    const receivedAt = (Number.isFinite(receivedAtRaw) && receivedAtRaw > 0) ? receivedAtRaw : Date.now()

    const t = Number(wrapper?.templateId)
    const mode = wrapper?.mode === 'S' ? 'S' : 'C'
    const packetId = String(wrapper?.id || '').trim()
    const kid = mode === 'S' ? Number(wrapper?.kid) : undefined
    const raw = String(wrapper?.raw || '').trim()

    const packetAt = this.packetAtFromDecoded(wrapper, decodedObj)

    const baseProps = {
      source: 'imported',
      templateId: Number.isFinite(t) ? t : 0,
      mode,
      packetId,
      kid: Number.isFinite(kid) ? kid : undefined,
      summary,
      note: raw,
      receivedAt,
      ...(packetAt != null ? { packetAt } : {}),
      ...this.keyStatusForWrapper(wrapper),
    }

    const feats = []

    if (t === 7 && decodedObj && typeof decodedObj === 'object') {
      const z = decodedObj
      const shape = z?.shape
      const threat = Number(z?.threat)
      const meaningCode = Number(z?.meaningCode)
      const label = z?.label ? String(z.label).trim() : ''
      const zNote = z?.note ? String(z.note).trim() : ''

      const zoneProps = {
        ...baseProps,
        kind: 'zone',
        threat: Number.isFinite(threat) ? threat : undefined,
        meaningCode: Number.isFinite(meaningCode) ? meaningCode : undefined,
        label: label || undefined,
        note: zNote || baseProps.note,
      }

      if (shape && shape.kind === 'circle' && Number.isFinite(shape.centerLat) && Number.isFinite(shape.centerLon) && Number.isFinite(shape.radiusM)) {
        const ring = this.circleToPolygon(shape.centerLat, shape.centerLon, shape.radiusM, 72)
        if (Array.isArray(ring) && ring.length >= 4) {
          feats.push({
            type: 'Feature',
            id: `imported:${key}:zone`,
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: zoneProps,
          })
        }
        feats.push({
          type: 'Feature',
          id: `imported:${key}:zoneCenter`,
          geometry: { type: 'Point', coordinates: [Number(shape.centerLon), Number(shape.centerLat)] },
          properties: { ...zoneProps, kind: 'zoneCenter' },
        })
        return feats
      }

      if (shape && (shape.kind === 'poly' || shape.kind === 'polygon')) {
        const pts = Array.isArray(shape.points) ? shape.points : []
        const ring = pts
          .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
          .map((p) => [Number(p.lon), Number(p.lat)])
        if (ring.length >= 3) {
          ring.push(ring[0])
          feats.push({
            type: 'Feature',
            id: `imported:${key}:zone`,
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: zoneProps,
          })

          const avg = ring.slice(0, -1).reduce((acc, c) => {
            acc.lon += Number(c[0])
            acc.lat += Number(c[1])
            acc.n += 1
            return acc
          }, { lon: 0, lat: 0, n: 0 })
          if (avg.n > 0) {
            feats.push({
              type: 'Feature',
              id: `imported:${key}:zoneCenter`,
              geometry: { type: 'Point', coordinates: [avg.lon / avg.n, avg.lat / avg.n] },
              properties: { ...zoneProps, kind: 'zoneCenter' },
            })
          }
          return feats
        }
      }

      return feats
    }

    if (decodedObj && typeof decodedObj === 'object' && Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
      feats.push({
        type: 'Feature',
        id: `imported:${key}:loc`,
        geometry: { type: 'Point', coordinates: [Number(decodedObj.lon), Number(decodedObj.lat)] },
        properties: { ...baseProps, kind: 'loc' },
      })
    }

    return feats
  }

  getActiveImportWrapper() {
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

    return { active, wrapper: parsed }
  }

  getActiveImportDecoded() {
    const res = this.getActiveImportWrapper()
    const obj = this.decodeParsedWrapper(res.wrapper)
    return { active: res.active, wrapper: res.wrapper, decodedObj: obj }
  }

  updateImportToMapButtonState(args) {
    const btn = document.getElementById('commsImportToMapBtn')
    if (!btn) return

    try {
      if (!args?.wrapper || !args?.decodedObj) {
        btn.disabled = true
        return
      }
      const key = 'preview'
      const summary = this.summaryFromDecoded(args.wrapper, args.decodedObj)
      const feats = this.buildImportedFeatures({ key, wrapper: args.wrapper, decodedObj: args.decodedObj, summary })
      btn.disabled = feats.length === 0
    } catch (_) {
      btn.disabled = true
    }
  }

  importSelectedToMap() {
    try {
      const decoded = this.getActiveImportDecoded()
      const key = this.makeXtocPacketStoreKey(decoded.wrapper)
      const receivedAt = Date.now()
      const summary = this.summaryFromDecoded(decoded.wrapper, decoded.decodedObj)
      const feats = this.buildImportedFeatures({ key, wrapper: decoded.wrapper, decodedObj: decoded.decodedObj, summary, receivedAt })

      if (feats.length === 0) {
        alert('This packet has no location/zone to show on the map.')
        return
      }

      if (typeof globalThis.addImportedPacket !== 'function') {
        throw new Error('Imported storage helpers not loaded')
      }

      const res = globalThis.addImportedPacket({
        key,
        raw: decoded.wrapper.raw,
        templateId: decoded.wrapper.templateId,
        mode: decoded.wrapper.mode,
        packetId: decoded.wrapper.id,
        kid: decoded.wrapper.mode === 'S' ? decoded.wrapper.kid : undefined,
        summary,
        features: feats,
      })

      if (!res?.ok) throw new Error(res?.reason || 'Import failed')

      try {
        if (typeof globalThis.setTacticalMapImportedEnabled === 'function') {
          globalThis.setTacticalMapImportedEnabled(true)
        }
      } catch (_) {
        // ignore
      }

      this.refreshImportedRawList()
      window.radioApp.updateStatus(res.added ? 'Imported to map' : 'Already imported')

      // Also persist in the XTOC packet store for list/search/history.
      try {
        void this.storeXtocPacketToDb({
          key,
          wrapper: decoded.wrapper,
          decodedObj: decoded.decodedObj,
          summary,
          receivedAt,
          source: 'comms',
          features: feats,
          hasGeo: true,
        })
      } catch (_) {
        // ignore
      }
    } catch (e) {
      alert(e?.message || String(e))
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

    const t = Number(wrapper?.templateId)
    const at = t === 8
      ? (decodedObj?.updatedAt ?? decodedObj?.createdAt ?? decodedObj?.t)
      : decodedObj?.t
    const time = this.formatTimeParts(at)
    const title = `${templateLabel} (${modeLabel})`

    const kv = []
    const addKV = (k, v) => {
      const s = (v == null) ? '' : String(v)
      if (!s.trim()) return
      kv.push([k, s])
    }

    const formatUnitList = (ids) => {
      if (!Array.isArray(ids)) return ''
      const out = []
      const seen = new Set()
      for (const v of ids) {
        const n = Math.floor(Number(v))
        if (!Number.isFinite(n) || n <= 0) continue
        if (seen.has(n)) continue
        seen.add(n)
        out.push(n)
      }
      return out.length ? out.map((n) => `U${n}`).join(', ') : ''
    }

    const srcUnits = formatUnitList(
      (Array.isArray(decodedObj?.srcIds) && decodedObj.srcIds.length) ? decodedObj.srcIds : (decodedObj?.src != null ? [decodedObj.src] : []),
    )

    addKV('Message ID', wrapper?.id)
    addKV('Template', templateLabel)
    addKV('Mode', modeLabel)
    if (wrapper?.mode === 'S') addKV('KID', wrapper?.kid)
    addKV('Timestamp (Local)', time.local)
    addKV('Timestamp (UTC)', time.utc)

    if (t === 4) {
      const unitIds = Array.isArray(decodedObj?.unitIds) && decodedObj.unitIds.length
        ? decodedObj.unitIds
        : (decodedObj?.unitId != null ? [decodedObj.unitId] : [])
      if (unitIds.length) addKV('Units', unitIds.map((n) => `U${n}`).join(', '))
      addKV('Status code', decodedObj?.status)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
    } else if (t === 1) {
      addKV('Source Unit(s)', srcUnits)
      addKV('To (dst)', decodedObj?.dst)
      addKV('Priority', decodedObj?.pri)
      addKV('Status code', decodedObj?.status)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 2) {
      addKV('Source Unit(s)', srcUnits)
      addKV('Priority', decodedObj?.pri)
      addKV('Contact type code', decodedObj?.typeCode)
      addKV('Count', decodedObj?.count)
      addKV('Direction code', decodedObj?.dir)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 3) {
      addKV('Source Unit(s)', srcUnits)
      addKV('To (dst)', decodedObj?.dst)
      addKV('Priority', decodedObj?.pri)
      addKV('Action code', decodedObj?.actionCode)
      addKV('Due (minutes)', decodedObj?.dueMins)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 5) {
      addKV('Source Unit(s)', srcUnits)
      addKV('Priority', decodedObj?.pri)
      addKV('Item code', decodedObj?.itemCode)
      addKV('Quantity', decodedObj?.qty)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 6) {
      addKV('Source Unit(s)', srcUnits)
      addKV('Condition code', decodedObj?.condition)
      addKV('Type code', decodedObj?.typeCode)
      if (decodedObj?.label) addKV('Label', decodedObj.label)
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.note) addKV('Note', decodedObj.note)
    } else if (t === 7) {
      addKV('Source Unit(s)', srcUnits)
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
    } else if (t === 8) {
      addKV('Mission ID', decodedObj?.id)
      addKV('Title', decodedObj?.title)
      addKV('Status', decodedObj?.status)
      addKV('Priority', decodedObj?.pri)
      const team = Array.isArray(decodedObj?.assignedToList)
        ? decodedObj.assignedToList
        : (decodedObj?.assignedTo ? [decodedObj.assignedTo] : [])
      if (team.length) addKV('Team', team.map((n) => `U${n}`).join(', '))
      if (Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
        addKV('Location', `${Number(decodedObj.lat).toFixed(5)}, ${Number(decodedObj.lon).toFixed(5)}`)
      }
      if (decodedObj?.locationLabel) addKV('Location label', decodedObj.locationLabel)
      if (Number.isFinite(decodedObj?.dueAt) && Number(decodedObj.dueAt) > 0) {
        addKV('Due (Local)', this.formatTimeParts(decodedObj.dueAt).local)
        addKV('Due (UTC)', this.formatTimeParts(decodedObj.dueAt).utc)
      }
      if (decodedObj?.notes) addKV('Notes', decodedObj.notes)
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
              'fill-color': 'rgba(246,201,69,0.18)',
              'fill-outline-color': 'rgba(246,201,69,0.95)',
            },
          })

          // Line outlines (polygons + optional lines)
          map.addLayer({
            id: this._importLineLayerId,
            type: 'line',
            source: this._importGeoSourceId,
            filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'LineString']],
            paint: {
              'line-color': 'rgba(246,201,69,0.95)',
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

  isAutoHaLowRxEnabled() {
    const el = document.getElementById('commsAutoHaLowRx')
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

  updateHaLowRxHint(state = null) {
    const el = document.getElementById('commsHaLowRxHint')
    if (!el) return

    let s = state
    if (!s) {
      try { s = globalThis.xcomHaLow?.getState?.() } catch (_) { s = null }
    }

    const status = s?.status || {}
    const connected = !!status?.connected
    const auto = this.isAutoHaLowRxEnabled()

    let tail = ''
    if (this._lastHaLowRxAt) {
      try {
        const t = new Date(Number(this._lastHaLowRxAt)).toLocaleTimeString()
        const from = this._lastHaLowRxFrom != null ? ` from ${String(this._lastHaLowRxFrom)}` : ''
        tail = ` â€¢ last rx ${t}${from}`
      } catch (_) {
        // ignore
      }
    }

    el.textContent = `MANET: ${connected ? 'connected' : 'not connected'} â€¢ auto-receive ${auto ? 'ON' : 'OFF'}${tail}`
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

    // First call: import history (traffic logs are capped and this prevents missing packets
    // when Comms wasn't open at the time they were received).
    if (cursorTs == null) return 0

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

  _halowSetTrafficCursorToEnd(traffic) {
    const arr = Array.isArray(traffic) ? traffic : []
    if (arr.length === 0) {
      this._halowTrafficCursorTs = 0
      this._halowTrafficCursorCountAtTs = 0
      return
    }

    const lastTs = Number(arr[arr.length - 1]?.ts || 0)
    let count = 0
    for (let i = arr.length - 1; i >= 0; i--) {
      const ts = Number(arr[i]?.ts || 0)
      if (ts !== lastTs) break
      count++
    }

    this._halowTrafficCursorTs = lastTs
    this._halowTrafficCursorCountAtTs = count
  }

  _halowComputeTrafficStartIndex(traffic) {
    const arr = Array.isArray(traffic) ? traffic : []
    const cursorTs = this._halowTrafficCursorTs

    // First call: import history (traffic logs are capped and this prevents missing packets
    // when Comms wasn't open at the time they were received).
    if (cursorTs == null) return 0

    const cursorCount = Number(this._halowTrafficCursorCountAtTs || 0)
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

  maybeAutoDecodeLatestComplete(opts = {}) {
    const messages = this.refreshImportMessageList({ keepSelection: false, preferLatestComplete: true })
    const sel = document.getElementById('commsImportMsgSelect')
    if (!sel) return

    const key = String(sel.value || '').trim()
    if (!key) return

    // Avoid re-decoding the same message on each traffic tick.
    if (this._lastDecodedKey && this._lastDecodedKey === key) return

    const active = messages.find((m) => m.key === key) || null
    if (!active || !active.complete) return

    this.reassembleAndDecode({ auto: true, ...(opts?.source ? { source: String(opts.source) } : {}) })
  }

  maybeStoreCompleteImportMessages(messages, source) {
    const list = Array.isArray(messages) ? messages : []
    if (list.length === 0) return

    // Best-effort: store the newest few complete packets even if we skip auto-decoding
    // (e.g., user recently touched the selection and we don't want to steal focus).
    let stored = 0
    const limit = 4

    for (const m of list) {
      if (!m?.complete) continue
      const msgKey = String(m?.key || '').trim()
      if (!msgKey) continue
      if (this._importStoredKeys && this._importStoredKeys.has(msgKey)) continue

      let wrapper = null
      try {
        if (m.total === 1) {
          wrapper = m.parts.get(1) || Array.from(m.parts.values())[0] || null
        } else if (typeof window.reassemblePackets === 'function' && typeof window.parsePacket === 'function') {
          const res = window.reassemblePackets(Array.from(m.parts.values()))
          if (res.ok) wrapper = window.parsePacket(res.packet)
        }
      } catch (_) {
        wrapper = null
      }
      if (!wrapper) continue

      const storeKey = this.makeXtocPacketStoreKey(wrapper)
      const summary = `${this.templateName(wrapper?.templateId)} (${wrapper?.mode === 'S' ? 'SECURE' : 'CLEAR'}) ID ${String(wrapper?.id || '').trim()}`.trim()

      try {
        if (this._importStoredKeys) this._importStoredKeys.add(msgKey)
        if (this._importStoredKeys && this._importStoredKeys.size > 6000) this._importStoredKeys.clear()
      } catch (_) {
        // ignore
      }

      try {
        void this.storeXtocPacketToDb({
          key: storeKey,
          wrapper,
          summary,
          receivedAt: Date.now(),
          source: String(source || 'unknown'),
          notify: true,
        })
      } catch (_) {
        // ignore
      }

      stored++
      if (stored >= limit) break
    }
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
        this._importAutoSourceHint = 'mesh'
        this.maybeAutoDecodeLatestComplete({ source: 'mesh' })
      } else {
        // Still refresh list so the new message appears.
        const msgs = this.refreshImportMessageList({ keepSelection: true, preferLatestComplete: false })
        this.maybeStoreCompleteImportMessages(msgs, 'mesh')
      }
    }
  }

  onMeshState(state) {
    this._meshLastState = state || null
    this.updateMeshRxHint(state)
    this.processIncomingMeshTraffic(state)
  }

  processIncomingHaLowTraffic(state) {
    const s = state || null
    const traffic = Array.isArray(s?.traffic) ? s.traffic : []

    const status = s?.status || {}
    const connected = !!status?.connected
    if (!connected) {
      this._halowSetTrafficCursorToEnd(traffic)
      return
    }

    if (!this.isAutoHaLowRxEnabled()) {
      this._halowSetTrafficCursorToEnd(traffic)
      return
    }

    const startIdx = this._halowComputeTrafficStartIndex(traffic)
    const slice = traffic.slice(startIdx)

    // Advance cursor immediately so even if decoding throws, we don't re-import the same entries forever.
    this._halowSetTrafficCursorToEnd(traffic)

    const lines = []
    for (const e of slice) {
      if (!e || typeof e !== 'object') continue
      if (e.dir !== 'in') continue
      if (String(e.kind || '') !== 'packet') continue
      const text = e.text
      if (typeof text !== 'string' || !text.trim()) continue
      const extracted = this.extractPacketLinesFromText(text)
      for (const line of extracted) lines.push(line)

      if (extracted.length) {
        this._lastHaLowRxAt = Date.now()
        try {
          const from = e.from || {}
          this._lastHaLowRxFrom = from?.label || from?.client_id || from?.clientId || null
        } catch (_) {
          this._lastHaLowRxFrom = null
        }
      }
    }

    if (lines.length === 0) return

    const added = this.appendImportLines(lines)
    if (added > 0) {
      try { window.radioApp?.updateStatus?.(`Received ${added} packet line(s) from MANET`) } catch (_) { /* ignore */ }
      try { this.updateHaLowRxHint(s) } catch (_) { /* ignore */ }

      const touchedAt = Number(this._importSelectionTouchedAt || 0)
      const recentlyTouched = touchedAt > 0 && (Date.now() - touchedAt) < 8000
      if (!recentlyTouched) {
        this._importAutoSourceHint = 'manet'
        this.maybeAutoDecodeLatestComplete({ source: 'manet' })
      } else {
        const msgs = this.refreshImportMessageList({ keepSelection: true, preferLatestComplete: false })
        this.maybeStoreCompleteImportMessages(msgs, 'manet')
      }
    }
  }

  onHaLowState(state) {
    this._halowLastState = state || null
    this.updateHaLowRxHint(state)
    this.processIncomingHaLowTraffic(state)
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

      const receivedAt = Date.now()
      const source = opts?.source
        ? String(opts.source)
        : ((opts?.auto && this._importAutoSourceHint) ? String(this._importAutoSourceHint) : 'comms')

      let obj = null
      let decodeError = ''
      try {
        obj = this.decodeParsedWrapper(parsed)
      } catch (e) {
        decodeError = e?.message ? String(e.message) : String(e)
        obj = null
      }

      if (obj) {
        if (decoded) decoded.textContent = JSON.stringify({ wrapper: parsed, decoded: obj }, null, 2)
        this.renderDecodedHuman(parsed, obj)
        try { this.updateImportMapPreview(parsed, obj) } catch (_) { /* ignore */ }
        try { this.updateImportToMapButtonState({ wrapper: parsed, decodedObj: obj }) } catch (_) { /* ignore */ }
      } else {
        const msg = decodeError || 'Decode failed'
        if (decoded) decoded.textContent = `Error: ${msg}`
        const human = document.getElementById('commsDecodedHuman')
        if (human) {
          human.innerHTML = `<div class="commsWarn">Error: ${this.escapeHtml(msg)}</div>`
        }
        try { this.setImportMapFeatures([]) } catch (_) { /* ignore */ }
        try { this.updateImportToMapButtonState(null) } catch (_) { /* ignore */ }
      }

      // Persist ALL packets (even if decode failed) to IndexedDB for XTOC Data module/history.
      try {
        const key = this.makeXtocPacketStoreKey(parsed)
        const summary = obj
          ? this.summaryFromDecoded(parsed, obj)
          : `${this.templateName(parsed?.templateId)} (${parsed?.mode === 'S' ? 'SECURE' : 'CLEAR'}) ID ${String(parsed?.id || '').trim()}`.trim()
        const feats = obj ? this.buildImportedFeatures({ key, wrapper: parsed, decodedObj: obj, summary, receivedAt }) : []

        void this.storeXtocPacketToDb({
          key,
          wrapper: parsed,
          ...(obj ? { decodedObj: obj } : {}),
          ...(decodeError ? { decodeError } : {}),
          summary,
          receivedAt,
          source,
          features: feats,
          hasGeo: feats.length > 0,
        })
      } catch (_) {
        // ignore
      }

      this._lastDecodedKey = active?.key || selKey || null
    } catch (e) {
      const msg = e?.message ? String(e.message) : String(e)
      if (decoded) decoded.textContent = `Error: ${msg}`
      const human = document.getElementById('commsDecodedHuman')
      if (human) {
        human.innerHTML = `<div class="commsWarn">Error: ${this.escapeHtml(msg)}</div>`
      }
      try { this.setImportMapFeatures([]) } catch (_) { /* ignore */ }
      try { this.updateImportToMapButtonState(null) } catch (_) { /* ignore */ }
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
      case 8:
        return window.decodeMissionClear(payloadB64Url)
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
