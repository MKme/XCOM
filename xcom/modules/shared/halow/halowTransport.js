/**
 * HaLow transport layer for XCOM (LAN via XTOC halow-bridge/server.py).
 *
 * XCOM loads scripts via classic <script> tags (not ESM).
 *
 * Goals:
 * - Simple HTTP publish + poll for bidirectional packet text (XTOC <-> XCOM)
 * - Persist config + recent traffic in localStorage
 * - Expose a global singleton API so other modules (Comms) can Connect + Send
 */

// -----------------------------
// Storage keys
// -----------------------------

const LS_HALOW_PREFIX = 'xcom.halow.'
const LS_HALOW_CONFIG = LS_HALOW_PREFIX + 'config.v1'
const LS_HALOW_LOG = LS_HALOW_PREFIX + 'traffic.v1'

function halowReadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch (_) {
    return fallback
  }
}

function halowWriteJson(key, value) {
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
    // fallback
    return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  }
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
// Defaults
// -----------------------------

function halowDefaultConfig() {
  return {
    baseUrl: 'http://127.0.0.1:8095',
    client: {
      id: makeClientId('xcom'),
      app: 'xcom',
      role: 'client', // XTOC is typically 'master'
      label: 'XCOM',
    },
    ui: {
      maxLogEntries: 250,
      pollMs: 900,
      pollClientsEveryMs: 3000,
      autoReconnect: true,
      autoReconnectMinDelayMs: 1000,
      autoReconnectMaxDelayMs: 15000,
      autoReconnectMaxAttempts: 0,
    },
  }
}

function halowNormalizeConfig(cfg) {
  const d = halowDefaultConfig()
  const raw = cfg && typeof cfg === 'object' ? cfg : {}

  const baseUrl = normalizeBaseUrl(raw.baseUrl != null ? raw.baseUrl : d.baseUrl)
  const c = raw.client && typeof raw.client === 'object' ? raw.client : {}
  const u = raw.ui && typeof raw.ui === 'object' ? raw.ui : {}

  const id = String(c.id || d.client.id).trim() || d.client.id
  const label = String(c.label || d.client.label).trim() || d.client.label
  const role = String(c.role || d.client.role).trim().toLowerCase() === 'master' ? 'master' : 'client'
  const unitId = Number.isFinite(Number(c.unitId)) ? Math.floor(Number(c.unitId)) : undefined
  const teamId = String(c.teamId || '').trim() || undefined

  const maxLogEntries = Math.max(50, Math.min(5000, Math.floor(Number(u.maxLogEntries) || d.ui.maxLogEntries)))
  const pollMs = Math.max(250, Math.min(60000, Math.floor(Number(u.pollMs) || d.ui.pollMs)))
  const pollClientsEveryMs = Math.max(500, Math.min(120000, Math.floor(Number(u.pollClientsEveryMs) || d.ui.pollClientsEveryMs)))
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
    ui: {
      maxLogEntries,
      pollMs,
      pollClientsEveryMs,
      autoReconnect,
      autoReconnectMinDelayMs,
      autoReconnectMaxDelayMs,
      autoReconnectMaxAttempts,
    },
  }
}

function _halowConfigGet() {
  const cfg = halowReadJson(LS_HALOW_CONFIG, null)
  return halowNormalizeConfig(cfg)
}

function _halowConfigSet(partial) {
  const base = _halowConfigGet()
  const merged = { ...base, ...(partial || {}) }
  if (partial?.client) merged.client = { ...base.client, ...partial.client }
  if (partial?.ui) merged.ui = { ...base.ui, ...partial.ui }
  const next = halowNormalizeConfig(merged)
  halowWriteJson(LS_HALOW_CONFIG, next)
  return next
}

// -----------------------------
// Traffic log
// -----------------------------

function _halowTrafficGet() {
  const arr = halowReadJson(LS_HALOW_LOG, [])
  return Array.isArray(arr) ? arr : []
}

function _halowTrafficWrite(entries) {
  halowWriteJson(LS_HALOW_LOG, entries)
}

function halowAppendTraffic(entry) {
  const cfg = _halowConfigGet()
  const max = Number(cfg?.ui?.maxLogEntries || 250)
  const log = _halowTrafficGet()
  log.push(entry)
  while (log.length > max) log.shift()
  _halowTrafficWrite(log)
  return log
}

