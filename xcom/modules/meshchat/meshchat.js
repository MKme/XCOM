/**
 * XCOM MeshChat module (Reticulum bridge)
 * - Connect to reticulum-bridge over LAN/localhost (HTTP publish + poll)
 * - View Reticulum status, peers, interfaces
 * - Configure broadcast/direct destination
 * - Test send + view traffic
 */

function meshchatUiFormatError(e) {
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

const LS_MESHCHAT_DEVICE_LINKS = 'xcom.meshchat.deviceLinks.v1'

function meshchatReadDeviceLinks() {
  try {
    const raw = localStorage.getItem(LS_MESHCHAT_DEVICE_LINKS)
    if (!raw) return []
    const json = JSON.parse(raw)
    return Array.isArray(json) ? json : []
  } catch (_) {
    return []
  }
}

function meshchatWriteDeviceLinks(links) {
  try {
    localStorage.setItem(LS_MESHCHAT_DEVICE_LINKS, JSON.stringify(Array.isArray(links) ? links : []))
  } catch (_) {
    // ignore
  }
}

function meshchatFmtAgo(ms, now) {
  if (!ms) return '-'
  const d = Math.max(0, (now || Date.now()) - Number(ms))
  if (d < 1500) return 'now'
  if (d < 60000) return `${Math.round(d / 1000)}s ago`
  if (d < 60 * 60000) return `${Math.round(d / 60000)}m ago`
  return `${Math.round(d / (60 * 60000))}h ago`
}

function meshchatTrafficText(entries) {
  const list = Array.isArray(entries) ? entries : []
  return list.slice(-400).map((e) => {
    const ts = new Date(e.ts || Date.now()).toISOString()
    if (e.dir === 'sys') return `${ts}  SYS  ${(String(e.level || '')).toUpperCase().padEnd(5)} ${e.msg || ''}`
    if (e.dir === 'out') {
      const dest = String(e?.data?.destination || '')
      const toHash = String(e?.data?.toHash || '').trim()
      const tag = dest === 'direct' && toHash ? `DM ${toHash.slice(0, 12)}...` : dest ? dest.toUpperCase() : ''
      const prefix = tag ? `[${tag}] ` : ''
      return `${ts}  OUT  ${prefix}${(String(e.text || '')).replace(/\\s+/g, ' ').trim()}`
    }
    if (e.dir === 'in') {
      const from = e.from || {}
      const peerHash = String(from?.peer?.hash || '').trim()
      const fromLabel = peerHash ? `${peerHash.slice(0, 12)}...` : (from.label || from.client_id || from.clientId || '')
      const via = String(e?.data?.via || '').trim()
      const tag = [fromLabel ? `from ${fromLabel}` : '', via ? `via ${via}` : ''].filter(Boolean).join(' | ')
      const prefix = tag ? `[${tag}] ` : ''
      return `${ts}  IN   ${prefix}${(String(e.text || '')).replace(/\\s+/g, ' ').trim()}`
    }
    return `${ts}  ?    ${JSON.stringify(e)}`
  }).join('\\n')
}

function meshchatNormalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/$/, '')
}

function meshchatParseProvisioningText(text) {
  const t = String(text || '').trim()
  const prefix = 'XTOC-RNS.'
  if (!t.startsWith(prefix)) return null

  try {
    const json = atob(t.slice(prefix.length))
    const obj = JSON.parse(json)
    if (!obj || typeof obj !== 'object') return null
    if (Number(obj.v) !== 1) return null
    if (!Array.isArray(obj.urls)) return null
    const urls = obj.urls.map((u) => meshchatNormalizeBaseUrl(u)).filter(Boolean)
    if (!urls.length) return null
    return { v: 1, port: Number(obj.port) || undefined, urls, destinationHash: obj.destinationHash ? String(obj.destinationHash) : undefined }
  } catch (_) {
    return null
  }
}

function meshchatCoerceBaseUrlFromText(text) {
  const t = String(text || '').trim()
  if (!/^https?:\/\//i.test(t)) return null
  try {
    const u = new URL(t)
    if (!u.hostname) return null
    return meshchatNormalizeBaseUrl(`${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`)
  } catch (_) {
    return meshchatNormalizeBaseUrl(t)
  }
}

async function meshchatProbeHealth(baseUrl, timeoutMs = 2000) {
  const base = meshchatNormalizeBaseUrl(baseUrl)
  if (!base) return false

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), Math.max(200, Number(timeoutMs) || 2000))
  try {
    const res = await fetch(`${base}/health`, { cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) return false
    const json = await res.json()
    return !!json?.ok
  } catch (_) {
    return false
  } finally {
    try { clearTimeout(t) } catch (_) { /* ignore */ }
  }
}

