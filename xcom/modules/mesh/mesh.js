/**
 * XCOM Mesh module
 * - Connect to Meshtastic device (Web Bluetooth)
 * - Configure destination/channel
 * - Test send
 * - View traffic log
 */

function formatError(e) {
  if (e == null) return 'Unknown error'
  if (typeof e === 'string') return e
  if (typeof e === 'number' || typeof e === 'boolean' || typeof e === 'bigint') return String(e)
  if (e instanceof Error) {
    const base = e.message ? `${e.name}: ${e.message}` : e.name
    const cause = e.cause != null ? `; cause: ${formatError(e.cause)}` : ''
    return `${base}${cause}`.trim() || 'Error'
  }
  if (typeof e === 'object') {
    const any = e
    const name = typeof any?.name === 'string' ? any.name : ''
    const message = typeof any?.message === 'string' ? any.message : ''
    const reason = typeof any?.reason === 'string' ? any.reason : ''
    const code = typeof any?.code === 'string' || typeof any?.code === 'number' ? String(any.code) : ''

    const parts = []
    if (name && message) parts.push(`${name}: ${message}`)
    else if (message) parts.push(message)
    else if (name) parts.push(name)
    if (!message && reason) parts.push(reason)
    if (code) parts.push(`code=${code}`)
    if (parts.length) return parts.join(' ')

    // Meshtastic routing error shape: { id, error } where error is a Routing_Error enum value.
    try {
      const errCode = any?.error
      const n = Number(errCode)
      const Enum =
        globalThis?.Meshtastic?.Protobuf?.Mesh?.Routing_Error ||
        globalThis?.Meshtastic?.Protobuf?.Routing_Error ||
        globalThis?.Meshtastic?.Protobufs?.Mesh?.Routing_Error ||
        globalThis?.Meshtastic?.Protobufs?.Routing_Error
      const label = Number.isFinite(n) && Enum ? Enum[n] : null
      if (typeof label === 'string' && label) {
        const id = any?.id ?? any?.requestId ?? null
        return `Routing error: ${label} (${String(errCode)})${id != null ? ` id=${String(id)}` : ''}`
      }
    } catch (_) {
      // ignore
    }

    try {
      return JSON.stringify(any)
    } catch (_) {
      // ignore
    }

    try {
      return Object.prototype.toString.call(e)
    } catch (_) {
      return 'Unknown error'
    }
  }
  return String(e)
}

function meshNodeDisplayName(n, fallback) {
  const shortName = String(n?.shortName || '').trim()
  const longName = String(n?.longName || '').trim()
  const fb = String(fallback || '').trim()
  if (shortName && longName && shortName !== longName) return `${shortName} (${longName})`
  return shortName || longName || fb || 'Node'
}

// eslint-disable-next-line no-unused-vars
class MeshModule {
  constructor() {
    this.unsub = null
    this.map = null
    this.mapEl = null
    this.mapReady = false
    this.popup = null
    this.mapLayersAdded = false

    this.showNodes = true
    this.showCoverage = true
    this.coverageMetric = 'snr' // 'snr' | 'rssi'
    this.nodeFilter = ''

    this._lastTrafficLen = 0
    this.coverageLogging = false
    this.geoWatchId = null
    this.lastGeo = null
    this._lastCov = null
    this._boundHashChange = null
    this._boundRosterUpdated = null

    this.squadSending = false
    this.squadResults = []
    this.init()
  }

  init() {
    this.createModuleStructure()
    this.bindEvents()
    this.renderFromState()
    this.initMap()

    this._boundHashChange = () => {
      try {
        const hash = (window.location.hash || '').replace('#', '').trim()
        if (hash !== 'mesh') this.stopCoverageLogging()
      } catch (_) {
        // ignore
      }
    }
    window.addEventListener('hashchange', this._boundHashChange)
    this.unsub = (globalThis.xcomMesh && typeof globalThis.xcomMesh.subscribe === 'function')
      ? globalThis.xcomMesh.subscribe(() => this.renderFromState())
      : null
    this._boundRosterUpdated = () => this.renderFromState()
    try { globalThis.addEventListener('xcomTeamRosterUpdated', this._boundRosterUpdated) } catch (_) { /* ignore */ }
    window.radioApp.updateStatus('Mesh module loaded')
  }

  destroy() {
    try { if (this.unsub) this.unsub() } catch (_) { /* ignore */ }
    this.unsub = null
    try { this.stopCoverageLogging() } catch (_) { /* ignore */ }
    try { if (this._boundHashChange) window.removeEventListener('hashchange', this._boundHashChange) } catch (_) { /* ignore */ }
    this._boundHashChange = null
    try { if (this._boundRosterUpdated) globalThis.removeEventListener('xcomTeamRosterUpdated', this._boundRosterUpdated) } catch (_) { /* ignore */ }
    this._boundRosterUpdated = null
  }