function halowClearTraffic() {
  _halowTrafficWrite([])
}

// -----------------------------
// Bridge HTTP calls
// -----------------------------

async function halowPostJson(url, body, signal) {
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

async function halowGetJson(url, signal) {
  const res = await fetch(url, { cache: 'no-store', signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function bridgeHello(baseUrl, client) {
  const base = normalizeBaseUrl(baseUrl)
  return await halowPostJson(`${base}/hello`, { client })
}

async function bridgeSend(baseUrl, body) {
  const base = normalizeBaseUrl(baseUrl)
  return await halowPostJson(`${base}/send`, body)
}

async function bridgeEvents(baseUrl, sinceId, limit) {
  const base = normalizeBaseUrl(baseUrl)
  const since = Math.max(0, Math.floor(Number(sinceId) || 0))
  const lim = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 250)))
  return await halowGetJson(`${base}/events?since_id=${since}&limit=${lim}`)
}

async function bridgeClients(baseUrl) {
  const base = normalizeBaseUrl(baseUrl)
  return await halowGetJson(`${base}/clients`)
}

// -----------------------------
// Public singleton API
// -----------------------------

class XcomHaLowTransport {
  constructor() {
    const cfg = _halowConfigGet()
    this.status = {
      connected: false,
      reconnecting: false,
      reconnectAttempt: 0,
      nextReconnectAt: null,
      lastError: null,
      lastOkAt: null,
      baseUrl: cfg.baseUrl,
      lastEventId: 0,
    }
    this.clients = []
    this.subscribers = new Set()

    this.pollTimer = null
    this.reconnectTimer = null
    this.manualDisconnect = false
    this.connectInFlight = null
    this.reconnectAttempt = 0
    this.lastClientsPollAt = 0
  }

  getConfig() {
    return _halowConfigGet()
  }

  setConfig(partial) {
    const next = _halowConfigSet(partial)
    this.status.baseUrl = next.baseUrl
    this._notify()
    return next
  }

  getTrafficLog() {
    return _halowTrafficGet()
  }

  clearTrafficLog() {
    halowClearTraffic()
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
    }
  }

  _notify() {
    const s = this.getState()
    for (const fn of Array.from(this.subscribers)) {
      try { fn(s) } catch (_) { /* ignore */ }
    }
  }

  appendTraffic(e) {
    halowAppendTraffic(e)

    // Auto-ingest incoming XTOC packet text so packets appear on the Map immediately
    // (even if Comms is not open).
    try {
      if (e && e.dir === 'in' && String(e.kind || '') === 'packet') {
        const text = typeof e.text === 'string' ? e.text : ''
        if (text && text.trim()) {
          const fn = globalThis.xcomAutoIngestXtocPacketText
          if (typeof fn === 'function') {
            void fn({ text, source: 'manet', receivedAt: Number(e.ts) || Date.now(), from: e.from || null })
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
    this.appendTraffic({ dir: 'sys', ts: Date.now(), level: 'info', msg: `Auto-reconnect: ${reason}. Retrying in ${Math.max(1, Math.round(delay / 1000))}s (attempt ${nextAttempt}).` })
    this.setStatus({ reconnecting: true, reconnectAttempt: nextAttempt, nextReconnectAt: at, connected: false })

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
      await this.connectInternal(true)
    } catch (e) {
      const msg = formatError(e)
      this.appendTraffic({ dir: 'sys', ts: Date.now(), level: 'warn', msg: `Auto-reconnect failed (attempt ${this.reconnectAttempt}): ${msg}` })
      this.setStatus({ lastError: msg })
      this.scheduleReconnect('Reconnect failed')
    }
  }

  async connect() {
    return await this.connectInternal(false)
  }

  async connectInternal(auto) {
    if (this.connectInFlight) return await this.connectInFlight

    const p = (async () => {
      const cfg = this.getConfig()
      const baseUrl = normalizeBaseUrl(cfg.baseUrl)
      if (!baseUrl) throw new Error('Bridge URL is empty')

      this.manualDisconnect = false
      if (!auto) this.reconnectAttempt = 0
      this.clearTimers()

      this.setStatus({ baseUrl, connected: false, reconnecting: !!auto, reconnectAttempt: auto ? this.reconnectAttempt : 0, nextReconnectAt: null, lastError: null })
      await bridgeHello(baseUrl, cfg.client)

      this.setStatus({ connected: true, reconnecting: false, reconnectAttempt: 0, nextReconnectAt: null, lastOkAt: Date.now(), lastError: null })
      this.appendTraffic({ dir: 'sys', ts: Date.now(), level: 'info', msg: `Connected to MANET bridge: ${baseUrl}` })

      this.scheduleNextPoll(0)
    })()

    this.connectInFlight = p
    try {
      return await p
    } finally {
      if (this.connectInFlight === p) this.connectInFlight = null
    }
  }

  async disconnect() {
    this.manualDisconnect = true
    this.reconnectAttempt = 0
    this.clearTimers()
    this.setStatus({ connected: false, reconnecting: false, reconnectAttempt: 0, nextReconnectAt: null, lastError: null })
    this.appendTraffic({ dir: 'sys', ts: Date.now(), level: 'info', msg: 'Disconnected' })
  }

  scheduleNextPoll(delayMs) {
    if (this.manualDisconnect) return
    if (this.pollTimer) return
    const d = Math.max(0, Math.floor(Number(delayMs) || 0))
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

    try {
      const since = this.status.lastEventId || 0
      const res = await bridgeEvents(baseUrl, since, 1000)
      const lastId = Number(res?.lastId) || 0
      const events = Array.isArray(res?.events) ? res.events : []
      const nextLastId = Math.max(this.status.lastEventId || 0, lastId, ...events.map((e) => Number(e?.id) || 0))
      this.setStatus({ connected: true, lastOkAt: Date.now(), lastError: null, lastEventId: nextLastId })

      const myId = cfg.client.id
      for (const ev of events) {
        const kind = String(ev?.kind || 'packet')
        const eid = Number(ev?.id) || undefined
        const from = ev?.frm || ev?.from
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

    try {
      const now = Date.now()
      if (now - this.lastClientsPollAt >= cfg.ui.pollClientsEveryMs) {
        this.lastClientsPollAt = now
        const res = await bridgeClients(baseUrl)
        const arr = Array.isArray(res?.clients) ? res.clients : []
        this.clients = arr.map((c) => ({
          client_id: String(c?.client_id || ''),
          app: String(c?.app || ''),
          role: String(c?.role || ''),
          label: c?.label ?? null,
          unit_id: c?.unit_id ?? null,
          team_id: c?.team_id ?? null,
          first_seen_ms: c?.first_seen_ms ?? undefined,
          last_seen_ms: c?.last_seen_ms ?? undefined,
          ip: c?.ip ?? null,
        }))
        this._notify()
      }
    } catch (_) {
      // ignore topology polling errors
    }

    const delay = Math.max(250, Math.floor(Number(cfg.ui.pollMs) || 900))
    this.scheduleNextPoll(delay)
  }

  async sendPacketText(text) {
    const cfg = this.getConfig()
    const baseUrl = normalizeBaseUrl(cfg.baseUrl)
    if (!baseUrl) throw new Error('Bridge URL is empty')

    const msg = String(text || '').trim()
    if (!msg) throw new Error('Nothing to send')

    if (!this.status.connected) await this.connectInternal(false)

    const ts = Date.now()
    this.appendTraffic({ dir: 'out', ts, kind: 'packet', text: msg })
    const res = await bridgeSend(baseUrl, { client: cfg.client, kind: 'packet', text: msg })
    const eid = Number(res?.event?.id)
    if (Number.isFinite(eid)) this.setStatus({ lastEventId: Math.max(this.status.lastEventId || 0, eid) })
    return res
  }
}

// Singleton instance + globals
const xcomHaLow = new XcomHaLowTransport()

try {
  globalThis.xcomHaLow = xcomHaLow
  globalThis.getHaLowConfig = () => xcomHaLow.getConfig()
  globalThis.setHaLowConfig = (p) => xcomHaLow.setConfig(p)
  globalThis.halowConnect = () => xcomHaLow.connect()
  globalThis.halowDisconnect = () => xcomHaLow.disconnect()
  globalThis.halowSendPacketText = (t) => xcomHaLow.sendPacketText(t)
  globalThis.halowGetTrafficLog = () => xcomHaLow.getTrafficLog()
  globalThis.halowClearTrafficLog = () => xcomHaLow.clearTrafficLog()
} catch (_) {
  // ignore
}