async function meshchatPickReachableUrl(urls, timeoutMs = 2000) {
  const list = Array.isArray(urls) ? urls : []
  for (const u of list) {
    const base = meshchatNormalizeBaseUrl(u)
    if (!base) continue
    // eslint-disable-next-line no-await-in-loop
    const ok = await meshchatProbeHealth(base, timeoutMs)
    if (ok) return base
  }
  return null
}

// eslint-disable-next-line no-unused-vars
class MeshChatModule {
  constructor() {
    this.unsub = null
    this.links = meshchatReadDeviceLinks()
    this.init()
  }

  init() {
    this.createModuleStructure()
    this.bindEvents()
    this.renderFromState()

    this.unsub = (globalThis.xcomReticulum && typeof globalThis.xcomReticulum.subscribe === 'function')
      ? globalThis.xcomReticulum.subscribe(() => this.renderFromState())
      : null

    window.radioApp.updateStatus('MeshChat module loaded')
  }

  destroy() {
    try { if (this.unsub) this.unsub() } catch (_) { /* ignore */ }
    this.unsub = null
  }

  createModuleStructure() {
    const root = document.getElementById('meshchat')
    if (!root) return

    root.innerHTML = `
      <div class="xModuleIntro">
        <div class="xModuleIntroTitle">What you can do here</div>
        <div class="xModuleIntroText">
          Connect XCOM to <strong>Reticulum (RNS)</strong> using the <strong>reticulum-bridge</strong> helper, then send/receive XTOC packet text over an RNode (serial or Bluetooth).
        </div>
      </div>

      <div class="meshchatShell">
        <div class="meshchatCard meshchatSpanFull">
          <div class="meshchatCardTitle">MeshChat (Reticulum)</div>
          <div class="meshchatSmallMuted">
            Run the bridge on the device connected to the RNode. In XTOC, use MeshChat -> Share Bridge QR (or open <code>/share</code>).
          </div>

          <div class="meshchatRow">
            <label>Status</label>
            <div id="meshchatStatus" class="meshchatStatusPill">Disconnected</div>
            <div id="meshchatStatusMeta" class="meshchatSmallMuted"></div>
          </div>

          <div class="meshchatButtonRow">
            <button id="meshchatConnectBtn" type="button" class="primary">Connect</button>
            <button id="meshchatDisconnectBtn" type="button" class="danger">Disconnect</button>
            <button id="meshchatAnnounceBtn" type="button">Announce</button>
            <button id="meshchatClearLogBtn" type="button">Clear Log</button>
            <label class="meshchatInline"><input id="meshchatAutoReconnect" type="checkbox" checked /> Auto-reconnect</label>
            <label class="meshchatInline"><input id="meshchatAutoImport" type="checkbox" checked /> Auto decode packets</label>
          </div>
        </div>

        <div class="meshchatCard">
          <div class="meshchatCardTitle">Settings</div>

          <div class="meshchatRow">
            <label>Bridge URL</label>
            <input id="meshchatBaseUrl" type="text" placeholder="http://10.0.0.5:8096" />
          </div>

          <div class="meshchatButtonRow">
            <button id="meshchatScanBridgeQrBtn" type="button" class="primary">Scan Bridge QR</button>
          </div>
          <div class="meshchatSmallMuted" style="margin-top: 6px;">
            Scan the <code>XTOC-RNS</code> QR from the XTOC MeshChat page to auto-configure this device.
          </div>

          <div class="meshchatGrid2">
            <div class="meshchatRow">
              <label>This device label</label>
              <input id="meshchatLabel" type="text" placeholder="XCOM" />
            </div>
            <div class="meshchatRow">
              <label>Role</label>
              <select id="meshchatRole">
                <option value="client" selected>Client (XCOM)</option>
                <option value="master">Master (XTOC)</option>
              </select>
            </div>
          </div>

          <div class="meshchatGrid2">
            <div class="meshchatRow">
              <label>Destination</label>
              <select id="meshchatDest">
                <option value="broadcast" selected>Broadcast</option>
                <option value="direct">Direct</option>
              </select>
            </div>
            <div class="meshchatRow">
              <label>To Hash (direct)</label>
              <input id="meshchatToHash" type="text" placeholder="Destination hash (hex)" />
            </div>
          </div>

          <div class="meshchatRow">
            <label>Poll interval (ms)</label>
            <input id="meshchatPollMs" type="number" min="250" max="60000" step="50" />
          </div>
        </div>

        <div class="meshchatCard">
          <div class="meshchatCardTitle">Send message</div>
          <div class="meshchatRow">
            <label>Text</label>
            <textarea id="meshchatSendText" rows="3" placeholder="Type a short message or an XTOC packet line"></textarea>
          </div>
          <div class="meshchatButtonRow">
            <button id="meshchatSendBtn" type="button" class="primary">Send</button>
          </div>
          <div class="meshchatSmallMuted">
            Tip: In <strong>XTOC Comm</strong>, select <strong>Reticulum</strong> transport and use <strong>Connect + Send</strong>.
          </div>
        </div>

        <div class="meshchatCard meshchatSpanFull">
          <div class="meshchatCardTitle">Chat View</div>
          <div id="meshchatChatHint" class="meshchatSmallMuted" style="margin-bottom: 10px;"></div>
          <div id="meshchatChatList" class="meshchatChatList"></div>
        </div>

        <div class="meshchatCard">
          <div class="meshchatCardTitle">Peers</div>
          <div id="meshchatPeers" class="meshchatSmallMuted">No peers yet.</div>
        </div>

        <div class="meshchatCard">
          <div class="meshchatCardTitle">Reticulum interfaces</div>
          <pre id="meshchatInterfaces" class="meshchatPre"></pre>
        </div>

        <div class="meshchatCard meshchatSpanFull">
          <div class="meshchatCardTitle">Traffic</div>
          <pre id="meshchatTraffic" class="meshchatPre"></pre>
        </div>

        <div class="meshchatCard meshchatSpanFull">
          <div class="meshchatCardTitle">Device Config Shortcuts</div>
          <div class="meshchatSmallMuted" style="margin-bottom: 10px;">
            Add links to bridge health pages, router/AP UI pages, etc.
          </div>

          <div class="meshchatGrid2">
            <div class="meshchatRow">
              <label>Label</label>
              <input id="meshchatNewLinkLabel" type="text" placeholder="Bridge health" />
            </div>
            <div class="meshchatRow">
              <label>URL</label>
              <input id="meshchatNewLinkUrl" type="text" placeholder="http://127.0.0.1:8096/health" />
            </div>
          </div>
          <div class="meshchatButtonRow">
            <button id="meshchatAddLinkBtn" type="button" class="primary">Add shortcut</button>
          </div>

          <div id="meshchatLinks"></div>
        </div>
      </div>
    `
  }