  createModuleStructure() {
    const root = document.getElementById('mesh')
    if (!root) return

    root.innerHTML = `
      <div class="xModuleIntro">
        <div class="xModuleIntroTitle">What you can do here</div>
        <div class="xModuleIntroText">
          Connect XCOM to a Meshtastic radio over Bluetooth, view nodes on a map, and send/receive messages. Pair it with XTOC Comm to move standardized packets over the mesh.
        </div>
      </div>
      <div class="meshShell">
        <div class="meshCard meshSpanFull">
          <div class="meshCardTitle">Mesh</div>
          <div class="meshSmallMuted">
            Connect XCOM to a Meshtastic or MeshCore device using <strong>Web Bluetooth</strong> (Chrome/Edge/Android).
            iOS Safari does not currently support Web Bluetooth.
          </div>

          <div class="meshRow">
            <label>Status</label>
            <div id="meshStatus" class="meshStatusPill">Not connected</div>
            <div id="meshStatusMeta" class="meshSmallMuted"></div>
          </div>

          <div class="meshButtonRow">
            <button id="meshConnectBtn" type="button" class="primary">Connect</button>
            <button id="meshDisconnectBtn" type="button" class="danger">Disconnect</button>
            <button id="meshClearLogBtn" type="button">Clear Log</button>
          </div>
        </div>

        <div class="meshCard">
          <div class="meshCardTitle">Send Settings</div>

          <div class="meshRow">
            <label>Firmware</label>
            <select id="meshDriver">
              <option value="meshtastic">Meshtastic</option>
              <option value="meshcore">MeshCore</option>
            </select>
            <div class="meshSmallMuted" id="meshDriverHint"></div>
          </div>

          <div class="meshGrid2">
            <div class="meshRow">
              <label>Destination</label>
              <select id="meshDest">
                <option value="broadcast">Broadcast (channel)</option>
                <option value="direct">Direct (id)</option>
              </select>
            </div>
            <div class="meshRow">
              <label>Channel</label>
              <input id="meshChannel" type="number" min="0" max="7" step="1" value="0" />
            </div>
          </div>

          <div class="meshRow">
            <label id="meshToNodeIdLabel">To Node ID (direct only)</label>
            <input id="meshToNodeId" type="text" placeholder="!deadbeef or numeric node id" />
          </div>

          <div class="meshRow" id="meshWantAckRow">
            <label class="meshInline"><input id="meshWantAck" type="checkbox" checked /> Request ACK</label>
          </div>

          <div class="meshRow">
            <label class="meshInline"><input id="meshAutoReconnect" type="checkbox" checked /> Auto-reconnect</label>
            <div class="meshSmallMuted">If Bluetooth drops, try to reconnect automatically</div>
          </div>

          <div class="meshDivider"></div>

          <div class="meshRow">
            <label>Send Message</label>
            <textarea id="meshTestText" rows="3" placeholder="Type a short message to send over the mesh"></textarea>
          </div>
          <div class="meshButtonRow">
            <button id="meshSendTestBtn" type="button">Send</button>
          </div>
          <div class="meshSmallMuted">
            Tip: Comms can also send generated packet lines directly over Mesh after you connect here.
          </div>

          <div class="meshDivider"></div>

          <div class="meshRow">
            <label>Squad message (direct)</label>
            <select id="meshSquadSelect"></select>
            <div class="meshSmallMuted">
              Sends a direct message to each roster member in the selected squad with a matching <code>meshNodeId</code>.
            </div>
          </div>

          <div class="meshRow">
            <label>Message to squad</label>
            <textarea id="meshSquadText" rows="2" placeholder="Type a message to send to every squad member"></textarea>
          </div>

          <div class="meshButtonRow">
            <button id="meshSendSquadBtn" type="button" class="primary">Send to squad</button>
            <button id="meshClearSquadBtn" type="button" class="danger">Clear</button>
          </div>
          <div id="meshSquadStatus" class="meshSmallMuted"></div>
        </div>

        <div class="meshCard">
          <div class="meshCardTitle">Channels + Nodes heard</div>
          <div class="meshSmallMuted" style="margin-bottom: 10px;">
            Click a channel to set <strong>Broadcast</strong> + channel index. Import labels from a connected Meshtastic device.
          </div>
          <div class="meshButtonRow" style="margin-top: 0;">
            <button id="meshImportChannelsBtn" type="button" class="primary">Import labels</button>
            <button id="meshClearChannelsBtn" type="button" class="danger">Clear</button>
          </div>
          <div id="meshChannelList" class="meshChipRow" style="margin-top: 10px;"></div>

          <div class="meshDivider"></div>

          <div class="meshRow">
            <label>Filter nodes</label>
            <input id="meshNodeFilter" type="text" placeholder="name / id / #" />
          </div>
          <div id="meshNodeCount" class="meshSmallMuted"></div>
          <div id="meshNodeList" class="meshList"></div>
        </div>

        <div class="meshCard meshSpanFull">
          <div class="meshCardTitle">Traffic</div>
          <pre id="meshTraffic" class="meshPre"></pre>
        </div>

        <div class="meshCard meshSpanFull">
          <div class="meshCardTitle">Mesh Map</div>
          <div class="meshSmallMuted" style="margin-bottom: 10px;">
            Shows known nodes (from Meshtastic position/user packets) and optional coverage points logged on this device.
          </div>

          <div class="meshGrid2">
            <div class="meshRow">
              <label class="meshInline"><input id="meshMapShowNodes" type="checkbox" checked /> Show nodes</label>
            </div>
            <div class="meshRow">
              <label class="meshInline"><input id="meshMapShowCoverage" type="checkbox" checked /> Show coverage</label>
            </div>
          </div>

          <div class="meshGrid2">
            <div class="meshRow">
              <label>Coverage metric</label>
              <select id="meshCoverageMetric">
                <option value="snr" selected>SNR</option>
                <option value="rssi">RSSI</option>
              </select>
            </div>
            <div class="meshRow">
              <label>Coverage logging (GPS)</label>
              <div class="meshButtonRow" style="margin-top: 0;">
                <button id="meshCoverageLogBtn" type="button" class="primary">Start Logging</button>
                <button id="meshCoverageCenterBtn" type="button">Center on Me</button>
              </div>
              <div id="meshCoverageStatus" class="meshSmallMuted"></div>
            </div>
          </div>

          <div class="meshButtonRow" style="margin-top: 6px;">
            <button id="meshClearNodesBtn" type="button" class="danger">Clear Nodes</button>
            <button id="meshClearCoverageBtn" type="button" class="danger">Clear Coverage</button>
          </div>
          <div id="meshMapSummary" class="meshSmallMuted"></div>
          <div class="meshMapWrap">
            <div id="meshMapCanvas" class="meshMapCanvas"></div>
          </div>
        </div>
      </div>
    `
  }

