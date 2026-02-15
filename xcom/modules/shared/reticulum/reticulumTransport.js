/**
 * Reticulum transport layer for XCOM (via XTOC reticulum-bridge/server.py).
 *
 * XCOM loads scripts via classic <script> tags (not ESM).
 *
 * Goals:
 * - Simple HTTP publish + poll for Reticulum MeshChat traffic
 * - Persist config + recent traffic in localStorage
 * - Expose a global singleton API so other modules (Comms) can Connect + Send
 * - Auto-ingest incoming XTOC packet wrappers into the local packet DB (optional)
 */

// -----------------------------
// Storage keys
// -----------------------------

const LS_RNS_PREFIX = 'xcom.reticulum.'
const LS_RNS_CONFIG = LS_RNS_PREFIX + 'config.v1'
const LS_RNS_LOG = LS_RNS_PREFIX + 'traffic.v1'

function rnsReadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch (_) {
    return fallback
  }
}

function rnsWriteJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (_) {
    // ignore
  }
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/$/, '')
}

function makeClientId(prefix) {
  try {
    const bytes = 10
    const arr = new Uint8Array(bytes)
    crypto.getRandomValues(arr)
    let hex = ''
    for (const b of arr) hex += (b % 16).toString(16)
    return `${prefix}_${hex}`
  } catch (_) {
    return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  }
}

function safeInt(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : null
}

function formatError(e) {
  if (e == null) return 'Unknown error'
  if (typeof e === 'string') return e
  if (typeof e === 'number' || typeof e === 'boolean' || typeof e === 'bigint') return String(e)
  if (e instanceof Error) {
    const base = e.message ? `${e.name}: ${e.message}` : e.name
    const cause = e.cause != null ? `; cause: ${formatError(e.cause)}` : ''
    return `${base}${cause}`.trim() || 'Error'
  }
  try {
    const json = JSON.stringify(e)
    return json && json !== '{}' ? json : Object.prototype.toString.call(e)
  } catch (_) {
    return Object.prototype.toString.call(e)
  }
}

// -----------------------------
// Defaults + config
// -----------------------------

function rnsDefaultConfig() {
  return {
    baseUrl: 'http://127.0.0.1:8096',
    client: {
      id: makeClientId('xcom'),
      app: 'xcom',
      role: 'client',
      label: 'XCOM',
    },
    send: {
      destination: 'broadcast', // 'broadcast' | 'direct'
      toHash: '',
    },
    ui: {
      maxLogEntries: 250,
      pollMs: 900,
      pollStatusEveryMs: 3000,
      pollClientsEveryMs: 3000,
      autoImport: true,
      autoReconnect: true,
      autoReconnectMinDelayMs: 1000,
      autoReconnectMaxDelayMs: 15000,
      autoReconnectMaxAttempts: 0,
    },
  }
}

