/**
 * XCOM HaLow module
 * - Connect to XTOC HaLow Bridge over LAN (HTTP publish + poll)
 * - View topology (connected clients)
 * - View traffic log
 * - Quick-open device config pages (Heltec/Open MANET gear)
 */

function halowUiFormatError(e) {
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

const LS_HALOW_DEVICE_LINKS = 'xcom.halow.deviceLinks.v1'

function halowReadDeviceLinks() {
  try {
    const raw = localStorage.getItem(LS_HALOW_DEVICE_LINKS)
    if (!raw) return []
    const json = JSON.parse(raw)
    return Array.isArray(json) ? json : []
  } catch (_) {
    return []
  }
}

function halowWriteDeviceLinks(links) {
  try {
    localStorage.setItem(LS_HALOW_DEVICE_LINKS, JSON.stringify(Array.isArray(links) ? links : []))
  } catch (_) {
    // ignore
  }
}

function halowFmtAgo(ms, now) {
  if (!ms) return '—'
  const d = Math.max(0, (now || Date.now()) - Number(ms))
  if (d < 1500) return 'now'
  if (d < 60000) return `${Math.round(d / 1000)}s ago`
  if (d < 60 * 60000) return `${Math.round(d / 60000)}m ago`
  return `${Math.round(d / (60 * 60000))}h ago`
}

function halowTrafficText(entries) {
  const list = Array.isArray(entries) ? entries : []
  return list.slice(-400).map((e) => {
    const ts = new Date(e.ts || Date.now()).toISOString()
    if (e.dir === 'sys') return `${ts}  SYS  ${(String(e.level || '')).toUpperCase().padEnd(5)} ${e.msg || ''}`
    if (e.dir === 'out') return `${ts}  OUT  ${e.kind || ''} ${(String(e.text || '')).replace(/\\s+/g, ' ').trim()}`
    if (e.dir === 'in') {
      const from = e.from || {}
      const fromLabel = from.label || from.client_id || from.clientId || ''
      return `${ts}  IN   ${e.kind || ''} ${fromLabel ? `[${fromLabel}] ` : ''}${(String(e.text || '')).replace(/\\s+/g, ' ').trim()}`
    }
    return `${ts}  ?    ${JSON.stringify(e)}`
  }).join('\\n')
}

function manetNormalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/$/, '')
}

function manetParseProvisioningText(text) {
  const t = String(text || '').trim()
  const prefixes = ['XTOC-MANET.', 'XTOC-HALOW.']
  const prefix = prefixes.find((p) => t.startsWith(p))
  if (!prefix) return null

  try {
    const json = atob(t.slice(prefix.length))
    const obj = JSON.parse(json)
    if (!obj || typeof obj !== 'object') return null
    if (Number(obj.v) !== 1) return null
    if (!Array.isArray(obj.urls)) return null
    const urls = obj.urls.map((u) => manetNormalizeBaseUrl(u)).filter(Boolean)
    if (!urls.length) return null
    return { v: 1, port: Number(obj.port) || undefined, urls, generatedAtMs: Number(obj.generatedAtMs) || undefined }
  } catch (_) {
    return null
  }
}