  bindEvents() {
    const connectBtn = document.getElementById('meshConnectBtn')
    const disconnectBtn = document.getElementById('meshDisconnectBtn')
    const clearBtn = document.getElementById('meshClearLogBtn')
    const sendBtn = document.getElementById('meshSendTestBtn')
    const importChBtn = document.getElementById('meshImportChannelsBtn')
    const clearChBtn = document.getElementById('meshClearChannelsBtn')
    const channelListEl = document.getElementById('meshChannelList')
    const nodeFilterEl = document.getElementById('meshNodeFilter')
    const nodeListEl = document.getElementById('meshNodeList')

    if (connectBtn) connectBtn.addEventListener('click', async () => {
      try {
        if (!globalThis.meshConnect) throw new Error('Mesh transport not loaded')
        await globalThis.meshConnect()
      } catch (e) {
        alert(formatError(e))
      }
    })

    if (disconnectBtn) disconnectBtn.addEventListener('click', async () => {
      try {
        if (globalThis.meshDisconnect) await globalThis.meshDisconnect()
      } catch (e) {
        alert(formatError(e))
      }
    })

    if (clearBtn) clearBtn.addEventListener('click', () => {
      try {
        if (globalThis.meshClearTrafficLog) globalThis.meshClearTrafficLog()
      } catch (_) {
        // ignore
      }
    })

    // Persist settings on change
    const updateCfg = () => {
      try {
        const driver = (document.getElementById('meshDriver')?.value === 'meshcore') ? 'meshcore' : 'meshtastic'
        const dest = document.getElementById('meshDest')?.value || 'broadcast'
        const rawChannel = Number(document.getElementById('meshChannel')?.value || 0)
        const channel = driver === 'meshcore'
          ? Math.max(0, Math.min(255, rawChannel))
          : Math.max(0, Math.min(7, rawChannel))
        const toNodeId = String(document.getElementById('meshToNodeId')?.value || '').trim()
        const wantAck = !!document.getElementById('meshWantAck')?.checked
        const autoReconnect = !!document.getElementById('meshAutoReconnect')?.checked
        if (globalThis.setMeshConfig) {
          const patch = { driver, ui: { autoReconnect } }
          if (driver === 'meshcore') {
            patch.meshcore = { destination: dest, channel, toNodeId }
          } else {
            patch.meshtastic = { destination: dest, channel, toNodeId, wantAck }
          }
          globalThis.setMeshConfig(patch)
        }
      } catch (_) {
        // ignore
      }
    }

    const driverSel = document.getElementById('meshDriver')
    if (driverSel) driverSel.addEventListener('change', async () => {
      const next = (driverSel.value === 'meshcore') ? 'meshcore' : 'meshtastic'
      let current = 'meshtastic'
      try {
        const cfg = globalThis.getMeshConfig ? globalThis.getMeshConfig() : null
        current = (cfg?.driver === 'meshcore') ? 'meshcore' : 'meshtastic'
      } catch (_) {
        current = 'meshtastic'
      }

      try {
        const s = globalThis.xcomMesh?.getState?.()?.status || {}
        const connected = !!s.connected || !!s.linkConnected
        const active = (String(s.driver || current) === 'meshcore') ? 'meshcore' : 'meshtastic'
        if (connected && active !== next) {
          const ok = confirm('Switch firmware/driver now?\n\nThis will disconnect; you can reconnect using the new driver.')
          if (!ok) {
            driverSel.value = active
            return
          }
          try { if (globalThis.meshDisconnect) await globalThis.meshDisconnect() } catch (_) { /* ignore */ }
        }
      } catch (_) {
        // ignore
      }

      updateCfg()
    })

    ;['meshDest', 'meshChannel', 'meshToNodeId', 'meshWantAck', 'meshAutoReconnect'].forEach((id) => {
      const el = document.getElementById(id)
      if (el) el.addEventListener('change', updateCfg)
      if (el) el.addEventListener('input', updateCfg)
    })

    if (sendBtn) sendBtn.addEventListener('click', async () => {
      try {
        const text = document.getElementById('meshTestText')?.value || ''
        await this.sendText(text)
      } catch (e) {
        alert(formatError(e))
      }
    })

    const sendSquadBtn = document.getElementById('meshSendSquadBtn')
    if (sendSquadBtn) sendSquadBtn.addEventListener('click', async () => {
      try {
        await this.sendSquad()
      } catch (e) {
        alert(formatError(e))
      }
    })

    const clearSquadBtn = document.getElementById('meshClearSquadBtn')
    if (clearSquadBtn) clearSquadBtn.addEventListener('click', () => {
      try {
        this.squadResults = []
        this.renderSquadResults()
      } catch (_) {
        // ignore
      }
    })

    if (importChBtn) importChBtn.addEventListener('click', async () => {
      try {
        if (typeof globalThis.meshImportChannels !== 'function') throw new Error('Channel import not available in this build')
        await globalThis.meshImportChannels()
      } catch (e) {
        alert(formatError(e))
      }
    })

    if (clearChBtn) clearChBtn.addEventListener('click', () => {
      try {
        if (typeof globalThis.meshClearChannels === 'function') globalThis.meshClearChannels('meshtastic')
      } catch (_) {
        // ignore
      }
    })

    if (nodeFilterEl) nodeFilterEl.addEventListener('input', () => {
      try {
        this.nodeFilter = String(nodeFilterEl.value || '').trim()
        this.renderFromState()
      } catch (_) {
        // ignore
      }
    })

    if (channelListEl) channelListEl.addEventListener('click', (ev) => {
      try {
        const btn = ev?.target?.closest?.('button[data-channel-index]')
        if (!btn) return
        const idx = Number(btn.dataset.channelIndex)
        if (!Number.isFinite(idx)) return

        const cfg = globalThis.getMeshConfig ? globalThis.getMeshConfig() : null
        const driver = (cfg?.driver === 'meshcore') ? 'meshcore' : 'meshtastic'
        if (typeof globalThis.setMeshConfig === 'function') {
          if (driver === 'meshcore') globalThis.setMeshConfig({ meshcore: { destination: 'broadcast', channel: idx } })
          else globalThis.setMeshConfig({ meshtastic: { destination: 'broadcast', channel: idx } })
        }
        try { document.getElementById('meshTestText')?.focus?.() } catch (_) { /* ignore */ }
      } catch (_) {
        // ignore
      }
    })

    if (nodeListEl) nodeListEl.addEventListener('click', (ev) => {
      try {
        const btn = ev?.target?.closest?.('button[data-node-id],button[data-node-num]')
        if (!btn) return
        const nodeId = String(btn.dataset.nodeId || '').trim()
        const nodeNum = Number(btn.dataset.nodeNum)

        const cfg = globalThis.getMeshConfig ? globalThis.getMeshConfig() : null
        const driver = (cfg?.driver === 'meshcore') ? 'meshcore' : 'meshtastic'

        let toNodeId = nodeId
        if (!toNodeId && Number.isFinite(nodeNum)) {
          toNodeId = driver === 'meshtastic' ? String(Math.floor(nodeNum)) : String(Math.floor(nodeNum))
        }
        if (!toNodeId) return

        if (typeof globalThis.setMeshConfig === 'function') {
          if (driver === 'meshcore') globalThis.setMeshConfig({ meshcore: { destination: 'direct', toNodeId } })
          else globalThis.setMeshConfig({ meshtastic: { destination: 'direct', toNodeId } })
        }
        try { document.getElementById('meshTestText')?.focus?.() } catch (_) { /* ignore */ }
      } catch (_) {
        // ignore
      }
    })

    const showNodesEl = document.getElementById('meshMapShowNodes')
    if (showNodesEl) showNodesEl.addEventListener('change', () => {
      this.showNodes = !!showNodesEl.checked
      this.refreshMapOverlays()
    })

    const showCovEl = document.getElementById('meshMapShowCoverage')
    if (showCovEl) showCovEl.addEventListener('change', () => {
      this.showCoverage = !!showCovEl.checked
      this.refreshMapOverlays()
    })

    const metricEl = document.getElementById('meshCoverageMetric')
    if (metricEl) metricEl.addEventListener('change', () => {
      const v = String(metricEl.value || '').trim()
      this.coverageMetric = (v === 'rssi') ? 'rssi' : 'snr'
      this.refreshMapOverlays()
    })

    const clearNodesBtn = document.getElementById('meshClearNodesBtn')
    if (clearNodesBtn) clearNodesBtn.addEventListener('click', () => {
      try {
        if (globalThis.meshClearNodes) globalThis.meshClearNodes()
      } catch (_) {
        // ignore
      } finally {
        this.refreshMapOverlays()
      }
    })

    const clearCovBtn = document.getElementById('meshClearCoverageBtn')
    if (clearCovBtn) clearCovBtn.addEventListener('click', () => {
      try {
        if (globalThis.meshClearCoverageSamples) globalThis.meshClearCoverageSamples()
      } catch (_) {
        // ignore
      } finally {
        this.refreshMapOverlays()
      }
    })

    const logBtn = document.getElementById('meshCoverageLogBtn')
    if (logBtn) logBtn.addEventListener('click', async () => {
      if (this.coverageLogging) {
        this.stopCoverageLogging()
        return
      }
      await this.startCoverageLogging()
    })

    const centerBtn = document.getElementById('meshCoverageCenterBtn')
    if (centerBtn) centerBtn.addEventListener('click', () => this.centerOnMe())
  }