  bindEvents() {
    const connectBtn = document.getElementById('meshchatConnectBtn')
    const disconnectBtn = document.getElementById('meshchatDisconnectBtn')
    const announceBtn = document.getElementById('meshchatAnnounceBtn')
    const clearLogBtn = document.getElementById('meshchatClearLogBtn')
    const scanBtn = document.getElementById('meshchatScanBridgeQrBtn')
    const sendBtn = document.getElementById('meshchatSendBtn')

    if (connectBtn) connectBtn.addEventListener('click', () => this.connect())
    if (disconnectBtn) disconnectBtn.addEventListener('click', () => this.disconnect())
    if (announceBtn) announceBtn.addEventListener('click', () => this.announce())
    if (clearLogBtn) clearLogBtn.addEventListener('click', () => this.clearLog())
    if (scanBtn) scanBtn.addEventListener('click', () => void this.scanBridgeQr())
    if (sendBtn) sendBtn.addEventListener('click', () => void this.sendTest())

    const baseUrlEl = document.getElementById('meshchatBaseUrl')
    if (baseUrlEl) baseUrlEl.addEventListener('change', () => this.updateCfgFromInputs())
    const labelEl = document.getElementById('meshchatLabel')
    if (labelEl) labelEl.addEventListener('change', () => this.updateCfgFromInputs())
    const roleEl = document.getElementById('meshchatRole')
    if (roleEl) roleEl.addEventListener('change', () => this.updateCfgFromInputs())
    const destEl = document.getElementById('meshchatDest')
    if (destEl) destEl.addEventListener('change', () => this.updateCfgFromInputs())
    const toHashEl = document.getElementById('meshchatToHash')
    if (toHashEl) toHashEl.addEventListener('change', () => this.updateCfgFromInputs())
    const pollEl = document.getElementById('meshchatPollMs')
    if (pollEl) pollEl.addEventListener('change', () => this.updateCfgFromInputs())
    const autoRecEl = document.getElementById('meshchatAutoReconnect')
    if (autoRecEl) autoRecEl.addEventListener('change', () => this.updateCfgFromInputs())
    const autoImpEl = document.getElementById('meshchatAutoImport')
    if (autoImpEl) autoImpEl.addEventListener('change', () => this.updateCfgFromInputs())

    const addLinkBtn = document.getElementById('meshchatAddLinkBtn')
    if (addLinkBtn) addLinkBtn.addEventListener('click', () => this.addLink())
  }