function manetCoerceBaseUrlFromText(text) {
  const t = String(text || '').trim()
  if (!/^https?:\/\//i.test(t)) return null
  try {
    const u = new URL(t)
    if (!u.hostname) return null
    return manetNormalizeBaseUrl(`${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`)
  } catch (_) {
    return manetNormalizeBaseUrl(t)
  }
}

async function manetProbeHealth(baseUrl, timeoutMs = 2000) {
  const base = manetNormalizeBaseUrl(baseUrl)
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

async function manetPickReachableUrl(urls, timeoutMs = 2000) {
  const list = Array.isArray(urls) ? urls : []
  for (const u of list) {
    const base = manetNormalizeBaseUrl(u)
    if (!base) continue
    // eslint-disable-next-line no-await-in-loop
    const ok = await manetProbeHealth(base, timeoutMs)
    if (ok) return base
  }
  return null
}

// eslint-disable-next-line no-unused-vars
class HaLowModule {
  constructor() {
    this.unsub = null
    this.links = halowReadDeviceLinks()
    this.init()
  }

  init() {
    this.createModuleStructure()
    this.bindEvents()
    this.renderFromState()

    this.unsub = (globalThis.xcomHaLow && typeof globalThis.xcomHaLow.subscribe === 'function')
      ? globalThis.xcomHaLow.subscribe(() => this.renderFromState())
      : null

    window.radioApp.updateStatus('MANET module loaded')
  }

  createModuleStructure() {
    const root = document.getElementById('halow')
    if (!root) return

    root.innerHTML = `
      <div class="xModuleIntro">
        <div class="xModuleIntroTitle">What you can do here</div>
        <div class="xModuleIntroText">
          Connect XCOM to the XTOC MANET bridge over your local network (Wi‑Fi HaLow / Open MANET / LAN) to send and receive XTOC packets.
        </div>
      </div>

      <div class="halowShell">
        <div class="halowCard">
          <div class="halowCardTitle">MANET</div>
          <div class="halowSmallMuted">
            Run the bridge on the XTOC master, then scan Bridge QR (recommended) or set Bridge URL to the master IP (example: <code>http://10.0.0.5:8095</code>).
          </div>

          <div class="halowRow">
            <label>Status</label>
            <div id="halowStatus" class="halowStatusPill">Disconnected</div>
            <div id="halowStatusMeta" class="halowSmallMuted"></div>
          </div>

          <div class="halowButtonRow">
            <button id="halowConnectBtn" type="button" class="primary">Connect</button>
            <button id="halowDisconnectBtn" type="button" class="danger">Disconnect</button>
            <button id="halowClearLogBtn" type="button">Clear Log</button>
          </div>
        </div>

        <div class="halowCard">
          <div class="halowCardTitle">Settings</div>

          <div class="halowRow">
            <label>Bridge URL</label>
            <input id="halowBaseUrl" type="text" placeholder="http://10.0.0.5:8095" />
          </div>

          <div class="halowButtonRow">
            <button id="halowScanBridgeQrBtn" type="button" class="primary">Scan Bridge QR</button>
          </div>
          <div class="halowSmallMuted" style="margin-top: 6px;">
            Scan the <code>XTOC-MANET</code> QR from the XTOC MANET page to auto-configure this device.
          </div>

          <div class="halowGrid2">
            <div class="halowRow">
              <label>This device label</label>
              <input id="halowLabel" type="text" placeholder="XCOM" />
            </div>
            <div class="halowRow">
              <label>Role</label>
              <select id="halowRole">
                <option value="client" selected>Client (XCOM)</option>
                <option value="master">Master (XTOC)</option>
              </select>
            </div>
          </div>

          <div class="halowGrid2">
            <div class="halowRow">
              <label>Poll interval (ms)</label>
              <input id="halowPollMs" type="number" min="250" max="60000" step="50" />
            </div>
            <div class="halowRow">
              <label class="halowInline"><input id="halowAutoReconnect" type="checkbox" checked /> Auto-reconnect</label>
              <div class="halowSmallMuted">Keep trying if the bridge drops</div>
            </div>
          </div>
        </div>

        <div class="halowCard">
          <div class="halowCardTitle">Topology</div>
          <div id="halowClients" class="halowSmallMuted">No clients yet.</div>
        </div>

        <div class="halowCard">
          <div class="halowCardTitle">Traffic</div>
          <pre id="halowTraffic" class="halowPre"></pre>
        </div>

        <div class="halowCard">
          <div class="halowCardTitle">Device Config Shortcuts</div>
          <div class="halowSmallMuted" style="margin-bottom: 10px;">
            Add links to Heltec/Open MANET/router config pages for quick access.
          </div>

          <div class="halowGrid2">
            <div class="halowRow">
              <label>Label</label>
              <input id="halowNewLinkLabel" type="text" placeholder="Heltec AP" />
            </div>
            <div class="halowRow">
              <label>URL</label>
              <input id="halowNewLinkUrl" type="text" placeholder="http://192.168.1.1" />
            </div>
          </div>
          <div class="halowButtonRow">
            <button id="halowAddLinkBtn" type="button" class="primary">Add shortcut</button>
          </div>

          <div id="halowLinks"></div>
        </div>
      </div>
    `
  }

  bindEvents() {
    const connectBtn = document.getElementById('halowConnectBtn')
    const disconnectBtn = document.getElementById('halowDisconnectBtn')
    const clearBtn = document.getElementById('halowClearLogBtn')
    const scanQrBtn = document.getElementById('halowScanBridgeQrBtn')

    if (connectBtn) connectBtn.addEventListener('click', async () => {
      try {
        if (!globalThis.halowConnect) throw new Error('MANET transport not loaded')
        await globalThis.halowConnect()
      } catch (e) {
        alert(halowUiFormatError(e))
      }
    })

    if (disconnectBtn) disconnectBtn.addEventListener('click', async () => {
      try {
        if (!globalThis.halowDisconnect) throw new Error('MANET transport not loaded')
        await globalThis.halowDisconnect()
      } catch (e) {
        alert(halowUiFormatError(e))
      }
    })

    if (clearBtn) clearBtn.addEventListener('click', () => {
      try { globalThis.halowClearTrafficLog && globalThis.halowClearTrafficLog() } catch (_) { /* ignore */ }
      this.renderFromState()
    })

    if (scanQrBtn) scanQrBtn.addEventListener('click', async () => {
      try {
        await this.scanBridgeQr()
      } catch (e) {
        alert(halowUiFormatError(e))
      }
    })

    const baseUrlEl = document.getElementById('halowBaseUrl')
    const labelEl = document.getElementById('halowLabel')
    const roleEl = document.getElementById('halowRole')
    const pollMsEl = document.getElementById('halowPollMs')
    const autoRecEl = document.getElementById('halowAutoReconnect')

    const applyCfg = () => {
      try {
        if (!globalThis.setHaLowConfig) return
        const patch = {
          baseUrl: baseUrlEl ? baseUrlEl.value : undefined,
          client: {
            label: labelEl ? labelEl.value : undefined,
            role: roleEl ? roleEl.value : undefined,
          },
          ui: {
            pollMs: pollMsEl ? Number(pollMsEl.value) : undefined,
            autoReconnect: autoRecEl ? !!autoRecEl.checked : undefined,
          },
        }
        globalThis.setHaLowConfig(patch)
      } catch (_) {
        // ignore
      }
    }

    if (baseUrlEl) baseUrlEl.addEventListener('change', applyCfg)
    if (labelEl) labelEl.addEventListener('change', applyCfg)
    if (roleEl) roleEl.addEventListener('change', applyCfg)
    if (pollMsEl) pollMsEl.addEventListener('change', applyCfg)
    if (autoRecEl) autoRecEl.addEventListener('change', applyCfg)

    const addLinkBtn = document.getElementById('halowAddLinkBtn')
    if (addLinkBtn) addLinkBtn.addEventListener('click', () => this.addLink())
  }

  async applyBridgeProvisioningText(text) {
    const trimmed = String(text || '').trim()
    const bundle = manetParseProvisioningText(trimmed)
    const coerced = manetCoerceBaseUrlFromText(trimmed)
    const urls = bundle?.urls || (coerced ? [coerced] : [])
    const list = (Array.isArray(urls) ? urls : []).map((u) => manetNormalizeBaseUrl(u)).filter(Boolean)
    if (!list.length) throw new Error('QR did not look like XTOC-MANET provisioning code or a bridge URL.')

    const chosen = await manetPickReachableUrl(list, 1800)
    const baseUrl = chosen || list[0]

    if (!globalThis.setHaLowConfig) throw new Error('MANET transport not loaded')
    globalThis.setHaLowConfig({ baseUrl })

    if (globalThis.halowConnect) {
      try {
        await globalThis.halowConnect()
      } catch (e) {
        throw new Error(`Connect failed: ${halowUiFormatError(e)}`)
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
    overlay.className = 'halowQrOverlay'
    overlay.innerHTML = `
      <div class="halowQrModal">
        <div class="halowQrModalTitle">Scan Bridge QR</div>
        <video id="halowBridgeQrVideo"></video>
        <div class="halowButtonRow" style="margin-top:10px;">
          <button id="halowBridgeQrStopBtn" type="button" class="danger">Stop</button>
        </div>
        <div class="halowSmallMuted" style="margin-top:8px">Point the camera at an <code>XTOC-MANET</code> QR.</div>
      </div>
    `
    document.body.appendChild(overlay)
    const video = overlay.querySelector('#halowBridgeQrVideo')
    const stopBtn = overlay.querySelector('#halowBridgeQrStopBtn')

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
              try { window.radioApp?.updateStatus?.(`MANET configured: ${r.baseUrl}`) } catch (_) { /* ignore */ }
              stop()
            })
            .catch((e) => {
              alert(halowUiFormatError(e))
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

  addLink() {
    const labelEl = document.getElementById('halowNewLinkLabel')
    const urlEl = document.getElementById('halowNewLinkUrl')
    const label = (labelEl && String(labelEl.value || '').trim()) || 'Device'
    const url = (urlEl && String(urlEl.value || '').trim()) || ''
    if (!url) {
      alert('Enter a device URL')
      return
    }

    const id = `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
    this.links = [{ id, label, url }, ...(Array.isArray(this.links) ? this.links : [])]
    halowWriteDeviceLinks(this.links)
    try { if (labelEl) labelEl.value = '' } catch (_) { /* ignore */ }
    try { if (urlEl) urlEl.value = '' } catch (_) { /* ignore */ }
    this.renderLinks()
  }

  removeLink(id) {
    this.links = (Array.isArray(this.links) ? this.links : []).filter((d) => d && d.id !== id)
    halowWriteDeviceLinks(this.links)
    this.renderLinks()
  }

  openLink(url) {
    const u = String(url || '').trim()
    if (!u) return
    window.open(u, '_blank', 'noopener,noreferrer')
  }

  renderLinks() {
    const wrap = document.getElementById('halowLinks')
    if (!wrap) return

    const list = Array.isArray(this.links) ? this.links : []
    if (!list.length) {
      wrap.innerHTML = `<div class="halowSmallMuted">No shortcuts yet.</div>`
      return
    }

    wrap.innerHTML = list.map((d) => `
      <div class="halowLinkRow">
        <div>
          <div><strong>${String(d.label || 'Device')}</strong></div>
          <div class="halowSmallMuted">${String(d.url || '')}</div>
        </div>
        <div class="halowButtonRow" style="margin-top: 0;">
          <button type="button" data-open="${String(d.id)}">Open</button>
          <button type="button" data-remove="${String(d.id)}" class="danger">Remove</button>
        </div>
      </div>
    `).join('')

    wrap.querySelectorAll('button[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-open')
        const item = list.find((x) => String(x.id) === String(id))
        if (item) this.openLink(item.url)
      })
    })

    wrap.querySelectorAll('button[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-remove')
        this.removeLink(id)
      })
    })
  }

  renderFromState() {
    const state = globalThis.xcomHaLow ? globalThis.xcomHaLow.getState() : { status: { connected: false }, traffic: [], clients: [], config: {} }
    const s = state.status || {}
    const cfg = state.config || {}

    const connected = !!s.connected
    const reconnecting = !!s.reconnecting
    const statusLabel = reconnecting ? `Reconnecting (attempt ${s.reconnectAttempt || 1})` : (connected ? 'Connected' : (s.lastError ? 'Disconnected (error)' : 'Disconnected'))

    const pill = document.getElementById('halowStatus')
    if (pill) {
      pill.textContent = statusLabel
      pill.classList.remove('ok', 'warn')
      if (connected) pill.classList.add('ok')
      else if (reconnecting || s.lastError) pill.classList.add('warn')
    }

    const meta = document.getElementById('halowStatusMeta')
    if (meta) {
      const parts = []
      parts.push(`Bridge: ${s.baseUrl || cfg.baseUrl || '—'}`)
      if (s.lastOkAt) parts.push(`Last OK: ${new Date(s.lastOkAt).toISOString()}`)
      if (s.lastError) parts.push(`Last error: ${s.lastError}`)
      meta.textContent = parts.join(' | ')
    }

    // Reflect config values into inputs (best-effort)
    try {
      const baseUrlEl = document.getElementById('halowBaseUrl')
      if (baseUrlEl && baseUrlEl.value !== String(cfg.baseUrl || '')) baseUrlEl.value = String(cfg.baseUrl || '')
      const labelEl = document.getElementById('halowLabel')
      if (labelEl && labelEl.value !== String(cfg?.client?.label || '')) labelEl.value = String(cfg?.client?.label || '')
      const roleEl = document.getElementById('halowRole')
      if (roleEl) roleEl.value = String(cfg?.client?.role || 'client')
      const pollEl = document.getElementById('halowPollMs')
      if (pollEl) pollEl.value = String(cfg?.ui?.pollMs || 900)
      const autoRec = document.getElementById('halowAutoReconnect')
      if (autoRec) autoRec.checked = cfg?.ui?.autoReconnect !== false
    } catch (_) {
      // ignore
    }

    // Clients list
    const clientsWrap = document.getElementById('halowClients')
    if (clientsWrap) {
      const list = Array.isArray(state.clients) ? state.clients : []
      const now = Date.now()
      if (!list.length) {
        clientsWrap.textContent = 'No clients yet.'
      } else {
        const rows = list.slice().sort((a, b) => Number(b.last_seen_ms || 0) - Number(a.last_seen_ms || 0)).map((c) => {
          const label = c.label || c.client_id || 'Client'
          const meta = `App: ${c.app || '—'} | Role: ${c.role || '—'} | IP: ${c.ip || '—'} | Last: ${halowFmtAgo(c.last_seen_ms, now)}`
          return `<div class="halowClientRow"><div><div><strong>${label}</strong></div><div class="halowSmallMuted">${meta}</div></div></div>`
        }).join('')
        clientsWrap.innerHTML = rows
      }
    }

    // Traffic
    const pre = document.getElementById('halowTraffic')
    if (pre) pre.textContent = halowTrafficText(state.traffic || [])

    // Buttons
    const connectBtn = document.getElementById('halowConnectBtn')
    const disconnectBtn = document.getElementById('halowDisconnectBtn')
    if (connectBtn) connectBtn.disabled = connected
    if (disconnectBtn) disconnectBtn.disabled = !connected && !reconnecting

    this.renderLinks()
  }
}