function rnsNormalizeConfig(cfg) {
  const d = rnsDefaultConfig()
  const raw = cfg && typeof cfg === 'object' ? cfg : {}

  const baseUrl = normalizeBaseUrl(raw.baseUrl != null ? raw.baseUrl : d.baseUrl)
  const c = raw.client && typeof raw.client === 'object' ? raw.client : {}
  const s = raw.send && typeof raw.send === 'object' ? raw.send : {}
  const u = raw.ui && typeof raw.ui === 'object' ? raw.ui : {}

  const id = String(c.id || d.client.id).trim() || d.client.id
  const label = String(c.label || d.client.label).trim() || d.client.label
  const role = String(c.role || d.client.role).trim().toLowerCase() === 'master' ? 'master' : 'client'
  const unitId = safeInt(c.unitId)
  const teamId = String(c.teamId || '').trim() || undefined

  const destination = String(s.destination || d.send.destination).trim().toLowerCase() === 'direct' ? 'direct' : 'broadcast'
  const toHash = String(s.toHash || '').trim()

  const maxLogEntries = Math.max(50, Math.min(5000, Math.floor(Number(u.maxLogEntries) || d.ui.maxLogEntries)))
  const pollMs = Math.max(250, Math.min(60000, Math.floor(Number(u.pollMs) || d.ui.pollMs)))
  const pollStatusEveryMs = Math.max(500, Math.min(120000, Math.floor(Number(u.pollStatusEveryMs) || d.ui.pollStatusEveryMs)))
  const pollClientsEveryMs = Math.max(500, Math.min(120000, Math.floor(Number(u.pollClientsEveryMs) || d.ui.pollClientsEveryMs)))
  const autoImport = u.autoImport !== false
  const autoReconnect = u.autoReconnect !== false
  const autoReconnectMinDelayMs = Math.max(500, Math.min(60000, Math.floor(Number(u.autoReconnectMinDelayMs) || d.ui.autoReconnectMinDelayMs)))
  const autoReconnectMaxDelayMs = Math.max(autoReconnectMinDelayMs, Math.min(10 * 60000, Math.floor(Number(u.autoReconnectMaxDelayMs) || d.ui.autoReconnectMaxDelayMs)))
  const autoReconnectMaxAttempts = Math.max(0, Math.min(1000, Math.floor(Number(u.autoReconnectMaxAttempts) || d.ui.autoReconnectMaxAttempts)))

  return {
    baseUrl,
    client: {
      id,
      app: 'xcom',
      role,
      label,
      ...(unitId != null && unitId >= 0 ? { unitId } : {}),
      ...(teamId ? { teamId } : {}),
    },
    send: { destination, toHash },
    ui: {
      maxLogEntries,
      pollMs,
      pollStatusEveryMs,
      pollClientsEveryMs,
      autoImport,
      autoReconnect,
      autoReconnectMinDelayMs,
      autoReconnectMaxDelayMs,
      autoReconnectMaxAttempts,
    },
  }
}

function rnsConfigGet() {
  return rnsNormalizeConfig(rnsReadJson(LS_RNS_CONFIG, null))
}

function rnsConfigSet(partial) {
  const base = rnsConfigGet()
  const merged = { ...base, ...(partial || {}) }
  if (partial && partial.client) merged.client = { ...base.client, ...partial.client }
  if (partial && partial.send) merged.send = { ...base.send, ...partial.send }
  if (partial && partial.ui) merged.ui = { ...base.ui, ...partial.ui }
  const next = rnsNormalizeConfig(merged)
  rnsWriteJson(LS_RNS_CONFIG, next)
  return next
}

function rnsTrafficGet() {
  const arr = rnsReadJson(LS_RNS_LOG, [])
  return Array.isArray(arr) ? arr : []
}

function rnsTrafficWrite(entries) {
  rnsWriteJson(LS_RNS_LOG, Array.isArray(entries) ? entries : [])
}

function rnsAppendTraffic(entry) {
  const cfg = rnsConfigGet()
  const max = Number(cfg?.ui?.maxLogEntries) || 250
  const log = rnsTrafficGet()
  log.push(entry)
  while (log.length > max) log.shift()
  rnsTrafficWrite(log)
  return log
}

// -----------------------------
// Bridge HTTP calls
// -----------------------------