  getStateSafe() {
    try {
      if (globalThis.xcomReticulum && typeof globalThis.xcomReticulum.getState === 'function') return globalThis.xcomReticulum.getState()
    } catch (_) {
      // ignore
    }
    return null
  }

  getConfigSafe() {
    try {
      if (typeof globalThis.getReticulumConfig === 'function') return globalThis.getReticulumConfig()
    } catch (_) {
      // ignore
    }
    return null
  }

  setConfigSafe(patch) {
    try {
      if (typeof globalThis.setReticulumConfig === 'function') return globalThis.setReticulumConfig(patch)
    } catch (_) {
      // ignore
    }
    return null
  }

  updateCfgFromInputs() {
    const baseUrl = String(document.getElementById('meshchatBaseUrl')?.value || '').trim()
    const label = String(document.getElementById('meshchatLabel')?.value || '').trim()
    const role = String(document.getElementById('meshchatRole')?.value || '').trim() === 'master' ? 'master' : 'client'

    const destination = String(document.getElementById('meshchatDest')?.value || '').trim() === 'direct' ? 'direct' : 'broadcast'
    const toHash = String(document.getElementById('meshchatToHash')?.value || '').trim()

    const pollMs = Math.floor(Number(document.getElementById('meshchatPollMs')?.value || 0)) || undefined
    const autoReconnect = !!document.getElementById('meshchatAutoReconnect')?.checked
    const autoImport = !!document.getElementById('meshchatAutoImport')?.checked

    this.setConfigSafe({
      baseUrl,
      client: { label, role },
      send: { destination, toHash },
      ui: { ...(pollMs ? { pollMs } : {}), autoReconnect, autoImport },
    })
    this.renderFromState()
  }

  statusClass(status) {
    if (status?.connected) return 'ok'
    if (status?.reconnecting) return 'warn'
    if (status?.lastError) return 'warn'
    return ''
  }

  renderPeers(peers) {
    const el = document.getElementById('meshchatPeers')
    if (!el) return
    const list = Array.isArray(peers) ? peers : []
    if (!list.length) {
      el.innerHTML = 'No peers yet.'
      return
    }

    const rows = list
      .slice()
      .sort((a, b) => Number(b?.last_seen_ms || 0) - Number(a?.last_seen_ms || 0))
      .map((p) => {
        const hash = String(p?.hash || '').trim()
        const hops = Number.isFinite(Number(p?.hops)) ? Math.floor(Number(p.hops)) : null
        const last = Number(p?.last_seen_ms || 0) || 0
        let name = ''
        try {
          const raw = String(p?.app_data || '').trim()
          if (raw) {
            const obj = JSON.parse(raw)
            if (obj && typeof obj === 'object' && typeof obj?.name === 'string') name = String(obj.name).trim()
          }
        } catch (_) {
          // ignore
        }
        const label = name || (hash ? `${hash.slice(0, 12)}...` : 'Peer')
        const meta = [
          hops != null ? `hops ${hops}` : '',
          last ? meshchatFmtAgo(last, Date.now()) : '',
        ].filter(Boolean).join(' | ')

        return `
          <div class="meshchatClientRow">
            <div style="display:flex; justify-content:space-between; gap:10px;">
              <div>
                <div><strong>${label}</strong></div>
                <div class="meshchatSmallMuted">Hash: <code>${hash}</code></div>
              </div>
              <div class="meshchatSmallMuted" style="text-align:right;">
                ${meta}
              </div>
            </div>
            <div class="meshchatButtonRow" style="margin-top:8px;">
              <button type="button" class="primary" data-peer-hash="${hash}">Set Direct</button>
            </div>
          </div>
        `
      })

    el.innerHTML = rows.join('') || 'No peers yet.'

    const buttons = Array.from(el.querySelectorAll('button[data-peer-hash]'))
    for (const b of buttons) {
      b.addEventListener('click', () => {
        const h = String(b.getAttribute('data-peer-hash') || '').trim()
        if (!h) return
        this.setConfigSafe({ send: { destination: 'direct', toHash: h } })
        this.renderFromState()
      })
    }
  }