  renderFromState() {
    const cfg = globalThis.getMeshConfig ? globalThis.getMeshConfig() : null
    const state = globalThis.xcomMesh ? globalThis.xcomMesh.getState() : { status: { connected: false }, traffic: [] }
    const driverName = (cfg?.driver === 'meshcore') ? 'meshcore' : 'meshtastic'

    // status pill
    const statusEl = document.getElementById('meshStatus')
    if (statusEl) {
      const s = state.status || {}
      const connected = !!s.connected
      const linkConnected = !!s.linkConnected
      const reconnecting = !!s.reconnecting
      const attempt = Number(s.reconnectAttempt || 0)
      const ds = s.deviceStatusLabel
      const busy = reconnecting || (!connected && ds != null && ds !== 'Disconnected')
      const label = connected
        ? `Connected (${s.driver || 'mesh'})`
        : reconnecting
          ? `Reconnecting${attempt ? ` (attempt ${attempt})` : ''}`
          : (linkConnected && ds === 'Connected')
            ? 'Connected (not configured)'
            : (ds || 'Not connected')
      statusEl.textContent = label
      statusEl.classList.toggle('ok', connected)
      statusEl.classList.toggle('warn', !connected && (busy || linkConnected))
    }

    // status meta (device / link / last rx/tx)
    const metaEl = document.getElementById('meshStatusMeta')
    if (metaEl) {
      metaEl.textContent = ''
      try {
        const s = state.status || {}
        const traffic = Array.isArray(state.traffic) ? state.traffic : []
        let lastInTs = null
        let lastOutTs = null
        for (let i = traffic.length - 1; i >= 0 && (lastInTs == null || lastOutTs == null); i--) {
          const e = traffic[i]
          if (lastInTs == null && e?.dir === 'in') lastInTs = e?.ts ?? null
          if (lastOutTs == null && e?.dir === 'out') lastOutTs = e?.ts ?? null
        }

        const deviceLabel = s?.lastDeviceInfo?.shortName || s?.lastDeviceInfo?.longName || null
        const nodeNum = s?.lastDeviceInfo?.myNodeNum ?? s?.lastDeviceInfo?.nodeId ?? null

        const lines = []
        if (deviceLabel || nodeNum != null) {
          lines.push(`Device: ${deviceLabel || 'Unknown'}${nodeNum != null ? ` (#${nodeNum})` : ''}`)
        }
        lines.push(`Link: ${s?.deviceStatusLabel || 'Unknown'}${typeof s?.deviceStatus === 'number' ? ` (${s.deviceStatus})` : ''}`)

        if (s?.reconnecting) {
          const at = typeof s?.nextReconnectAt === 'number' ? new Date(s.nextReconnectAt).toISOString() : null
          lines.push(`Auto-reconnect: attempt ${s?.reconnectAttempt || '?'}${at ? `; next: ${at}` : ''}`)
        }
        if (s?.lastError) {
          lines.push(`Last error: ${String(s.lastError)}`)
        }

        lines.push(`Last RX: ${lastInTs ? new Date(lastInTs).toISOString() : '—'} | Last TX: ${lastOutTs ? new Date(lastOutTs).toISOString() : '—'}`)

        metaEl.innerHTML = ''
        for (const line of lines) {
          const div = document.createElement('div')
          div.textContent = line
          metaEl.appendChild(div)
        }
      } catch (_) {
        // ignore
      }
    }

    // settings
    try {
      const driver = driverName
      const mt = (cfg && cfg.meshtastic) ? cfg.meshtastic : {}
      const mc = (cfg && cfg.meshcore) ? cfg.meshcore : {}
      const active = (driver === 'meshcore') ? mc : mt
      const ui = (cfg && cfg.ui) ? cfg.ui : {}
      const driverEl = document.getElementById('meshDriver')
      const destEl = document.getElementById('meshDest')
      const chEl = document.getElementById('meshChannel')
      const toEl = document.getElementById('meshToNodeId')
      const toLabelEl = document.getElementById('meshToNodeIdLabel')
      const hintEl = document.getElementById('meshDriverHint')
      const ackRowEl = document.getElementById('meshWantAckRow')
      const ackEl = document.getElementById('meshWantAck')
      const arEl = document.getElementById('meshAutoReconnect')

      if (driverEl) driverEl.value = driver
      if (hintEl) {
        hintEl.textContent = driver === 'meshcore'
          ? 'MeshCore: direct uses pubkey prefix (12 hex). Text max 160 bytes.'
          : 'Meshtastic: direct uses node id (!deadbeef) or numeric. Channel 0-7.'
      }
      if (toLabelEl) toLabelEl.textContent = driver === 'meshcore' ? 'To pubkey prefix (direct only)' : 'To Node ID (direct only)'

      if (destEl) destEl.value = active.destination || 'broadcast'
      if (chEl) {
        chEl.max = driver === 'meshcore' ? '255' : '7'
        chEl.value = String(Number(active.channel || 0))
      }
      if (toEl) {
        toEl.value = active.toNodeId || ''
        toEl.placeholder = driver === 'meshcore' ? 'a1b2c3d4e5f6' : '!deadbeef or numeric node id'
      }
      if (ackRowEl) ackRowEl.style.display = driver === 'meshcore' ? 'none' : ''
      if (ackEl) ackEl.checked = mt.wantAck !== false
      if (arEl) arEl.checked = ui.autoReconnect !== false

      if (toEl) toEl.disabled = (destEl?.value !== 'direct')
    } catch (_) {
      // ignore
    }

    // squad messaging (roster-driven)
    try {
      const squadSel = document.getElementById('meshSquadSelect')
      const sendSquadBtn = document.getElementById('meshSendSquadBtn')
      const clearSquadBtn = document.getElementById('meshClearSquadBtn')

      const haveRoster = typeof globalThis.xcomListSquads === 'function' && typeof globalThis.xcomListRosterMembers === 'function'
      const squads = haveRoster ? (globalThis.xcomListSquads() || []) : []

      if (squadSel) {
        const prev = String(squadSel.value || '')
        squadSel.innerHTML = ''

        const opt0 = document.createElement('option')
        opt0.value = ''
        opt0.textContent = haveRoster ? '(pick squad)' : '(import roster first)'
        squadSel.appendChild(opt0)

        for (const s of Array.isArray(squads) ? squads : []) {
          const id = String(s?.id ?? '').trim()
          const name = String(s?.name ?? '').trim()
          if (!id || !name) continue
          const call = String(s?.callsign ?? '').trim()
          const label = call ? `${call} (${name})` : name
          const opt = document.createElement('option')
          opt.value = id
          opt.textContent = label
          squadSel.appendChild(opt)
        }

        if (prev) squadSel.value = prev
        squadSel.disabled = !haveRoster || this.squadSending
      }

      const connectedNow = !!state?.status?.connected
      const selected = String(squadSel?.value || '').trim()
      if (sendSquadBtn) sendSquadBtn.disabled = !connectedNow || this.squadSending || !haveRoster || !selected
      if (clearSquadBtn) clearSquadBtn.disabled = this.squadSending || !(Array.isArray(this.squadResults) && this.squadResults.length)

      this.renderSquadResults()
    } catch (_) {
      // ignore
    }

    // traffic log
    const pre = document.getElementById('meshTraffic')
    if (pre) {
      const traffic = Array.isArray(state.traffic) ? state.traffic : []

       const nodesAll = Array.isArray(state?.nodes) ? state.nodes : (typeof globalThis.meshGetNodes === 'function' ? globalThis.meshGetNodes() : [])
       const nodes = Array.isArray(nodesAll) ? nodesAll.filter((n) => String(n?.driver || '') === driverName) : []
       const labelByNum = new Map()
       const labelById = new Map()
       for (const n of nodes) {
         const id = String(n?.id || '').trim()
         const num = Number.isFinite(Number(n?.num)) ? Math.floor(Number(n.num)) : null
         const label = meshNodeDisplayName(n, id ? id : (num != null ? `#${num}` : 'Node'))
         if (num != null) labelByNum.set(num, label)
         if (id) labelById.set(id, label)
       }

       const normalizeMeshtasticNodeId = (raw) => {
         const s = String(raw ?? '').trim()
         if (!s) return null
         if (s.startsWith('!')) {
           const n = parseInt(s.slice(1), 16)
           if (!Number.isFinite(n)) return null
           return '!' + ((n >>> 0).toString(16).padStart(8, '0'))
         }
         const n = Number(s)
         if (!Number.isFinite(n)) return null
         return '!' + ((Math.floor(n) >>> 0).toString(16).padStart(8, '0'))
       }

       const labelForTo = (toNodeId) => {
         const raw = String(toNodeId ?? '').trim()
         if (!raw) return ''
         if (driverName === 'meshcore') {
           const cleaned = raw.replace(/^!/, '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
           if (cleaned.length !== 12) return raw
           return labelById.get(cleaned) || cleaned
         }
         const id = normalizeMeshtasticNodeId(raw)
         if (!id) return raw
         return labelById.get(id) || id
       }

       const labelForFrom = (from) => {
         const n = Number(from)
         if (!Number.isFinite(n)) return ''
         const num = Math.floor(n) >>> 0
         return labelByNum.get(num) || `#${num}`
       }

      const lines = traffic
        .slice(-200)
        .map((e) => {
          const ts = e.ts ? new Date(e.ts).toISOString() : ''
          const dir = e.dir || ''
          if (dir === 'out' && e.kind === 'text') {
            const status = String(e?.status || '')
            const statusText = status === 'pending' ? ' …' : status === 'ok' ? ' ACK' : status === 'error' ? ' ERR' : ''
            const err = status === 'error' && e?.error ? ` (${String(e.error)})` : ''
            const idText = status === 'ok' && typeof e?.id === 'number' ? ` (id=${String(e.id)})` : ''

            const dest = (String(e?.destination || '') === 'direct')
              ? `DM to ${labelForTo(e?.toNodeId ?? null)}`
              : (typeof e?.channel === 'number' ? `CH${Math.floor(e.channel)}` : null)
            const prefix = dest ? `[${dest}] ` : ''

            return `${ts}  OUT  ${prefix}${e.text}${statusText}${idText}${err}`
          }
          if (dir === 'in') {
            const txt = e?.text || (e?.kind === 'message' ? e?.raw?.data : null)
            if (typeof txt === 'string' && txt.trim()) {
              const msgType = String(e?.raw?.type || '')
              const fromLabel = e?.from != null ? labelForFrom(e.from) : ''
              const tag = fromLabel ? (msgType === 'direct' ? `DM from ${fromLabel}` : `from ${fromLabel}`) : (msgType === 'direct' ? 'DM' : '')
              const ch = Number.isFinite(Number(e?.channel)) ? `CH${Math.floor(Number(e.channel))}` : ''
              const bits = [tag, ch].filter(Boolean).join(' • ')
              const prefix = bits ? `[${bits}] ` : ''
              return `${ts}  IN   ${prefix}${txt}`
            }
            return `${ts}  IN   ${JSON.stringify(e.raw)}`
          }
          if (dir === 'sys') return `${ts}  SYS  ${e.level || ''} ${e.msg || ''}`
          return `${ts}  ${dir} ${JSON.stringify(e)}`
        })
      pre.textContent = lines.join('\n')
    }

    // buttons
    const connectBtn = document.getElementById('meshConnectBtn')
    const disconnectBtn = document.getElementById('meshDisconnectBtn')
    const sendBtn = document.getElementById('meshSendTestBtn')
    const connected = !!state?.status?.connected
    const linkConnected = !!state?.status?.linkConnected
    const ds = state?.status?.deviceStatusLabel
    const busy = !!state?.status?.reconnecting || (!connected && ds != null && ds !== 'Disconnected')

    if (connectBtn) connectBtn.disabled = connected || busy || linkConnected
    if (disconnectBtn) disconnectBtn.disabled = !connected && !busy && !linkConnected
    if (sendBtn) sendBtn.disabled = !connected

    // channels + nodes heard lists
    try {
      const driver = driverName
      const mt = (cfg && cfg.meshtastic) ? cfg.meshtastic : {}
      const mc = (cfg && cfg.meshcore) ? cfg.meshcore : {}
      const active = (driver === 'meshcore') ? mc : mt

      const importBtn = document.getElementById('meshImportChannelsBtn')
      const clearBtn = document.getElementById('meshClearChannelsBtn')
      if (importBtn) {
        importBtn.disabled = !connected || driver !== 'meshtastic' || typeof globalThis.meshImportChannels !== 'function'
        importBtn.textContent = 'Import labels'
      }
      if (clearBtn) {
        clearBtn.disabled = driver !== 'meshtastic' || typeof globalThis.meshClearChannels !== 'function'
      }

      const chListEl = document.getElementById('meshChannelList')
      if (chListEl) {
        const imported = Array.isArray(state?.channels)
          ? state.channels
          : (typeof globalThis.meshGetChannels === 'function' ? globalThis.meshGetChannels() : [])

        const fallback = []
        for (let i = 0; i < 8; i++) {
          const name = (driver === 'meshtastic' && i === 0) ? 'Primary' : (driver === 'meshtastic' && i === 7) ? 'Admin' : `Channel ${i}`
          fallback.push({ index: i, name })
        }

        const channels = (Array.isArray(imported) && imported.length) ? imported : fallback
        chListEl.innerHTML = ''
        for (const ch of channels) {
          const idx = Number(ch?.index ?? ch?.channel ?? 0)
          if (!Number.isFinite(idx)) continue
          const name = String(ch?.name ?? `Channel ${idx}`)
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'meshChip'
          btn.dataset.channelIndex = String(Math.floor(idx))

          const activeSel = (active?.destination !== 'direct') && Number(active?.channel) === Math.floor(idx)
          if (activeSel) btn.classList.add('active')

          btn.textContent = `${name} (#${Math.floor(idx)})`
          chListEl.appendChild(btn)
        }
      }

      const nodesAll = Array.isArray(state?.nodes) ? state.nodes : (typeof globalThis.meshGetNodes === 'function' ? globalThis.meshGetNodes() : [])
      const nodes = Array.isArray(nodesAll) ? nodesAll.filter((n) => String(n?.driver || '') === driver) : []

      const needle = String(this.nodeFilter || '').trim().toLowerCase()
      const filtered = needle
        ? nodes.filter((n) => {
          const hay = `${n?.shortName || ''} ${n?.longName || ''} ${n?.id || ''} ${n?.num != null ? '#' + String(n.num) : ''}`.toLowerCase()
          return hay.includes(needle)
        })
        : nodes

      let selectedNum = null
      const rawTo = String(active?.toNodeId || '').trim()
      if (active?.destination === 'direct' && driver === 'meshtastic' && rawTo) {
        if (rawTo.startsWith('!')) {
          const n = parseInt(rawTo.slice(1), 16)
          if (Number.isFinite(n)) selectedNum = (n >>> 0)
        } else {
          const n = Number(rawTo)
          if (Number.isFinite(n)) selectedNum = Math.floor(n)
        }
      }

      const countEl = document.getElementById('meshNodeCount')
      if (countEl) countEl.textContent = `${filtered.length} node(s)`

      const listEl = document.getElementById('meshNodeList')
      if (listEl) {
        listEl.innerHTML = ''
        for (const n of filtered.slice(0, 200)) {
          const id = String(n?.id || '').trim()
          const num = Number.isFinite(Number(n?.num)) ? Math.floor(Number(n.num)) : null
          const label = meshNodeDisplayName(n, id ? id : (num != null ? `#${num}` : 'Node'))
          const lastSeenTs = Number(n?.lastSeenTs || 0) || 0
          const lat = Number(n?.position?.lat)
          const lon = Number(n?.position?.lon)
          const hasPos = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
          const when = lastSeenTs ? new Date(lastSeenTs).toISOString() : '—'

          const row = document.createElement('div')
          row.className = 'meshNodeRow'

          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'meshNodeRowBtn'
          if (id) btn.dataset.nodeId = id
          if (num != null) btn.dataset.nodeNum = String(num)

          const isSelected = (active?.destination === 'direct') && (
            (driver === 'meshcore' && rawTo && rawTo === id) ||
            (driver === 'meshtastic' && (
              (rawTo && id && rawTo === id) ||
              (selectedNum != null && num != null && num === selectedNum)
            ))
          )
          if (isSelected) btn.classList.add('active')

          const meta = document.createElement('div')
          meta.className = 'meshNodeMeta'
          const left = document.createElement('div')
          const right = document.createElement('div')
          left.textContent = id ? (driver === 'meshcore' ? `Prefix: ${id}` : `ID: ${id}`) : (num != null ? `#${num}` : '')
          right.textContent = when
          meta.appendChild(left)
          meta.appendChild(right)

          const title = document.createElement('div')
          title.textContent = label

          btn.appendChild(title)
          btn.appendChild(meta)
          row.appendChild(btn)

          if (hasPos) {
            const mapBtn = document.createElement('button')
            mapBtn.type = 'button'
            mapBtn.className = 'meshNodeMapBtn'
            mapBtn.textContent = 'View on map'
            mapBtn.title = 'Open Map module centered on this node'
            mapBtn.addEventListener('click', () => this.jumpToMap(lat, lon, 15))
            row.appendChild(mapBtn)
          }

          listEl.appendChild(row)
        }

        if (filtered.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'meshSmallMuted'
          empty.textContent = 'No nodes heard yet. Connect, then wait for traffic or send a message.'
          listEl.appendChild(empty)
        }
      }
    } catch (_) {
      // ignore
    }

    // map overlays / summary
    this.processNewTrafficForCoverage(state)
    this.updateCoverageStatusUi()
    this.updateMapSummary(state)
    this.refreshMapOverlays(state)
  }

  jumpToMap(lat, lon, zoom) {
    const a = Number(lat)
    const b = Number(lon)
    const zRaw = Number(zoom)
    if (!Number.isFinite(a) || Math.abs(a) > 90) return
    if (!Number.isFinite(b) || Math.abs(b) > 180) return
    const z = Number.isFinite(zRaw) ? Math.max(0, Math.min(22, zRaw)) : 15

    try { globalThis.setMapDefaultCoords && globalThis.setMapDefaultCoords({ lat: a, lon: b }) } catch (_) { /* ignore */ }
    try { globalThis.setMapDefaultZoom && globalThis.setMapDefaultZoom(z) } catch (_) { /* ignore */ }

    // Prefer a real nav click so the sidebar highlight stays in sync.
    try {
      const link = document.querySelector('#module-nav a[href="#map"], .xNav a[href="#map"], #module-nav a[data-module="map"], .xNav a[data-module="map"]')
      if (link && typeof link.click === 'function') {
        link.click()
        return
      }
    } catch (_) {
      // ignore
    }

    try { window.location.hash = 'map' } catch (_) { /* ignore */ }
    try { window.radioApp?.loadModule?.('map') } catch (_) { /* ignore */ }
  }

  initMap() {
    this.mapEl = document.getElementById('meshMapCanvas')
    if (!this.mapEl) return

    if (!globalThis.maplibregl) {
      this.mapEl.innerHTML = '<div class="meshSmallMuted">MapLibre not loaded. Open a map-based module once or check dependencies.</div>'
      return
    }

    // Create a map once and keep it alive.
    try {
      const c = globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 35.9606, lon: -83.9207 }
      const z = globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 6
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
          style: globalThis.buildMapLibreStyle ? globalThis.buildMapLibreStyle() : 'https://tiles.openfreemap.org/styles/liberty',
          center: [c.lon, c.lat],
          zoom: z,
          attributionControl: true,
        })
        this.map.addControl(new globalThis.maplibregl.NavigationControl(), 'top-right')
      }

      this.map.on('load', () => {
        this.mapReady = true
        this.ensureMapLayers()
        this.refreshMapOverlays()
      })
    } catch (e) {
      console.error(e)
      this.mapEl.innerHTML = `<div class="meshSmallMuted">Map init failed: ${String(e?.message || e)}</div>`
    }
  }

  ensureMapLayers() {
    if (!this.map || !this.mapReady || this.mapLayersAdded) return

    const map = this.map
    const safeAddSource = (id, src) => {
      try { if (!map.getSource(id)) map.addSource(id, src) } catch (_) { /* ignore */ }
    }
    const safeAddLayer = (layer, beforeId) => {
      try { if (!map.getLayer(layer.id)) map.addLayer(layer, beforeId) } catch (_) { /* ignore */ }
    }

    safeAddSource('meshCoverage', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    safeAddSource('meshNodes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    safeAddSource('meshMe', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })

    // Coverage points (under nodes)
    safeAddLayer({
      id: 'meshCoverageCircle',
      type: 'circle',
      source: 'meshCoverage',
      paint: {
        'circle-radius': 5,
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'opacity'],
        'circle-stroke-color': 'rgba(0,0,0,0.35)',
        'circle-stroke-width': 1,
      },
    })

    // Device position
    safeAddLayer({
      id: 'meshMeCircle',
      type: 'circle',
      source: 'meshMe',
      paint: {
        'circle-radius': 6,
        'circle-color': 'rgba(102, 194, 255, 0.95)',
        'circle-opacity': 0.9,
        'circle-stroke-color': 'rgba(0,0,0,0.35)',
        'circle-stroke-width': 1.25,
      },
    })

    // Nodes
    safeAddLayer({
      id: 'meshNodesCircle',
      type: 'circle',
      source: 'meshNodes',
      paint: {
        'circle-radius': 7,
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'opacity'],
        'circle-stroke-color': 'rgba(255,255,255,0.25)',
        'circle-stroke-width': 1.25,
      },
    })

    safeAddLayer({
      id: 'meshNodesLabel',
      type: 'symbol',
      source: 'meshNodes',
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 12,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': 'rgba(233,238,248,0.95)',
        'text-halo-color': 'rgba(0,0,0,0.55)',
        'text-halo-width': 1.25,
      },
    })

    // Click popups
    map.on('click', 'meshNodesCircle', (e) => {
      try {
        const f = e?.features?.[0]
        if (!f) return
        const coords = f.geometry?.coordinates
        const p = f.properties || {}
        this.showPopup(coords, this.nodePopupContent(p))
      } catch (_) {
        // ignore
      }
    })
    map.on('mouseenter', 'meshNodesCircle', () => { try { map.getCanvas().style.cursor = 'pointer' } catch (_) {} })
    map.on('mouseleave', 'meshNodesCircle', () => { try { map.getCanvas().style.cursor = '' } catch (_) {} })

    map.on('click', 'meshCoverageCircle', (e) => {
      try {
        const f = e?.features?.[0]
        if (!f) return
        const coords = f.geometry?.coordinates
        const p = f.properties || {}
        this.showPopup(coords, this.coveragePopupContent(p))
      } catch (_) {
        // ignore
      }
    })
    map.on('mouseenter', 'meshCoverageCircle', () => { try { map.getCanvas().style.cursor = 'pointer' } catch (_) {} })
    map.on('mouseleave', 'meshCoverageCircle', () => { try { map.getCanvas().style.cursor = '' } catch (_) {} })

    this.mapLayersAdded = true
  }

  showPopup(coords, contentEl) {
    if (!this.map || !globalThis.maplibregl || !coords || !Array.isArray(coords)) return
    try {
      if (this.popup) {
        try { this.popup.remove() } catch (_) { /* ignore */ }
        this.popup = null
      }
      const popup = new globalThis.maplibregl.Popup({ closeButton: true, closeOnClick: true })
      popup.setLngLat(coords)
      if (contentEl) popup.setDOMContent(contentEl)
      popup.addTo(this.map)
      this.popup = popup
    } catch (_) {
      // ignore
    }
  }

  nodePopupContent(p) {
    const wrap = document.createElement('div')
    wrap.style.minWidth = '220px'

    const title = document.createElement('div')
    title.style.fontWeight = '700'
    title.style.marginBottom = '6px'
    title.textContent = p?.label ? String(p.label) : 'Node'
    wrap.appendChild(title)

    const lines = []
    if (p?.num != null) lines.push(`Node: ${String(p.num)}`)
    if (p?.lastSeen) lines.push(`Last seen: ${String(p.lastSeen)}`)
    if (p?.snr != null) lines.push(`SNR: ${String(p.snr)} dB`)
    if (p?.rssi != null) lines.push(`RSSI: ${String(p.rssi)} dBm`)
    if (p?.port) lines.push(`Port: ${String(p.port)}`)
    if (p?.battery != null) lines.push(`Battery: ${String(p.battery)}%`)
    if (p?.voltage != null) lines.push(`Voltage: ${String(p.voltage)}V`)

    for (const s of lines) {
      const div = document.createElement('div')
      div.style.fontSize = '12px'
      div.style.opacity = '0.9'
      div.textContent = s
      wrap.appendChild(div)
    }

    return wrap
  }

  coveragePopupContent(p) {
    const wrap = document.createElement('div')
    wrap.style.minWidth = '220px'

    const title = document.createElement('div')
    title.style.fontWeight = '700'
    title.style.marginBottom = '6px'
    title.textContent = 'Coverage'
    wrap.appendChild(title)

    const lines = []
    if (p?.ts) lines.push(`Time: ${String(p.ts)}`)
    if (p?.from != null) lines.push(`From: ${String(p.from)}`)
    if (p?.snr != null) lines.push(`SNR: ${String(p.snr)} dB`)
    if (p?.rssi != null) lines.push(`RSSI: ${String(p.rssi)} dBm`)
    if (p?.hops != null) lines.push(`Hops: ${String(p.hops)}`)
    if (p?.acc != null) lines.push(`GPS acc: ${String(p.acc)}m`)

    for (const s of lines) {
      const div = document.createElement('div')
      div.style.fontSize = '12px'
      div.style.opacity = '0.9'
      div.textContent = s
      wrap.appendChild(div)
    }

    return wrap
  }

  updateMapSummary(state) {
    const el = document.getElementById('meshMapSummary')
    if (!el) return

    try {
      const nodes = Array.isArray(state?.nodes) ? state.nodes : (globalThis.meshGetNodes ? globalThis.meshGetNodes() : [])
      const withPos = nodes.filter((n) => n && n.position && Number.isFinite(Number(n.position.lat)) && Number.isFinite(Number(n.position.lon))).length
      const cov = globalThis.meshGetCoverageSamples ? globalThis.meshGetCoverageSamples() : []
      const covCount = Array.isArray(cov) ? cov.length : 0
      el.textContent = `Nodes: ${nodes.length} (${withPos} with position) | Coverage points: ${covCount}`
    } catch (_) {
      el.textContent = ''
    }
  }

  refreshMapOverlays(state) {
    if (!this.map || !this.mapReady) return
    this.ensureMapLayers()

    const s = state || (globalThis.xcomMesh ? globalThis.xcomMesh.getState() : null)
    const nodes = Array.isArray(s?.nodes) ? s.nodes : (globalThis.meshGetNodes ? globalThis.meshGetNodes() : [])
    const cov = globalThis.meshGetCoverageSamples ? globalThis.meshGetCoverageSamples() : []

    this.updateMeSource()
    this.updateNodesSource(nodes)
    this.updateCoverageSource(Array.isArray(cov) ? cov : [])
  }

  updateMeSource() {
    if (!this.map) return
    const src = this.map.getSource('meshMe')
    if (!src || typeof src.setData !== 'function') return
    const g = this.lastGeo
    const lat = Number(g?.lat)
    const lon = Number(g?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    src.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {},
        },
      ],
    })
  }

  updateNodesSource(nodes) {
    if (!this.map) return
    const src = this.map.getSource('meshNodes')
    if (!src || typeof src.setData !== 'function') return

    if (!this.showNodes) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }

    const now = Date.now()
    const feats = []
    for (const n of Array.isArray(nodes) ? nodes : []) {
      const pos = n?.position
      const lat = Number(pos?.lat)
      const lon = Number(pos?.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

      const label = meshNodeDisplayName(n, `#${n?.num ?? ''}`)
      const lastSeenTs = Number(n?.lastSeenTs || 0) || 0
      const ageMin = lastSeenTs ? Math.max(0, (now - lastSeenTs) / 60000) : 9999
      const opacity = ageMin <= 10 ? 0.9 : ageMin <= 60 ? 0.65 : 0.35

      const snr = Number.isFinite(Number(n?.lastSnr)) ? Number(n.lastSnr) : null
      const rssi = Number.isFinite(Number(n?.lastRssi)) ? Number(n.lastRssi) : null
      const color = (snr != null) ? this.colorForSnr(snr) : (rssi != null) ? this.colorForRssi(rssi) : 'rgba(159,178,198,0.85)'

      feats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          num: n?.num ?? null,
          label,
          color,
          opacity,
          snr,
          rssi,
          port: n?.lastPort ?? null,
          lastSeen: lastSeenTs ? new Date(lastSeenTs).toISOString() : null,
          battery: n?.device?.batteryLevel ?? null,
          voltage: n?.device?.voltage ?? null,
        },
      })
    }

    src.setData({ type: 'FeatureCollection', features: feats })
  }

  updateCoverageSource(samples) {
    if (!this.map) return
    const src = this.map.getSource('meshCoverage')
    if (!src || typeof src.setData !== 'function') return

    if (!this.showCoverage) {
      src.setData({ type: 'FeatureCollection', features: [] })
      return
    }

    const feats = []
    const metric = this.coverageMetric === 'rssi' ? 'rssi' : 'snr'

    for (const s of Array.isArray(samples) ? samples : []) {
      const lat = Number(s?.lat)
      const lon = Number(s?.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue

      const snr = Number.isFinite(Number(s?.snr)) ? Number(s.snr) : null
      const rssi = Number.isFinite(Number(s?.rssi)) ? Number(s.rssi) : null
      const v = metric === 'rssi' ? rssi : snr
      const color = (metric === 'rssi')
        ? (rssi != null ? this.colorForRssi(rssi) : 'rgba(159,178,198,0.65)')
        : (snr != null ? this.colorForSnr(snr) : 'rgba(159,178,198,0.65)')
      const opacity = 0.75

      const ts = Number(s?.ts || 0) || 0
      const hopStart = Number.isFinite(Number(s?.hopStart)) ? Number(s.hopStart) : null
      const hopLimit = Number.isFinite(Number(s?.hopLimit)) ? Number(s.hopLimit) : null
      const hops = (hopStart != null && hopLimit != null) ? Math.max(0, hopStart - hopLimit) : null

      feats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          color,
          opacity,
          ts: ts ? new Date(ts).toISOString() : null,
          from: s?.from ?? null,
          snr,
          rssi,
          hopStart,
          hopLimit,
          hops,
          acc: s?.acc ?? null,
          v,
        },
      })
    }

    src.setData({ type: 'FeatureCollection', features: feats })
  }

  colorForSnr(snr) {
    const n = Number(snr)
    if (!Number.isFinite(n)) return 'rgba(159,178,198,0.85)'
    if (n >= 8) return 'rgba(46, 230, 166, 0.95)'     // good
    if (n >= 3) return 'rgba(246, 201, 69, 0.95)'     // warn
    return 'rgba(255, 77, 79, 0.95)'                  // bad
  }

  colorForRssi(rssi) {
    const n = Number(rssi)
    if (!Number.isFinite(n)) return 'rgba(159,178,198,0.85)'
    if (n >= -75) return 'rgba(46, 230, 166, 0.95)'
    if (n >= -95) return 'rgba(246, 201, 69, 0.95)'
    return 'rgba(255, 77, 79, 0.95)'
  }

  async startCoverageLogging() {
    if (!navigator.geolocation) {
      alert('Geolocation not available in this browser/device.')
      return
    }

    // Prevent backfilling old traffic with the current location.
    try {
      const traffic = globalThis.xcomMesh ? globalThis.xcomMesh.getState()?.traffic : []
      this._lastTrafficLen = Array.isArray(traffic) ? traffic.length : 0
    } catch (_) {
      this._lastTrafficLen = 0
    }

    const opts = { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    this.coverageLogging = true
    this.updateCoverageStatusUi()

    try {
      this.geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          try {
            const c = pos?.coords
            if (!c) return
            this.lastGeo = {
              lat: c.latitude,
              lon: c.longitude,
              acc: c.accuracy,
              alt: c.altitude,
              ts: pos?.timestamp || Date.now(),
            }
            this.updateCoverageStatusUi()
            this.updateMeSource()
          } catch (_) {
            // ignore
          }
        },
        (err) => {
          console.warn('Geolocation error', err)
          alert(`Geolocation error: ${err?.message || String(err)}`)
          this.stopCoverageLogging()
        },
        opts,
      )
    } catch (e) {
      alert(`Failed to start geolocation: ${e?.message || e}`)
      this.stopCoverageLogging()
    }
  }

  stopCoverageLogging() {
    this.coverageLogging = false
    if (this.geoWatchId != null) {
      try { navigator.geolocation.clearWatch(this.geoWatchId) } catch (_) { /* ignore */ }
    }
    this.geoWatchId = null
    this.updateCoverageStatusUi()
  }

  updateCoverageStatusUi() {
    const btn = document.getElementById('meshCoverageLogBtn')
    const status = document.getElementById('meshCoverageStatus')
    if (btn) btn.textContent = this.coverageLogging ? 'Stop Logging' : 'Start Logging'
    if (!status) return

    if (!this.coverageLogging) {
      status.textContent = 'Logging is OFF. Turn it on to record coverage points when packets are received.'
      return
    }

    const g = this.lastGeo
    const lat = Number(g?.lat)
    const lon = Number(g?.lon)
    const acc = Number(g?.acc)
    const loc = (Number.isFinite(lat) && Number.isFinite(lon)) ? `${lat.toFixed(5)},${lon.toFixed(5)}` : '(waiting for GPS…)'
    const accTxt = Number.isFinite(acc) ? ` ±${Math.round(acc)}m` : ''
    status.textContent = `Logging ON. Last GPS: ${loc}${accTxt}`
  }

  centerOnMe() {
    if (!this.map) return
    const g = this.lastGeo
    const lat = Number(g?.lat)
    const lon = Number(g?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      alert('No GPS fix yet. Start logging first, or allow location access.')
      return
    }
    try {
      this.map.easeTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 13), duration: 600 })
    } catch (_) {
      // ignore
    }
  }

  processNewTrafficForCoverage(state) {
    const traffic = Array.isArray(state?.traffic) ? state.traffic : []
    if (!this.coverageLogging) {
      this._lastTrafficLen = traffic.length
      return
    }

    const g = this.lastGeo
    const lat = Number(g?.lat)
    const lon = Number(g?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      this._lastTrafficLen = traffic.length
      return
    }

    const start = Math.max(0, Math.min(traffic.length, Number(this._lastTrafficLen || 0)))
    for (let i = start; i < traffic.length; i++) {
      const e = traffic[i]
      if (!e || e.dir !== 'in') continue

      const ts = Number(e.ts || Date.now())
      const from = Number.isFinite(Number(e.from)) ? Number(e.from) : null
      const snr = Number.isFinite(Number(e.rxSnr)) ? Number(e.rxSnr) : null
      const rssi = Number.isFinite(Number(e.rxRssi)) ? Number(e.rxRssi) : null
      const hopStart = Number.isFinite(Number(e.hopStart)) ? Number(e.hopStart) : null
      const hopLimit = Number.isFinite(Number(e.hopLimit)) ? Number(e.hopLimit) : null

      // Downsample: ignore rapid repeats at roughly the same location.
      try {
        if (this._lastCov && typeof this._lastCov === 'object') {
          const dt = ts - Number(this._lastCov.ts || 0)
          const d = this.distanceMeters(lat, lon, Number(this._lastCov.lat), Number(this._lastCov.lon))
          if (Number.isFinite(dt) && dt < 7000 && Number.isFinite(d) && d < 20) continue
        }
      } catch (_) {
        // ignore
      }

      const sample = {
        ts,
        lat,
        lon,
        acc: Number.isFinite(Number(g?.acc)) ? Math.round(Number(g.acc)) : undefined,
        from: from ?? undefined,
        snr: snr ?? undefined,
        rssi: rssi ?? undefined,
        hopStart: hopStart ?? undefined,
        hopLimit: hopLimit ?? undefined,
        channel: Number.isFinite(Number(e.channel)) ? Number(e.channel) : undefined,
        portnum: e.portnum != null ? String(e.portnum) : undefined,
      }

      try {
        if (globalThis.meshAppendCoverageSample) globalThis.meshAppendCoverageSample(sample)
      } catch (_) {
        // ignore
      }

      this._lastCov = { ts, lat, lon }
    }

    this._lastTrafficLen = traffic.length
  }

  distanceMeters(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (deg * Math.PI) / 180
    const R = 6371000
    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  renderSquadResults() {
    const statusEl = document.getElementById('meshSquadStatus')
    if (!statusEl) return

    const results = Array.isArray(this.squadResults) ? this.squadResults : []
    if (!results.length) {
      const haveRoster = typeof globalThis.xcomListSquads === 'function' && typeof globalThis.xcomListRosterMembers === 'function'
      if (!haveRoster) {
        statusEl.textContent = 'Tip: import roster bundle from XTOC to enable squad messaging.'
        return
      }

      const squads = globalThis.xcomListSquads?.() || []
      statusEl.textContent = Array.isArray(squads) && squads.length ? '' : 'No squads found in roster.'
      return
    }

    statusEl.innerHTML = ''
    for (const r of results) {
      const base = `U${r.unitId} • ${r.label}`
      const okLabel = String(r?.meshKey || '').startsWith('meshtastic:') ? 'ACK' : 'OK'
      const status =
        r.status === 'sending'
          ? 'Sending…'
          : r.status === 'ok'
            ? `${okLabel}${r.id != null ? ` (id=${r.id})` : ''}`
            : r.status === 'error'
              ? `ERR: ${r.error || 'Unknown error'}`
              : 'Pending'
      const div = document.createElement('div')
      div.textContent = `${base} — ${status}`
      statusEl.appendChild(div)
    }
  }

  async sendSquad() {
    if (this.squadSending) return
    if (typeof globalThis.meshSendText !== 'function') throw new Error('Mesh transport not loaded')
    if (typeof globalThis.getMeshConfig !== 'function') throw new Error('Mesh config not available')

    const state = globalThis.xcomMesh?.getState?.() || null
    const connected = !!state?.status?.connected
    if (!connected) throw new Error('Mesh not connected')

    const sid = String(document.getElementById('meshSquadSelect')?.value || '').trim()
    if (!sid) throw new Error('Pick a squad')

    const msg = String(document.getElementById('meshSquadText')?.value || '').trim()
    if (!msg) throw new Error('Nothing to send')

    const haveRoster = typeof globalThis.xcomListSquads === 'function' && typeof globalThis.xcomListRosterMembers === 'function'
    if (!haveRoster) throw new Error('Roster not loaded. Import roster bundle from XTOC.')

    const cfg = globalThis.getMeshConfig() || {}
    const driver = (cfg?.driver === 'meshcore') ? 'meshcore' : 'meshtastic'
    const mt = (cfg && cfg.meshtastic) ? cfg.meshtastic : {}
    const mc = (cfg && cfg.meshcore) ? cfg.meshcore : {}
    const active = (driver === 'meshcore') ? mc : mt

    const squads = globalThis.xcomListSquads() || []
    const squad = Array.isArray(squads) ? (squads.find((s) => String(s?.id || '').trim() === sid) || null) : null
    const squadLabel = squad
      ? (String(squad?.callsign || '').trim() ? `${String(squad.callsign).trim()} (${String(squad?.name || '').trim() || sid})` : String(squad?.name || '').trim() || sid)
      : sid

    const members = globalThis.xcomListRosterMembers() || []
    const driverPrefix = `${driver}:`
    const targets = []
    for (const m of Array.isArray(members) ? members : []) {
      const msid = String(m?.squadId || '').trim()
      if (msid !== sid) continue
      const meshKey = String(m?.meshNodeId || '').trim()
      if (!meshKey || !meshKey.startsWith(driverPrefix)) continue
      const toNodeId = meshKey.slice(driverPrefix.length).trim()
      if (!toNodeId) continue
      const unitId = Number(m?.unitId)
      const safeUnitId = Number.isFinite(unitId) ? Math.floor(unitId) : 0
      const label = String(m?.label || '').trim() || meshKey
      targets.push({ unitId: safeUnitId, label, meshKey, toNodeId, status: 'pending' })
    }

    if (!targets.length) throw new Error(`No squad members have ${driver} meshNodeId assigned.`)

    const ok = confirm(`Send direct message to ${targets.length} member(s) in ${squadLabel}?`)
    if (!ok) return

    this.squadResults = targets
    this.renderSquadResults()

    this.squadSending = true
    this.renderFromState()
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]
        t.status = 'sending'
        t.error = undefined
        this.renderSquadResults()

        try {
          const res = driver === 'meshcore'
            ? await globalThis.meshSendText(msg, { destination: 'direct', toNodeId: t.toNodeId, channel: active?.channel })
            : await globalThis.meshSendText(msg, { destination: 'direct', toNodeId: t.toNodeId, channel: active?.channel, wantAck: mt.wantAck !== false })

          if (typeof res === 'number') t.id = res
          t.status = 'ok'
        } catch (e) {
          t.status = 'error'
          t.error = formatError(e)
        }

        this.renderSquadResults()
      }
    } finally {
      this.squadSending = false
      this.renderFromState()
    }
  }

  async sendText(text) {
    const msg = String(text || '').trim()
    if (!msg) throw new Error('Nothing to send')
    if (!globalThis.meshSendText) throw new Error('Mesh transport not loaded')
    await globalThis.meshSendText(msg)
    window.radioApp.updateStatus('Sent via mesh')
  }
}