async function postJson(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function getJson(url, signal) {
  const res = await fetch(url, { cache: 'no-store', signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function bridgeHello(baseUrl, client, signal) {
  const base = normalizeBaseUrl(baseUrl)
  return await postJson(`${base}/hello`, { client }, signal)
}

async function bridgeSend(baseUrl, body, signal) {
  const base = normalizeBaseUrl(baseUrl)
  return await postJson(`${base}/send`, body, signal)
}

async function bridgeEvents(baseUrl, args, signal) {
  const base = normalizeBaseUrl(baseUrl)
  const since = Math.max(0, Math.floor(Number(args?.sinceId) || 0))
  const limit = Math.max(1, Math.min(5000, Math.floor(Number(args?.limit) || 250)))
  return await getJson(`${base}/events?since_id=${since}&limit=${limit}`, signal)
}

async function bridgeClients(baseUrl, signal) {
  const base = normalizeBaseUrl(baseUrl)
  return await getJson(`${base}/clients`, signal)
}

async function bridgeStatus(baseUrl, signal) {
  const base = normalizeBaseUrl(baseUrl)
  return await getJson(`${base}/status`, signal)
}

async function bridgeAnnounce(baseUrl, signal) {
  const base = normalizeBaseUrl(baseUrl)
  return await postJson(`${base}/announce`, {}, signal)
}

// -----------------------------
// Public singleton API
// -----------------------------

class XcomReticulumTransport {
  constructor() {
    this.status = {
      connected: false,
      reconnecting: false,
      reconnectAttempt: 0,
      nextReconnectAt: null,
      lastError: null,
      lastOkAt: null,
      baseUrl: rnsConfigGet().baseUrl,
      lastEventId: 0,
      bridgeStatus: null,
    }

    this.clients = []
    this.peers = []
    this.subscribers = new Set()
    this.pollTimer = null
    this.reconnectTimer = null
    this.manualDisconnect = false
    this.connectInFlight = null
    this.reconnectAttempt = 0
    this.lastStatusPollAt = 0
    this.lastClientsPollAt = 0
  }

  getConfig() {
    return rnsConfigGet()
  }

  setConfig(partial) {
    const next = rnsConfigSet(partial)
    this.status.baseUrl = next.baseUrl
    this._notify()
    return next
  }

  getTrafficLog() {
    return rnsTrafficGet()
  }

  clearTrafficLog() {
    rnsTrafficWrite([])
    this._notify()
  }

  subscribe(fn) {
    this.subscribers.add(fn)
    try { fn(this.getState()) } catch (_) { /* ignore */ }
    return () => this.subscribers.delete(fn)
  }

  getState() {
    return {
      config: this.getConfig(),
      status: { ...this.status },
      traffic: this.getTrafficLog(),
      clients: Array.isArray(this.clients) ? [...this.clients] : [],
      peers: Array.isArray(this.peers) ? [...this.peers] : [],
    }
  }

  _notify() {
    const s = this.getState()
    for (const fn of Array.from(this.subscribers)) {
      try { fn(s) } catch (_) { /* ignore */ }
    }
  }

  appendTraffic(e) {
    rnsAppendTraffic(e)

    // Auto-ingest incoming XTOC packet wrappers into the local DB/map overlay.
    try {
      const cfg = this.getConfig()
      if (cfg?.ui?.autoImport === false) return

      if (e && e.dir === 'in' && String(e.kind || '') === 'packet') {
        const text = typeof e.text === 'string' ? e.text : ''
        if (text && text.trim()) {
          const fn = globalThis.xcomAutoIngestXtocPacketText
          if (typeof fn === 'function') {
            void fn({ text, source: 'reticulum', receivedAt: Number(e.ts) || Date.now(), from: e.from || null })
          }
        }
      }
    } catch (_) {
      // ignore
    }

    this._notify()
  }

  setStatus(patch) {
    this.status = { ...this.status, ...(patch || {}) }
    this._notify()
  }

  clearTimers() {
    if (this.pollTimer) {
      try { clearTimeout(this.pollTimer) } catch (_) { /* ignore */ }
    }
    this.pollTimer = null

    if (this.reconnectTimer) {
      try { clearTimeout(this.reconnectTimer) } catch (_) { /* ignore */ }
    }
    this.reconnectTimer = null
  }

  computeReconnectDelayMs(attempt) {
    const cfg = this.getConfig()
    const min = Math.max(500, Math.floor(Number(cfg.ui.autoReconnectMinDelayMs) || 1000))
    const max = Math.max(min, Math.floor(Number(cfg.ui.autoReconnectMaxDelayMs) || 15000))
    const exp = Math.min(max, Math.floor(min * Math.pow(2, Math.max(0, attempt - 1))))
    const jitter = Math.floor(exp * 0.2 * Math.random())
    return Math.min(max, exp + jitter)
  }

  scheduleReconnect(reason) {
    const cfg = this.getConfig()
    if (!cfg.ui.autoReconnect) return
    if (this.manualDisconnect) return
    if (this.reconnectTimer) return
    if (this.connectInFlight) return

    const nextAttempt = this.reconnectAttempt + 1
    const maxAttempts = Math.max(0, Math.floor(Number(cfg.ui.autoReconnectMaxAttempts) || 0))
    if (maxAttempts > 0 && nextAttempt > maxAttempts) {
      this.appendTraffic({ dir: 'sys', ts: Date.now(), level: 'warn', msg: `Auto-reconnect stopped after ${maxAttempts} attempts.` })
      this.setStatus({ reconnecting: false, reconnectAttempt: this.reconnectAttempt, nextReconnectAt: null })
      return
    }

    this.reconnectAttempt = nextAttempt
    const delay = this.computeReconnectDelayMs(nextAttempt)
    const at = Date.now() + delay

    this.appendTraffic({
      dir: 'sys',
      ts: Date.now(),
      level: 'info',
      msg: `Auto-reconnect: ${reason}. Retrying in ${Math.max(1, Math.round(delay / 1000))}s (attempt ${nextAttempt}).`,
    })
    this.setStatus({ reconnecting: true, reconnectAttempt: nextAttempt, nextReconnectAt: at })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.runReconnect()
    }, delay)
  }

  async runReconnect() {
    const cfg = this.getConfig()
    if (!cfg.ui.autoReconnect) return
    if (this.manualDisconnect) return
    if (this.connectInFlight) return

    try {
      this.setStatus({ reconnecting: true, nextReconnectAt: null })
      await this.connectInternal({ auto: true })
    } catch (e) {
      const msg = formatError(e)
      this.appendTraffic({ dir: 'sys', ts: Date.now(), level: 'warn', msg: `Auto-reconnect failed (attempt ${this.reconnectAttempt}): ${msg}`, data: e })
      this.setStatus({ lastError: msg })
      this.scheduleReconnect('Reconnect failed')
    }
  }

  scheduleNextPoll(delayMs) {
    if (this.manualDisconnect) return
    if (this.pollTimer) return
    const d = Math.max(250, Math.floor(Number(delayMs) || 0))
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.pollOnce()
    }, d)
  }

  async pollOnce() {
    if (this.manualDisconnect) return
    const cfg = this.getConfig()
    const baseUrl = normalizeBaseUrl(cfg.baseUrl)
    if (!baseUrl) {
      this.setStatus({ connected: false, lastError: 'Bridge URL is empty' })
      return
    }

    // Poll events
    try {
      const since = this.status.lastEventId || 0
      const res = await bridgeEvents(baseUrl, { sinceId: since, limit: 1000 })
      const lastId = Number(res?.lastId) || 0
      const events = Array.isArray(res?.events) ? res.events : []

      const nextLastId = Math.max(this.status.lastEventId || 0, lastId, ...events.map((e) => Number(e?.id) || 0))
      this.setStatus({ connected: true, lastOkAt: Date.now(), lastError: null, lastEventId: nextLastId })

      const myId = cfg.client.id
      for (const ev of events) {
        const kind = String(ev?.kind || 'packet')
        const eid = Number(ev?.id) || undefined
        const from = ev?.frm ?? ev?.from
        const fromId = String(from?.client_id || from?.clientId || from?.id || '')
        if (fromId && fromId === myId) continue

        const text = typeof ev?.text === 'string' ? ev.text : undefined
        const data = ev?.data
        this.appendTraffic({ dir: 'in', ts: Date.now(), kind, from, text, data, eventId: eid })
      }
    } catch (e) {
      const msg = formatError(e)
      this.setStatus({ connected: false, lastError: msg })
      this.appendTraffic({ dir: 'sys', ts: Date.now(), level: 'warn', msg: `Poll failed: ${msg}` })
      this.scheduleReconnect('Poll failed')
      return
    }

    // Poll status (peers/interfaces)
    try {
      const now = Date.now()
      if (now - this.lastStatusPollAt >= cfg.ui.pollStatusEveryMs) {
        this.lastStatusPollAt = now
        const res = await bridgeStatus(baseUrl)
        const st = res?.status || null
        this.peers = Array.isArray(st?.peers) ? st.peers : []
        this.setStatus({ bridgeStatus: st })
      }
    } catch (_) {
      // ignore
    }

    // Poll bridge clients
    try {
      const now = Date.now()
      if (now - this.lastClientsPollAt >= cfg.ui.pollClientsEveryMs) {
        this.lastClientsPollAt = now
        const res = await bridgeClients(baseUrl)
        const arr = Array.isArray(res?.clients) ? res.clients : []
        this.clients = arr.map((c) => ({
          client_id: String(c?.client_id || c?.clientId || ''),
          app: String(c?.app || ''),
          role: String(c?.role || ''),
          label: c?.label ?? null,
          unit_id: c?.unit_id ?? c?.unitId ?? null,
          team_id: c?.team_id ?? c?.teamId ?? null,
          first_seen_ms: c?.first_seen_ms ?? c?.firstSeenMs ?? undefined,
          last_seen_ms: c?.last_seen_ms ?? c?.lastSeenMs ?? undefined,
          ip: c?.ip ?? null,
        }))
        this._notify()
      }
    } catch (_) {
      // ignore
    }

    const delay = Math.max(250, Math.floor(Number(cfg.ui.pollMs) || 900))
    this.scheduleNextPoll(delay)
  }

  async connectInternal(args) {
    if (this.connectInFlight) return await this.connectInFlight

    const p = (async () => {
      const cfg = this.getConfig()
      const baseUrl = normalizeBaseUrl(cfg.baseUrl)
      if (!baseUrl) throw new Error('Bridge URL is empty')

      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 2500)
      try {
        await bridgeHello(baseUrl, cfg.client, ctrl.signal)
        try {
          const s = await bridgeStatus(baseUrl, ctrl.signal)
          const st = s?.status || null
          this.peers = Array.isArray(st?.peers) ? st.peers : []
          this.setStatus({ bridgeStatus: st })
        } catch (_) {
          // ignore
        }
      } finally {
        try { clearTimeout(t) } catch (_) { /* ignore */ }
      }

      this.manualDisconnect = false
      this.setStatus({ connected: true, reconnecting: false, nextReconnectAt: null, lastError: null, lastOkAt: Date.now(), baseUrl })
      this.scheduleNextPoll(250)
    })()

    this.connectInFlight = p
    try {
      await p
    } finally {
      this.connectInFlight = null
    }
  }

  async connect() {
    this.manualDisconnect = false
    this.clearTimers()
    this.reconnectAttempt = 0
    this.setStatus({ reconnecting: false, reconnectAttempt: 0, nextReconnectAt: null })
    await this.connectInternal({ auto: false })
  }

  async disconnect() {
    this.manualDisconnect = true
    this.clearTimers()
    this.setStatus({ connected: false, reconnecting: false, nextReconnectAt: null })
  }

  async announce() {
    const cfg = this.getConfig()
    const baseUrl = normalizeBaseUrl(cfg.baseUrl)
    if (!baseUrl) throw new Error('Bridge URL is empty')
    await bridgeAnnounce(baseUrl)
    this.appendTraffic({ dir: 'sys', ts: Date.now(), level: 'info', msg: 'Announce sent.' })
  }

  async sendText(text, opts) {
    const cfg = this.getConfig()
    const baseUrl = normalizeBaseUrl(cfg.baseUrl)
    if (!baseUrl) throw new Error('Bridge URL is empty')

    const msg = String(text || '').trim()
    if (!msg) throw new Error('Nothing to send')

    if (!this.status.connected) {
      await this.connectInternal({ auto: false })
    }

    const destination = opts?.destination || cfg.send.destination
    const toHash = opts?.toHash || cfg.send.toHash

    const ts = Date.now()
    this.appendTraffic({ dir: 'out', ts, kind: 'packet', text: msg, data: { destination, toHash } })
    const res = await bridgeSend(baseUrl, { client: cfg.client, kind: 'packet', text: msg, data: { destination, toHash } })

    const eid = Number(res?.event?.id)
    if (Number.isFinite(eid)) this.setStatus({ lastEventId: Math.max(this.status.lastEventId || 0, eid) })
    return res
  }
}

const xcomReticulum = new XcomReticulumTransport()

try {
  globalThis.xcomReticulum = xcomReticulum
  globalThis.getReticulumConfig = () => xcomReticulum.getConfig()
  globalThis.setReticulumConfig = (p) => xcomReticulum.setConfig(p)
  globalThis.reticulumConnect = () => xcomReticulum.connect()
  globalThis.reticulumDisconnect = () => xcomReticulum.disconnect()
  globalThis.reticulumAnnounce = () => xcomReticulum.announce()
  globalThis.reticulumSendText = (t, opts) => xcomReticulum.sendText(t, opts)
  globalThis.reticulumGetTrafficLog = () => xcomReticulum.getTrafficLog()
  globalThis.reticulumClearTrafficLog = () => xcomReticulum.clearTrafficLog()
} catch (_) {
  // ignore
}