  renderLinks() {
    const wrap = document.getElementById('meshchatLinks')
    if (!wrap) return

    const list = Array.isArray(this.links) ? this.links : []
    if (!list.length) {
      wrap.innerHTML = `<div class="meshchatSmallMuted">No shortcuts yet.</div>`
      return
    }

    wrap.innerHTML = list.map((d) => `
      <div class="meshchatLinkRow">
        <div>
          <div><strong>${String(d.label || 'Device')}</strong></div>
          <div class="meshchatSmallMuted">${String(d.url || '')}</div>
        </div>
        <div class="meshchatButtonRow" style="margin-top:0;">
          <button type="button" class="primary" data-open="${String(d.id)}">Open</button>
          <button type="button" class="danger" data-remove="${String(d.id)}">Remove</button>
        </div>
      </div>
    `).join('')

    const openBtns = Array.from(wrap.querySelectorAll('button[data-open]'))
    for (const btn of openBtns) {
      btn.addEventListener('click', () => {
        const id = String(btn.getAttribute('data-open') || '')
        const item = (Array.isArray(this.links) ? this.links : []).find((x) => x && x.id === id)
        if (!item) return
        this.openLink(item.url)
      })
    }

    const rmBtns = Array.from(wrap.querySelectorAll('button[data-remove]'))
    for (const btn of rmBtns) {
      btn.addEventListener('click', () => {
        const id = String(btn.getAttribute('data-remove') || '')
        this.removeLink(id)
      })
    }
  }

  renderFromState() {
    const s = this.getStateSafe()
    const cfg = s?.config || this.getConfigSafe() || {}
    const status = s?.status || {}

    const statusEl = document.getElementById('meshchatStatus')
    if (statusEl) {
      statusEl.textContent = status?.reconnecting
        ? `Reconnecting (attempt ${Number(status?.reconnectAttempt || 1)})`
        : status?.connected
          ? 'Connected'
          : status?.lastError
            ? 'Disconnected (error)'
            : 'Disconnected'
      statusEl.className = `meshchatStatusPill ${this.statusClass(status)}`
    }

    const metaEl = document.getElementById('meshchatStatusMeta')
    if (metaEl) {
      const bs = status?.bridgeStatus || {}
      const localHash = bs?.destinationHash ? String(bs.destinationHash) : ''
      const broadcastHash = bs?.broadcastHash ? String(bs.broadcastHash) : ''
      const maxBytes = Number(bs?.maxTextBytes) || 0
      const parts = []
      if (cfg?.baseUrl) parts.push(`Bridge: ${String(cfg.baseUrl)}`)
      if (localHash) parts.push(`Local hash: ${localHash}`)
      if (broadcastHash) parts.push(`Broadcast hash: ${broadcastHash}`)
      if (maxBytes) parts.push(`Max bytes: ${maxBytes}`)
      if (status?.lastError) parts.push(`Error: ${String(status.lastError)}`)
      metaEl.textContent = parts.join(' | ')
    }

    const baseUrlEl = document.getElementById('meshchatBaseUrl')
    if (baseUrlEl && document.activeElement !== baseUrlEl) baseUrlEl.value = String(cfg?.baseUrl || '')
    const labelEl = document.getElementById('meshchatLabel')
    if (labelEl && document.activeElement !== labelEl) labelEl.value = String(cfg?.client?.label || 'XCOM')
    const roleEl = document.getElementById('meshchatRole')
    if (roleEl && document.activeElement !== roleEl) roleEl.value = String(cfg?.client?.role || 'client') === 'master' ? 'master' : 'client'
    const destEl = document.getElementById('meshchatDest')
    if (destEl && document.activeElement !== destEl) destEl.value = String(cfg?.send?.destination || 'broadcast') === 'direct' ? 'direct' : 'broadcast'
    const toHashEl = document.getElementById('meshchatToHash')
    if (toHashEl && document.activeElement !== toHashEl) toHashEl.value = String(cfg?.send?.toHash || '')
    const pollEl = document.getElementById('meshchatPollMs')
    if (pollEl && document.activeElement !== pollEl) pollEl.value = String(cfg?.ui?.pollMs || 900)
    const autoRecEl = document.getElementById('meshchatAutoReconnect')
    if (autoRecEl) autoRecEl.checked = cfg?.ui?.autoReconnect !== false
    const autoImpEl = document.getElementById('meshchatAutoImport')
    if (autoImpEl) autoImpEl.checked = cfg?.ui?.autoImport !== false

    const peers = Array.isArray(s?.peers) ? s.peers : []
    this.renderPeers(peers)

    // chat view (broadcast or direct)
    try {
      const cleanHex = (raw) => String(raw || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '')
      const destination = String(cfg?.send?.destination || 'broadcast') === 'direct' ? 'direct' : 'broadcast'
      const selectedTo = destination === 'direct' ? cleanHex(String(cfg?.send?.toHash || '')) : ''
      const myLabel = String(cfg?.client?.label || 'XCOM').trim() || 'You'
      const myRole = String(cfg?.client?.role || '').trim()

      const peerByHash = new Map()
      for (const p of Array.isArray(peers) ? peers : []) {
        const h = cleanHex(String(p?.hash || ''))
        if (!h) continue
        let name = ''
        try {
          const raw = String(p?.app_data || '').trim()
          if (raw) {
            const obj = JSON.parse(raw)
            if (obj && typeof obj === 'object' && typeof obj?.name === 'string') name = String(obj.name).trim()
          }
        } catch (_) {
          // ignore
        }
        const hops = Number.isFinite(Number(p?.hops)) ? Math.floor(Number(p.hops)) : null
        peerByHash.set(h, { name, hops })
      }

      const peerDisplay = (hash) => {
        const h = cleanHex(hash)
        if (!h) return { shortName: 'Peer', longName: '', hash: '' }
        const rec = peerByHash.get(h) || null
        const name = rec?.name || ''
        const hops = rec?.hops ?? null
        const shortName = name || `${h.slice(0, 12)}...`
        const bits = []
        if (name) bits.push(`${h.slice(0, 12)}...`)
        if (hops != null) bits.push(`hops ${hops}`)
        return { shortName, longName: bits.join(' | '), hash: h }
      }

      const hintEl = document.getElementById('meshchatChatHint')
      const listEl = document.getElementById('meshchatChatList')
      if (hintEl) {
        if (destination === 'direct') {
          if (!selectedTo) hintEl.textContent = 'Direct thread: select a peer (or paste a destination hash).'
          else {
            const d = peerDisplay(selectedTo)
            hintEl.textContent = `Direct thread with ${d.shortName}${d.longName ? ` (${d.longName})` : ''}. Click a sender name to DM.`
          }
        } else {
          hintEl.textContent = 'Broadcast chat. Click a sender name to DM.'
        }
      }

      if (listEl) {
        listEl.innerHTML = ''

        const traffic = Array.isArray(s?.traffic) ? s.traffic : []
        const msgs = []
        for (const e of traffic) {
          if (!e || typeof e !== 'object') continue
          const text = typeof e?.text === 'string' ? String(e.text) : ''
          if (!text.trim()) continue

          if (e.dir === 'out') {
            const dest = String(e?.data?.destination || '').trim()
            const toHash = cleanHex(String(e?.data?.toHash || ''))
            if (destination === 'direct') {
              if (!selectedTo) continue
              if (dest !== 'direct' || toHash !== selectedTo) continue
            } else {
              if (dest !== 'broadcast') continue
            }
            msgs.push({ ts: Number(e.ts) || Date.now(), dir: 'out', text })
            continue
          }

          if (e.dir === 'in') {
            const via = String(e?.data?.via || '').trim()
            const fromHash = cleanHex(String(e?.from?.peer?.hash || ''))
            if (destination === 'direct') {
              if (!selectedTo) continue
              if (via !== 'direct' || fromHash !== selectedTo) continue
            } else {
              if (via === 'direct') continue
            }
            msgs.push({ ts: Number(e.ts) || Date.now(), dir: 'in', text, ...(fromHash ? { fromHash } : {}) })
          }
        }

        const slice = msgs.slice(-250)
        if (!slice.length) {
          const empty = document.createElement('div')
          empty.className = 'meshchatSmallMuted'
          empty.textContent = 'No messages yet for this view.'
          listEl.appendChild(empty)
        } else {
          for (const m of slice) {
            const out = m.dir === 'out'
            const row = document.createElement('div')
            row.className = `meshchatChatRow ${out ? 'out' : 'in'}`

            const meta = document.createElement('div')
            meta.className = 'meshchatChatMeta'

            const who = document.createElement('div')
            who.className = 'meshchatChatWho'

            if (out) {
              const name = document.createElement('div')
              name.className = 'meshchatChatName'
              name.textContent = myLabel
              who.appendChild(name)
              if (myRole) {
                const long = document.createElement('div')
                long.className = 'meshchatChatLong'
                long.textContent = myRole
                who.appendChild(long)
              }
            } else {
              const fromHash = cleanHex(String(m.fromHash || ''))
              const d = peerDisplay(fromHash)
              if (fromHash) {
                const btn = document.createElement('button')
                btn.type = 'button'
                btn.className = 'meshchatChatNameBtn'
                btn.textContent = d.shortName
                btn.title = 'Click to DM this peer'
                btn.addEventListener('click', () => {
                  try {
                    this.setConfigSafe({ send: { destination: 'direct', toHash: fromHash } })
                    this.renderFromState()
                  } catch (_) {
                    // ignore
                  }
                })
                who.appendChild(btn)
              } else {
                const name = document.createElement('div')
                name.className = 'meshchatChatName'
                name.textContent = d.shortName
                who.appendChild(name)
              }

              if (d.longName) {
                const long = document.createElement('div')
                long.className = 'meshchatChatLong'
                long.textContent = d.longName
                who.appendChild(long)
              }
            }

            const right = document.createElement('div')
            right.className = 'meshchatChatMetaRight'
            const ts = Number(m.ts) || Date.now()
            right.title = new Date(ts).toISOString()
            right.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

            meta.appendChild(who)
            meta.appendChild(right)

            const bubble = document.createElement('div')
            bubble.className = 'meshchatChatBubble'
            bubble.textContent = String(m.text || '')

            row.appendChild(meta)
            row.appendChild(bubble)
            listEl.appendChild(row)
          }
        }

        try { listEl.scrollTop = listEl.scrollHeight } catch (_) { /* ignore */ }
      }
    } catch (_) {
      // ignore
    }

    const ifaceEl = document.getElementById('meshchatInterfaces')
    if (ifaceEl) {
      const bs = status?.bridgeStatus || {}
      const ifaces = Array.isArray(bs?.interfaces) ? bs.interfaces : []
      ifaceEl.textContent = JSON.stringify(ifaces, null, 2)
    }

    const trafficEl = document.getElementById('meshchatTraffic')
    if (trafficEl) trafficEl.textContent = meshchatTrafficText(s?.traffic || [])

    this.renderLinks()
  }

  async connect() {
    if (!globalThis.reticulumConnect) {
      alert('Reticulum transport not loaded. Reload or open MeshChat again.')
      return
    }
    try {
      await globalThis.reticulumConnect()
      this.renderFromState()
    } catch (e) {
      this.renderFromState()
      alert(meshchatUiFormatError(e))
    }
  }

  async disconnect() {
    if (!globalThis.reticulumDisconnect) return
    try {
      await globalThis.reticulumDisconnect()
      this.renderFromState()
    } catch (e) {
      this.renderFromState()
      alert(meshchatUiFormatError(e))
    }
  }

  async announce() {
    if (!globalThis.reticulumAnnounce) {
      alert('Reticulum transport not loaded.')
      return
    }
    try {
      await globalThis.reticulumAnnounce()
      this.renderFromState()
    } catch (e) {
      this.renderFromState()
      alert(meshchatUiFormatError(e))
    }
  }

  clearLog() {
    try {
      if (typeof globalThis.reticulumClearTrafficLog === 'function') globalThis.reticulumClearTrafficLog()
    } catch (_) {
      // ignore
    }
    this.renderFromState()
  }

  async sendTest() {
    if (!globalThis.reticulumSendText) {
      alert('Reticulum transport not loaded.')
      return
    }
    const el = document.getElementById('meshchatSendText')
    const msg = el ? String(el.value || '').trim() : ''
    if (!msg) {
      alert('Nothing to send')
      return
    }

    try {
      await globalThis.reticulumSendText(msg)
      try { if (el) el.value = '' } catch (_) { /* ignore */ }
      this.renderFromState()
    } catch (e) {
      this.renderFromState()
      alert(meshchatUiFormatError(e))
    }
  }

  addLink() {
    const labelEl = document.getElementById('meshchatNewLinkLabel')
    const urlEl = document.getElementById('meshchatNewLinkUrl')
    const label = (labelEl && String(labelEl.value || '').trim()) || 'Device'
    const url = (urlEl && String(urlEl.value || '').trim()) || ''
    if (!url) {
      alert('Enter a device URL')
      return
    }

    const id = `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
    this.links = [{ id, label, url }, ...(Array.isArray(this.links) ? this.links : [])]
    meshchatWriteDeviceLinks(this.links)
    try { if (labelEl) labelEl.value = '' } catch (_) { /* ignore */ }
    try { if (urlEl) urlEl.value = '' } catch (_) { /* ignore */ }
    this.renderLinks()
  }

  removeLink(id) {
    this.links = (Array.isArray(this.links) ? this.links : []).filter((d) => d && d.id !== id)
    meshchatWriteDeviceLinks(this.links)
    this.renderLinks()
  }

  openLink(url) {
    const u = String(url || '').trim()
    if (!u) return
    window.open(u, '_blank', 'noopener,noreferrer')
  }

  async applyBridgeProvisioningText(text) {
    const trimmed = String(text || '').trim()
    const bundle = meshchatParseProvisioningText(trimmed)
    const coerced = meshchatCoerceBaseUrlFromText(trimmed)
    const urls = bundle?.urls || (coerced ? [coerced] : [])
    const list = (Array.isArray(urls) ? urls : []).map((u) => meshchatNormalizeBaseUrl(u)).filter(Boolean)
    if (!list.length) throw new Error('QR did not look like XTOC-RNS provisioning code or a bridge URL.')

    const chosen = await meshchatPickReachableUrl(list, 1800)
    const baseUrl = chosen || list[0]

    if (!globalThis.setReticulumConfig) throw new Error('Reticulum transport not loaded')
    globalThis.setReticulumConfig({ baseUrl })

    if (globalThis.reticulumConnect) {
      try {
        await globalThis.reticulumConnect()
      } catch (e) {
        throw new Error(`Connect failed: ${meshchatUiFormatError(e)}`)
      }
    }

    return { baseUrl, chosen: !!chosen, urls: list }
  }

  async scanBridgeQr() {
    if (!globalThis.QrScanner) {
      alert('QrScanner not loaded')
      return
    }

    const overlay = document.createElement('div')
    overlay.className = 'meshchatQrOverlay'
    overlay.innerHTML = `
      <div class="meshchatQrModal">
        <div class="meshchatQrModalTitle">Scan Bridge QR</div>
        <video id="meshchatBridgeQrVideo"></video>
        <div class="meshchatButtonRow" style="margin-top:10px;">
          <button id="meshchatBridgeQrStopBtn" type="button" class="danger">Stop</button>
        </div>
        <div class="meshchatSmallMuted" style="margin-top:8px">Point the camera at an <code>XTOC-RNS</code> QR.</div>
      </div>
    `
    document.body.appendChild(overlay)
    const video = overlay.querySelector('#meshchatBridgeQrVideo')
    const stopBtn = overlay.querySelector('#meshchatBridgeQrStopBtn')

    let scanner
    const stop = () => {
      try { if (scanner) scanner.stop() } catch (_) { /* ignore */ }
      scanner = null
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
    }

    try {
      if (!video) throw new Error('Camera element missing')
      globalThis.QrScanner.WORKER_PATH = 'assets/vendor/qr-scanner-worker.min.js'
      scanner = new globalThis.QrScanner(
        video,
        (result) => {
          const text = (result && result.data) ? result.data : String(result)
          const trimmed = String(text || '').trim()
          void this.applyBridgeProvisioningText(trimmed)
            .then((r) => {
              try { window.radioApp?.updateStatus?.(`MeshChat configured: ${r.baseUrl}`) } catch (_) { /* ignore */ }
              stop()
            })
            .catch((e) => {
              alert(meshchatUiFormatError(e))
              stop()
            })
        },
        { returnDetailedScanResult: true },
      )
      await scanner.start()
      if (stopBtn) stopBtn.addEventListener('click', stop)
    } catch (e) {
      console.error(e)
      stop()
      alert(`QR scan failed: ${e?.message || e}`)
    }
  }
}

try {
  if (!globalThis.__xcomMeshChatModuleLoaded) {
    globalThis.__xcomMeshChatModuleLoaded = true
    globalThis.MeshChatModule = MeshChatModule
  }
} catch (_) {
  // ignore
}
