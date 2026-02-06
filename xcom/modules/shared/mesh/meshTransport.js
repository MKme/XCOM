/**
 * Mesh transport layer for XCOM.
 *
 * Goals:
 * - Provide a small, browser-friendly API for Meshtastic devices (and placeholders for MeshCore)
 * - Persist configuration and recent traffic in localStorage
 * - Expose a global singleton-ish API so other modules (Comms) can send packets
 *
 * XCOM loads scripts via classic <script> tags, not ESM.
 */

// -----------------------------
// Storage keys
// -----------------------------

const LS_MESH_PREFIX = 'xcom.mesh.'
const LS_MESH_CONFIG = LS_MESH_PREFIX + 'config.v1'
const LS_MESH_LOG = LS_MESH_PREFIX + 'traffic.v1'
const LS_MESH_LAST_DEVICE_ID = LS_MESH_PREFIX + 'lastBleDeviceId.v1'
const LS_MESH_NODES = LS_MESH_PREFIX + 'nodes.v1'
const LS_MESH_COVERAGE = LS_MESH_PREFIX + 'coverage.v1'

function meshReadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch (_) {
    return fallback
  }
}

function meshWriteJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (_) {
    // ignore
  }
}

function readString(key) {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return null
    const s = String(raw)
    return s ? s : null
  } catch (_) {
    return null
  }
}

function writeString(key, value) {
  try {
    if (value == null || value === '') localStorage.removeItem(key)
    else localStorage.setItem(key, String(value))
  } catch (_) {
    // ignore
  }
}

function getLastBleDeviceId() {
  return readString(LS_MESH_LAST_DEVICE_ID)
}

function setLastBleDeviceId(id) {
  writeString(LS_MESH_LAST_DEVICE_ID, id)
}

function routingErrorLabel(code) {
  try {
    const n = Number(code)
    if (!Number.isFinite(n)) return null
    const Enum =
      globalThis?.Meshtastic?.Protobuf?.Mesh?.Routing_Error ||
      globalThis?.Meshtastic?.Protobuf?.Routing_Error ||
      globalThis?.Meshtastic?.Protobufs?.Mesh?.Routing_Error ||
      globalThis?.Meshtastic?.Protobufs?.Routing_Error
    const name = Enum && Enum[n]
    return typeof name === 'string' ? name : null
  } catch (_) {
    return null
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

    // Common Meshtastic error shape: { id, error } where error is a Routing_Error enum value.
    try {
      const errCode = any?.error
      const label = routingErrorLabel(errCode)
      if (label) {
        const id = any?.id ?? any?.requestId ?? null
        return `Routing error: ${label} (${String(errCode)})${id != null ? ` id=${String(id)}` : ''}`
      }
    } catch (_) {
      // ignore
    }

    try {
      const seen = new WeakSet()
      const json = JSON.stringify(
        any,
        (_k, v) => {
          if (typeof v === 'bigint') return v.toString()
          if (typeof v === 'object' && v != null) {
            if (seen.has(v)) return '[Circular]'
            seen.add(v)
          }
          return v
        },
        2,
      )
      if (json && json !== '{}' && json !== '[]') return json
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

// -----------------------------
// Defaults
// -----------------------------

function meshDefaultConfig() {
  return {
    driver: 'meshtastic', // 'meshtastic' | 'meshcore' (placeholder)
    connection: {
      // 'ble' (Web Bluetooth) is the primary browser-friendly mode.
      // 'serial' (Web Serial) optional; depends on browser.
      kind: 'ble',
    },
    meshtastic: {
      // Where to send:
      // - 'broadcast' (to channel)
      // - 'direct' (to nodeId)
      destination: 'broadcast',
      toNodeId: '',
      channel: 0,
      wantAck: true,
      // Text is what we send for XCOM sitrep/task/etc; we wrap as plain text.
      // If you later want protobuf mesh packets, we can extend.
      appPort: 'TEXT_MESSAGE_APP',
    },
    ui: {
      maxLogEntries: 200,
      maxNodeEntries: 400,
      maxCoverageEntries: 2000,
      autoTimestamp: true,
      autoReconnect: true,
      autoReconnectMinDelayMs: 1500,
      autoReconnectMaxDelayMs: 30000,
      autoReconnectMaxAttempts: 0,
    },
  }
}

// IMPORTANT:
// This file is loaded as a classic <script>, so top-level function names become global.
// Do NOT use public/global names like `getMeshConfig`/`setMeshConfig` internally, because
// we also expose globals with those names at the bottom of the file. If we reuse the same
// names, we can accidentally create infinite recursion and hit "Maximum call stack size exceeded".

function meshNormalizeConfig(cfg) {
  const defaults = meshDefaultConfig()
  const raw = cfg && typeof cfg === 'object' ? cfg : {}

  const next = { ...defaults, ...raw }
  next.connection = { ...defaults.connection, ...(raw?.connection && typeof raw.connection === 'object' ? raw.connection : {}) }
  next.meshtastic = { ...defaults.meshtastic, ...(raw?.meshtastic && typeof raw.meshtastic === 'object' ? raw.meshtastic : {}) }
  next.ui = { ...defaults.ui, ...(raw?.ui && typeof raw.ui === 'object' ? raw.ui : {}) }

  next.driver = next.driver === 'meshtastic' ? 'meshtastic' : defaults.driver
  next.connection.kind = next.connection.kind === 'ble' ? 'ble' : defaults.connection.kind

  next.meshtastic.destination = next.meshtastic.destination === 'direct' ? 'direct' : 'broadcast'
  next.meshtastic.toNodeId = String(next.meshtastic.toNodeId || '').trim()
  next.meshtastic.channel = Math.max(0, Math.min(7, Math.floor(Number(next.meshtastic.channel) || 0)))
  next.meshtastic.wantAck = next.meshtastic.wantAck !== false

  next.ui.maxLogEntries = Math.max(50, Math.min(5000, Math.floor(Number(next.ui.maxLogEntries) || defaults.ui.maxLogEntries)))
  next.ui.maxNodeEntries = Math.max(25, Math.min(5000, Math.floor(Number(next.ui.maxNodeEntries) || defaults.ui.maxNodeEntries)))
  next.ui.maxCoverageEntries = Math.max(50, Math.min(20000, Math.floor(Number(next.ui.maxCoverageEntries) || defaults.ui.maxCoverageEntries)))
  next.ui.autoTimestamp = next.ui.autoTimestamp !== false
  next.ui.autoReconnect = next.ui.autoReconnect !== false
  next.ui.autoReconnectMinDelayMs = Math.max(500, Math.min(60000, Math.floor(Number(next.ui.autoReconnectMinDelayMs) || defaults.ui.autoReconnectMinDelayMs)))
  next.ui.autoReconnectMaxDelayMs = Math.max(next.ui.autoReconnectMinDelayMs, Math.min(10 * 60 * 1000, Math.floor(Number(next.ui.autoReconnectMaxDelayMs) || defaults.ui.autoReconnectMaxDelayMs)))
  next.ui.autoReconnectMaxAttempts = Math.max(0, Math.min(100, Math.floor(Number(next.ui.autoReconnectMaxAttempts) || defaults.ui.autoReconnectMaxAttempts)))

  return next
}

function _meshConfigGet() {
  const cfg = meshReadJson(LS_MESH_CONFIG, null)
  return meshNormalizeConfig(cfg)
}

function _meshConfigSet(partial) {
  const base = _meshConfigGet()
  const merged = { ...base, ...(partial || {}) }
  // Deep-merge a few known nested objects
  if (partial?.connection) merged.connection = { ...base.connection, ...partial.connection }
  if (partial?.meshtastic) merged.meshtastic = { ...base.meshtastic, ...partial.meshtastic }
  if (partial?.ui) merged.ui = { ...base.ui, ...partial.ui }

  const next = meshNormalizeConfig(merged)
  meshWriteJson(LS_MESH_CONFIG, next)
  return next
}

// -----------------------------
// Traffic log
// -----------------------------

function _meshTrafficGet() {
  const arr = meshReadJson(LS_MESH_LOG, [])
  return Array.isArray(arr) ? arr : []
}

function meshAppendTraffic(entry) {
  const cfg = _meshConfigGet()
  const max = Number(cfg?.ui?.maxLogEntries || 200)
  const log = _meshTrafficGet()
  log.push(entry)
  while (log.length > max) log.shift()
  meshWriteJson(LS_MESH_LOG, log)
  return log
}

function meshClearTraffic() {
  meshWriteJson(LS_MESH_LOG, [])
}

// -----------------------------
// Node DB (persistent)
// -----------------------------

function meshAsFiniteNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function meshAsNonEmptyString(v) {
  const s = (v == null) ? '' : String(v)
  const t = s.trim()
  return t ? t : null
}

function meshExtractLatLon(pos) {
  if (!pos || typeof pos !== 'object') return null

  // Common Meshtastic shapes:
  // - latitudeI/longitudeI as int32 scaled by 1e7
  // - latitude/longitude as float degrees
  // - lat/lon as float degrees
  const latI = meshAsFiniteNumber(pos.latitudeI ?? pos.latI ?? pos.latitude_i ?? null)
  const lonI = meshAsFiniteNumber(pos.longitudeI ?? pos.lonI ?? pos.longitude_i ?? null)
  if (latI != null && lonI != null) {
    // Heuristic: scaled ints are usually > 1000 in magnitude.
    const scale = (Math.abs(latI) > 1000 || Math.abs(lonI) > 1000) ? 1e7 : 1
    const lat = latI / scale
    const lon = lonI / scale
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return { lat, lon }
    }
  }

  const lat = meshAsFiniteNumber(pos.latitude ?? pos.lat ?? null)
  const lon = meshAsFiniteNumber(pos.longitude ?? pos.lon ?? null)
  if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    return { lat, lon }
  }

  return null
}

function meshReadNodeDb() {
  const raw = meshReadJson(LS_MESH_NODES, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw
}

function meshWriteNodeDb(db) {
  meshWriteJson(LS_MESH_NODES, db && typeof db === 'object' ? db : {})
}

function meshPruneNodeDb(db, max) {
  try {
    const entries = Object.entries(db || {})
      .filter(([k, v]) => k != null && String(k).trim() && v && typeof v === 'object')
    if (entries.length <= max) return db
    entries.sort((a, b) => Number(b?.[1]?.lastSeenTs || 0) - Number(a?.[1]?.lastSeenTs || 0))
    const next = {}
    for (const [k, v] of entries.slice(0, max)) next[k] = v
    return next
  } catch (_) {
    return db
  }
}

function meshUpsertNode(db, num, patch) {
  const n = Math.floor(Number(num))
  if (!Number.isFinite(n) || n <= 0) return db
  const key = String(n)
  const cur = (db && typeof db === 'object' && db[key] && typeof db[key] === 'object') ? db[key] : { num: n }
  const next = { ...cur, ...(patch || {}), num: n }
  db[key] = next
  return db
}

function meshNodeDbToArray(db) {
  try {
    return Object.values(db || {})
      .filter((v) => v && typeof v === 'object' && Number.isFinite(Number(v.num)))
      .sort((a, b) => Number(b?.lastSeenTs || 0) - Number(a?.lastSeenTs || 0))
  } catch (_) {
    return []
  }
}

// -----------------------------
// Coverage samples (persistent)
// -----------------------------

function meshReadCoverage() {
  const arr = meshReadJson(LS_MESH_COVERAGE, [])
  return Array.isArray(arr) ? arr : []
}

function meshAppendCoverage(sample, maxEntries) {
  const max = Math.max(50, Math.min(20000, Math.floor(Number(maxEntries) || 2000)))
  const log = meshReadCoverage()
  log.push(sample)
  while (log.length > max) log.shift()
  meshWriteJson(LS_MESH_COVERAGE, log)
  return log
}

function meshClearCoverage() {
  meshWriteJson(LS_MESH_COVERAGE, [])
}

// -----------------------------
// Mesh driver (Meshtastic)
// -----------------------------

function meshDeviceStatusLabel(status) {
  if (status == null) return null
  const s = Number(status)
  if (!Number.isFinite(s)) return String(status)
  switch (s) {
    case 1: return 'Restarting'
    case 2: return 'Disconnected'
    case 3: return 'Connecting'
    case 4: return 'Reconnecting'
    case 5: return 'Connected'
    case 6: return 'Configuring'
    case 7: return 'Configured'
    default: {
      const Enum = globalThis?.Meshtastic?.Types?.DeviceStatusEnum
      const name = Enum && Enum[s]
      return typeof name === 'string' ? name : `Status ${String(s)}`
    }
  }
}

function meshIsLinkConnected(status) {
  const s = Number(status)
  if (!Number.isFinite(s)) return false
  return s === 5 || s === 6 || s === 7
}

/**
 * A thin wrapper around the Meshtastic JS client to provide a stable interface.
 *
 * We keep this defensive because:
 * - Browser capability varies (BLE/Serial)
 * - Meshtastic JS API shapes can change
 */
class MeshtasticDriver {
  constructor() {
    this.client = null
    this.bleConn = null
    this.bleDevice = null
    this.connected = false
    this.lastDeviceInfo = null
    this.lastDeviceStatus = null
    this.subs = []
    this._onReceive = null
    this._onLog = null
    this._onDeviceStatus = null
    this._onDeviceInfo = null
    this._onNodeInfo = null
    this._onUser = null
    this._onPosition = null
    this._onTelemetry = null
  }

  _emitLog(level, msg, data) {
    if (typeof this._onLog === 'function') {
      try { this._onLog({ level, msg, data, ts: Date.now() }) } catch (_) { /* ignore */ }
    }
  }

  onReceive(fn) { this._onReceive = fn }
  onLog(fn) { this._onLog = fn }
  onDeviceStatus(fn) { this._onDeviceStatus = fn }
  onDeviceInfo(fn) { this._onDeviceInfo = fn }
  onNodeInfo(fn) { this._onNodeInfo = fn }
  onUser(fn) { this._onUser = fn }
  onPosition(fn) { this._onPosition = fn }
  onTelemetry(fn) { this._onTelemetry = fn }

  _emitDeviceStatus(status) {
    const s = Number(status)
    const normalized = Number.isFinite(s) ? s : status
    this.lastDeviceStatus = normalized

    const label = meshDeviceStatusLabel(normalized) || String(normalized)
    const linkConnected = meshIsLinkConnected(normalized)
    // Treat link-connected as "ready" (some devices never fully configure, but can still RX/TX).
    this.connected = linkConnected
    this._emitLog('debug', `DeviceStatus=${String(normalized)} (${label})`, normalized)

    if (typeof this._onDeviceStatus === 'function') {
      try { this._onDeviceStatus({ status: normalized, label, linkConnected, ready: this.connected }) } catch (_) { /* ignore */ }
    }
  }

  getBleDevice() {
    try {
      return this.bleConn?.device || this.bleDevice || null
    } catch (_) {
      return this.bleDevice || null
    }
  }

  async connectBle(opts) {
    if (!globalThis.Meshtastic) throw new Error('Meshtastic vendor library not loaded')

    // Correct API for @meshtastic/js 2.x:
    //   const client = new Meshtastic.Client();
    //   const ble = client.createBleConnection();
    //   await ble.connect({ deviceFilter? }); // triggers navigator.bluetooth.requestDevice
    //   await ble.configure();
    //   await ble.sendText(...)
    const M = globalThis.Meshtastic
    if (!M?.Client) throw new Error('Meshtastic.Client not found in vendor bundle')

    const client = new M.Client()
    if (typeof client.createBleConnection !== 'function') {
      throw new Error('Meshtastic.Client.createBleConnection() not available')
    }

    const ble = client.createBleConnection()
    if (!ble || typeof ble.connect !== 'function') {
      throw new Error('Meshtastic BleConnection not available')
    }

    this.client = client
    this.bleConn = ble

    // Subscribe to message/packet events
    try {
      this.subs = []
      const ev = ble?.events
      if (ev?.onMessagePacket?.subscribe) {
        this.subs.push(ev.onMessagePacket.subscribe((m) => this._handleMessage(m)))
      }
      if (ev?.onMeshPacket?.subscribe) {
        this.subs.push(ev.onMeshPacket.subscribe((p) => this._handlePacket(p)))
      }
      if (ev?.onNodeInfoPacket?.subscribe) {
        this.subs.push(ev.onNodeInfoPacket.subscribe((info) => {
          if (typeof this._onNodeInfo === 'function') {
            try { this._onNodeInfo(info) } catch (_) { /* ignore */ }
          }
        }))
      }
      if (ev?.onUserPacket?.subscribe) {
        this.subs.push(ev.onUserPacket.subscribe((m) => {
          if (typeof this._onUser === 'function') {
            try { this._onUser(m) } catch (_) { /* ignore */ }
          }
        }))
      }
      if (ev?.onPositionPacket?.subscribe) {
        this.subs.push(ev.onPositionPacket.subscribe((m) => {
          if (typeof this._onPosition === 'function') {
            try { this._onPosition(m) } catch (_) { /* ignore */ }
          }
        }))
      }
      if (ev?.onTelemetryPacket?.subscribe) {
        this.subs.push(ev.onTelemetryPacket.subscribe((m) => {
          if (typeof this._onTelemetry === 'function') {
            try { this._onTelemetry(m) } catch (_) { /* ignore */ }
          }
        }))
      }
      if (ev?.onLogEvent?.subscribe) {
        this.subs.push(ev.onLogEvent.subscribe((e) => this._emitLog('info', e?.message || 'Meshtastic log', e)))
      }
      if (ev?.onDeviceStatus?.subscribe) {
        this.subs.push(ev.onDeviceStatus.subscribe((s) => this._emitDeviceStatus(s)))
      }
      if (ev?.onMyNodeInfo?.subscribe) {
        this.subs.push(ev.onMyNodeInfo.subscribe((info) => {
          try {
            const nodeNum = info?.myNodeNum ?? info?.nodeNum ?? null
            this.lastDeviceInfo = {
              myNodeNum: nodeNum ?? undefined,
              nodeId: nodeNum ?? undefined,
              longName: info?.user?.longName ?? undefined,
              shortName: info?.user?.shortName ?? undefined,
            }
          } catch (_) {
            this.lastDeviceInfo = null
          }
          if (typeof this._onDeviceInfo === 'function') {
            try { this._onDeviceInfo(this.lastDeviceInfo) } catch (_) { /* ignore */ }
          }
        }))
      }
    } catch (_) {
      // ignore
    }

    const cfg = _meshConfigGet()
    const filter = cfg?.meshtastic?.deviceFilter || undefined

    let preferred = opts?.device || null
    if (!preferred) {
      const lastId = getLastBleDeviceId()
      if (lastId) {
        try {
          const devs = typeof ble.getDevices === 'function'
            ? await ble.getDevices()
            : (globalThis.navigator?.bluetooth?.getDevices ? await globalThis.navigator.bluetooth.getDevices() : null)
          if (Array.isArray(devs)) preferred = devs.find((d) => d?.id === lastId) || null
        } catch (_) {
          // ignore
        }
      }
    }

    if (!preferred && opts?.interactive === false) {
      throw new Error('No authorized Bluetooth device available for auto-reconnect. Click Connect.')
    }

    this._emitLog('info', preferred ? 'Reconnecting to Bluetooth device...' : 'Requesting Bluetooth device...')
    try {
      await ble.connect({ device: preferred || undefined, deviceFilter: filter })
    } catch (e) {
      // Some @meshtastic/js builds can surface routing/config timeouts during connect even when BLE is actually up.
      // If GATT is connected, treat routing errors as non-fatal so we can keep listening for packets.
      let dev = null
      try { dev = ble?.device || preferred || null } catch (_) { /* ignore */ }
      const label = routingErrorLabel(e?.error)
      const gattConnected = dev?.gatt?.connected
      if (label && gattConnected !== false) {
        this._emitLog('warn', `Connect encountered routing error, continuing: ${formatError(e)}`, e)
      } else {
        throw e
      }
    }

    // Best-effort capture for silent reconnects later.
    try {
      this.bleDevice = ble?.device || preferred || null
      const id = this.bleDevice?.id
      if (typeof id === 'string' && id) setLastBleDeviceId(id)
    } catch (_) {
      // ignore
    }

    // Detect obvious failures early: the upstream library logs, but may not throw.
    try {
      const gattConnected = this.bleDevice?.gatt?.connected
      if (gattConnected === false) {
        throw new Error('Bluetooth GATT not connected (device out of range or connected elsewhere).')
      }
    } catch (e) {
      throw e
    }

    // Note: BleConnection.connect() in our vendor build already calls configure() internally (best-effort).
    // We avoid double-configuring here; routing timeouts are treated as non-fatal so we can keep listening.
    this._emitLog('info', 'Bluetooth connected')

    // Best-effort device info
    try {
      const nodeNum = client?.myNodeInfo?.myNodeNum ?? client?.myNodeInfo?.nodeNum ?? client?.myNodeNum ?? null
      this.lastDeviceInfo = {
        myNodeNum: nodeNum ?? undefined,
        nodeId: nodeNum ?? undefined,
        longName: client?.myNodeInfo?.user?.longName || undefined,
        shortName: client?.myNodeInfo?.user?.shortName || undefined,
      }
    } catch (_) {
      this.lastDeviceInfo = null
    }

    return this.lastDeviceInfo
  }

  async disconnect() {
    this.client = null
    const ble = this.bleConn
    this.bleConn = null
    this.bleDevice = null
    this.connected = false
    try {
      for (const s of this.subs) {
        if (typeof s?.cancel === 'function') s.cancel()
        else if (typeof s?.unsubscribe === 'function') s.unsubscribe()
      }
    } catch (_) {
      // ignore
    }
    this.subs = []
    try {
      if (ble && typeof ble.disconnect === 'function') ble.disconnect()
    } catch (_) {
      // ignore
    }
    this._emitLog('info', 'Disconnected')
  }

  _handlePacket(pkt) {
    if (typeof this._onReceive === 'function') {
      try { this._onReceive({ kind: 'packet', pkt, ts: Date.now() }) } catch (_) { /* ignore */ }
    }
  }

  _handleMessage(msg) {
    if (typeof this._onReceive === 'function') {
      try { this._onReceive({ kind: 'message', msg, ts: Date.now() }) } catch (_) { /* ignore */ }
    }
  }

  async sendText(text, opts) {
    if (!this.bleConn || !this.connected) throw new Error('Not connected to a Meshtastic device')
    const conn = this.bleConn
    const cfg = _meshConfigGet()
    const mt = { ...cfg.meshtastic, ...(opts || {}) }
    const channel = Math.max(0, Math.min(7, Math.floor(Number(mt.channel) || 0)))
    const wantAck = !!mt.wantAck

    // Destination
    const destination = String(mt.destination || 'broadcast')
    const toNodeId = String(mt.toNodeId || '').trim()

    // @meshtastic/js: sendText(text, destination?, wantAck?, channel?)
    if (typeof conn?.sendText === 'function') {
      if (destination === 'direct' && toNodeId) {
        if (toNodeId.startsWith('!')) {
          const n = parseInt(toNodeId.slice(1), 16)
          if (!Number.isFinite(n)) throw new Error(`Invalid Node ID: ${toNodeId}`)
          return await conn.sendText(text, n, wantAck, channel)
        }
        const n = Number(toNodeId)
        if (!Number.isFinite(n)) throw new Error(`Invalid Node ID: ${toNodeId}`)
        return await conn.sendText(text, Math.floor(n), wantAck, channel)
      }
      return await conn.sendText(text, 'broadcast', wantAck, channel)
    }

    throw new Error('Meshtastic connection does not support sendText()')
  }
}

// -----------------------------
// Public API (singleton)
// -----------------------------

class XcomMeshTransport {
  constructor() {
    this.driver = null
    this.status = {
      connected: false,
      linkConnected: false,
      reconnecting: false,
      reconnectAttempt: 0,
      nextReconnectAt: null,
      lastError: null,
      driver: null,
      connection: null,
      deviceStatus: 2,
      deviceStatusLabel: meshDeviceStatusLabel(2),
      lastDeviceInfo: null,
    }
    this._subscribers = new Set()

    this.manualDisconnect = false
    this.connectInFlight = null
    this.lastBleDevice = null
    this.reconnectTimer = null
    this.reconnectAttempt = 0

    this.nodeDb = meshReadNodeDb()
  }

  getConfig() { return _meshConfigGet() }
  setConfig(partial) {
    const before = this.getConfig()
    const next = _meshConfigSet(partial)

    // If auto-reconnect gets disabled, stop any pending attempts.
    if (before?.ui?.autoReconnect && next?.ui?.autoReconnect === false) {
      this.reconnectAttempt = 0
      if (this.reconnectTimer) {
        try { clearTimeout(this.reconnectTimer) } catch (_) { /* ignore */ }
      }
      this.reconnectTimer = null
      this._setStatus({ reconnecting: false, reconnectAttempt: 0, nextReconnectAt: null })
    }

    this._notify()
    return next
  }

  getTrafficLog() { return _meshTrafficGet() }
  clearTrafficLog() { meshClearTraffic(); this._notify() }

  getNodeDb() { return this.nodeDb || {} }
  getNodes() { return meshNodeDbToArray(this.getNodeDb()) }
  clearNodes() { this.nodeDb = {}; meshWriteNodeDb({}); this._notify() }

  _upsertNode(num, patch) {
    const cfg = this.getConfig()
    const max = Number(cfg?.ui?.maxNodeEntries || 400)
    const db = this.getNodeDb()
    meshUpsertNode(db, num, patch)
    const pruned = meshPruneNodeDb(db, max)
    this.nodeDb = pruned
    meshWriteNodeDb(pruned)
  }

  subscribe(fn) {
    this._subscribers.add(fn)
    try { fn(this.getState()) } catch (_) { /* ignore */ }
    return () => this._subscribers.delete(fn)
  }

  _notify() {
    const state = this.getState()
    for (const fn of Array.from(this._subscribers)) {
      try { fn(state) } catch (_) { /* ignore */ }
    }
  }

  getState() {
    return {
      config: this.getConfig(),
      status: { ...this.status },
      traffic: this.getTrafficLog(),
      nodes: this.getNodes(),
    }
  }

  _appendLog(entry) {
    meshAppendTraffic(entry)
    this._notify()
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...(patch || {}) }
    this._notify()
  }

  _computeReconnectDelayMs(attempt) {
    const cfg = this.getConfig()
    const min = Math.max(500, Math.floor(Number(cfg?.ui?.autoReconnectMinDelayMs) || 1500))
    const max = Math.max(min, Math.floor(Number(cfg?.ui?.autoReconnectMaxDelayMs) || 30000))
    const exp = Math.min(max, Math.floor(min * Math.pow(2, Math.max(0, attempt - 1))))
    const jitter = Math.floor(exp * 0.2 * Math.random())
    return Math.min(max, exp + jitter)
  }

  _scheduleReconnect(reason) {
    const cfg = this.getConfig()
    if (!cfg?.ui?.autoReconnect) return
    if (this.manualDisconnect) return
    if (this.reconnectTimer) return
    if (this.connectInFlight) return
    if (!this.lastBleDevice && !getLastBleDeviceId()) return

    const nextAttempt = this.reconnectAttempt + 1
    const maxAttempts = Math.max(0, Math.floor(Number(cfg?.ui?.autoReconnectMaxAttempts) || 0))
    if (maxAttempts > 0 && nextAttempt > maxAttempts) {
      this._appendLog({ dir: 'sys', ts: Date.now(), level: 'warn', msg: `Auto-reconnect stopped after ${maxAttempts} attempts.` })
      this._setStatus({ reconnecting: false, reconnectAttempt: this.reconnectAttempt, nextReconnectAt: null })
      return
    }

    this.reconnectAttempt = nextAttempt
    const delay = this._computeReconnectDelayMs(nextAttempt)
    const at = Date.now() + delay

    this._appendLog({
      dir: 'sys',
      ts: Date.now(),
      level: 'info',
      msg: `Auto-reconnect: ${reason}. Retrying in ${Math.max(1, Math.round(delay / 1000))}s (attempt ${nextAttempt}).`,
    })
    this._setStatus({ reconnecting: true, reconnectAttempt: nextAttempt, nextReconnectAt: at })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this._runReconnect()
    }, delay)
  }

  async _runReconnect() {
    const cfg = this.getConfig()
    if (!cfg?.ui?.autoReconnect) return
    if (this.manualDisconnect) return
    if (this.connectInFlight) return

    try {
      this._setStatus({ reconnecting: true, nextReconnectAt: null })
      await this._connectInternal({ auto: true })
    } catch (e) {
      const msg = formatError(e)
      this._appendLog({ dir: 'sys', ts: Date.now(), level: 'warn', msg: `Auto-reconnect failed (attempt ${this.reconnectAttempt}): ${msg}`, data: e })
      this._setStatus({ lastError: msg })
      this._scheduleReconnect('Reconnect failed')
    }
  }

  async connect() {
    return await this._connectInternal({ auto: false })
  }

  async _connectInternal(opts) {
    if (this.connectInFlight) return await this.connectInFlight

    const p = (async () => {
      const auto = !!opts?.auto
      const cfg = this.getConfig()
      if (cfg.driver !== 'meshtastic') {
        throw new Error(`Driver not supported yet: ${cfg.driver}`)
      }
      const connKind = cfg?.connection?.kind || 'ble'
      if (connKind !== 'ble') {
        throw new Error(`Connection kind not supported yet in browser build: ${connKind}`)
      }

      this.manualDisconnect = false
      if (!auto) this.reconnectAttempt = 0
      if (this.reconnectTimer) {
        try { clearTimeout(this.reconnectTimer) } catch (_) { /* ignore */ }
      }
      this.reconnectTimer = null

      // Cleanup any existing driver without flipping manualDisconnect.
      try { await this.driver?.disconnect() } catch (_) { /* ignore */ }
      this.driver = null

      const d = new MeshtasticDriver()
      d.onLog((e) => this._appendLog({ dir: 'sys', ...e }))
      d.onDeviceStatus((e) => {
        try {
          const dev = d.getBleDevice?.()
          if (dev) this.lastBleDevice = dev
        } catch (_) {
          // ignore
        }

        this._setStatus({
          deviceStatus: e.status ?? null,
          deviceStatusLabel: e.label ?? null,
          linkConnected: !!e.linkConnected,
          connected: !!e.ready,
        })

        if (e?.ready) {
          this.reconnectAttempt = 0
          this._setStatus({ reconnecting: false, reconnectAttempt: 0, nextReconnectAt: null, lastError: null })
          return
        }

        if (Number(e?.status) === 2) {
          this._scheduleReconnect('Device disconnected')
        }
      })
      d.onDeviceInfo((info) => {
        this._setStatus({ lastDeviceInfo: info || null })
      })
      d.onNodeInfo((info) => {
        try {
          const num = meshAsFiniteNumber(info?.num ?? info?.nodeNum ?? info?.id ?? null)
          const user = info?.user ?? null
          const shortName = meshAsNonEmptyString(user?.shortName ?? info?.shortName ?? null)
          const longName = meshAsNonEmptyString(user?.longName ?? info?.longName ?? null)
          const pos = info?.position ?? null
          const ll = meshExtractLatLon(pos)
          const patch = { lastSeenTs: Date.now() }
          if (shortName) patch.shortName = shortName
          if (longName) patch.longName = longName
          if (ll) patch.position = { ...ll, alt: meshAsFiniteNumber(pos?.altitude ?? null) ?? undefined, ts: Date.now(), source: 'nodeinfo' }
          if (num != null) this._upsertNode(num, patch)
        } catch (_) {
          // ignore
        } finally {
          this._notify()
        }
      })
      d.onUser((m) => {
        try {
          const from = meshAsFiniteNumber(m?.from ?? null)
          const u = m?.data ?? null
          const shortName = meshAsNonEmptyString(u?.shortName ?? null)
          const longName = meshAsNonEmptyString(u?.longName ?? null)
          const patch = { lastSeenTs: Date.now() }
          if (shortName) patch.shortName = shortName
          if (longName) patch.longName = longName
          if (from != null) this._upsertNode(from, patch)
        } catch (_) {
          // ignore
        } finally {
          this._notify()
        }
      })
      d.onPosition((m) => {
        try {
          const from = meshAsFiniteNumber(m?.from ?? null)
          const pos = m?.data ?? null
          const ll = meshExtractLatLon(pos)
          if (from == null || !ll) return
          const alt = meshAsFiniteNumber(pos?.altitude ?? null)
          this._upsertNode(from, { lastSeenTs: Date.now(), position: { ...ll, alt: alt ?? undefined, ts: Date.now(), source: 'position' } })
        } catch (_) {
          // ignore
        } finally {
          this._notify()
        }
      })
      d.onTelemetry((m) => {
        try {
          const from = meshAsFiniteNumber(m?.from ?? null)
          if (from == null) return
          const t = m?.data ?? null
          if (!t || typeof t !== 'object') return
          // Keep only a small subset to avoid bloating storage.
          const dev = t?.deviceMetrics ?? t?.device_metrics ?? null
          const env = t?.environmentMetrics ?? t?.environment_metrics ?? null
          const patch = { lastSeenTs: Date.now() }
          if (dev && typeof dev === 'object') {
            patch.device = {
              batteryLevel: meshAsFiniteNumber(dev?.batteryLevel ?? dev?.battery_level ?? null) ?? undefined,
              voltage: meshAsFiniteNumber(dev?.voltage ?? null) ?? undefined,
              channelUtilization: meshAsFiniteNumber(dev?.channelUtilization ?? dev?.channel_utilization ?? null) ?? undefined,
              airUtilTx: meshAsFiniteNumber(dev?.airUtilTx ?? dev?.air_util_tx ?? null) ?? undefined,
            }
          }
          if (env && typeof env === 'object') {
            patch.env = {
              temperature: meshAsFiniteNumber(env?.temperature ?? null) ?? undefined,
              relativeHumidity: meshAsFiniteNumber(env?.relativeHumidity ?? env?.relative_humidity ?? null) ?? undefined,
              barometricPressure: meshAsFiniteNumber(env?.barometricPressure ?? env?.barometric_pressure ?? null) ?? undefined,
            }
          }
          this._upsertNode(from, patch)
        } catch (_) {
          // ignore
        } finally {
          this._notify()
        }
      })
      d.onReceive((e) => {
        // store a simplified view for UI
        try {
          const ts = Date.now()
          if (e?.kind === 'message') {
            const from = meshAsFiniteNumber(e?.msg?.from ?? null)
            if (from != null) this._upsertNode(from, { lastSeenTs: ts })
          } else if (e?.kind === 'packet') {
            const pkt = e?.pkt
            const from = meshAsFiniteNumber(pkt?.from ?? null)
            if (from != null) {
              const rxSnr = meshAsFiniteNumber(pkt?.rxSnr ?? pkt?.rx_snr ?? null)
              const rxRssi = meshAsFiniteNumber(pkt?.rxRssi ?? pkt?.rx_rssi ?? null)
              const hopStart = meshAsFiniteNumber(pkt?.hopStart ?? pkt?.hop_start ?? null)
              const hopLimit = meshAsFiniteNumber(pkt?.hopLimit ?? pkt?.hop_limit ?? null)
              const portnum = pkt?.decoded?.portnum ?? pkt?.decoded?.portNum ?? null
              this._upsertNode(from, {
                lastSeenTs: ts,
                lastSnr: rxSnr ?? undefined,
                lastRssi: rxRssi ?? undefined,
                lastHopStart: hopStart ?? undefined,
                lastHopLimit: hopLimit ?? undefined,
                lastPort: portnum != null ? String(portnum) : undefined,
              })
            }
          }
        } catch (_) {
          // ignore
        }
        this._appendLog({
          dir: 'in',
          ts: e.ts,
          kind: e.kind,
          from: e?.kind === 'message' ? (meshAsFiniteNumber(e?.msg?.from ?? null) ?? undefined) : (meshAsFiniteNumber(e?.pkt?.from ?? null) ?? undefined),
          to: e?.kind === 'message' ? (meshAsFiniteNumber(e?.msg?.to ?? null) ?? undefined) : (meshAsFiniteNumber(e?.pkt?.to ?? null) ?? undefined),
          channel: e?.kind === 'message' ? (meshAsFiniteNumber(e?.msg?.channel ?? null) ?? undefined) : (meshAsFiniteNumber(e?.pkt?.channel ?? null) ?? undefined),
          rxSnr: e?.kind === 'packet' ? (meshAsFiniteNumber(e?.pkt?.rxSnr ?? e?.pkt?.rx_snr ?? null) ?? undefined) : undefined,
          rxRssi: e?.kind === 'packet' ? (meshAsFiniteNumber(e?.pkt?.rxRssi ?? e?.pkt?.rx_rssi ?? null) ?? undefined) : undefined,
          hopStart: e?.kind === 'packet' ? (meshAsFiniteNumber(e?.pkt?.hopStart ?? e?.pkt?.hop_start ?? null) ?? undefined) : undefined,
          hopLimit: e?.kind === 'packet' ? (meshAsFiniteNumber(e?.pkt?.hopLimit ?? e?.pkt?.hop_limit ?? null) ?? undefined) : undefined,
          portnum: e?.kind === 'packet' ? (e?.pkt?.decoded?.portnum ?? e?.pkt?.decoded?.portNum ?? null) : undefined,
          text: e.kind === 'message' ? (e?.msg?.data ?? null) : null,
          raw: e.kind === 'message' ? e.msg : e.pkt,
        })
      })

      this.driver = d
      this._setStatus({
        connected: false,
        linkConnected: false,
        driver: 'meshtastic',
        connection: connKind,
        deviceStatus: 3,
        deviceStatusLabel: meshDeviceStatusLabel(3),
        lastDeviceInfo: auto ? (this.status.lastDeviceInfo || null) : null,
        reconnecting: auto,
        reconnectAttempt: auto ? this.reconnectAttempt : 0,
        nextReconnectAt: null,
        lastError: null,
      })

      const info = await d.connectBle({ device: this.lastBleDevice, interactive: !auto })
      try {
        const dev = d.getBleDevice?.()
        if (dev) this.lastBleDevice = dev
      } catch (_) {
        // ignore
      }
      if (info) this._setStatus({ lastDeviceInfo: info || null, lastError: null })
      return info
    })()

    this.connectInFlight = p
    try {
      return await p
    } catch (e) {
      const msg = formatError(e)
      this._setStatus({ lastError: msg })
      if (!opts?.auto) {
        this._appendLog({ dir: 'sys', ts: Date.now(), level: 'warn', msg: `Connect failed: ${msg}`, data: e })
      }
      try { await this.driver?.disconnect() } catch (_) { /* ignore */ }
      this.driver = null
      this._setStatus({
        connected: false,
        linkConnected: false,
        driver: null,
        connection: null,
        deviceStatus: 2,
        deviceStatusLabel: meshDeviceStatusLabel(2),
        reconnecting: !!opts?.auto,
        reconnectAttempt: opts?.auto ? this.reconnectAttempt : 0,
        nextReconnectAt: null,
      })
      throw e
    } finally {
      if (this.connectInFlight === p) this.connectInFlight = null
    }
  }

  async disconnect() {
    this.manualDisconnect = true
    this.reconnectAttempt = 0
    if (this.reconnectTimer) {
      try { clearTimeout(this.reconnectTimer) } catch (_) { /* ignore */ }
    }
    this.reconnectTimer = null

    try { await this.driver?.disconnect() } catch (_) { /* ignore */ }
    this.driver = null
    this._setStatus({
      connected: false,
      linkConnected: false,
      reconnecting: false,
      reconnectAttempt: 0,
      nextReconnectAt: null,
      lastError: null,
      driver: null,
      connection: null,
      deviceStatus: 2,
      deviceStatusLabel: meshDeviceStatusLabel(2),
    })
  }

  /**
   * Send a line of text via the mesh.
   * Returns whatever the underlying driver returns.
   */
  async sendText(text, opts) {
    const msg = String(text || '').trim()
    if (!msg) throw new Error('Nothing to send')
    if (!this.driver) throw new Error('Mesh not connected')

    const cfg = this.getConfig()
    const ts = Date.now()
    this._appendLog({ dir: 'out', ts, kind: 'text', text: msg, opts: opts || null })

    const res = await this.driver.sendText(msg, opts)
    // If we want to attach ack status later, we can update log entries.
    return res
  }
}

// Singleton instance
const xcomMesh = new XcomMeshTransport()

// Make available to other scripts/modules.
try {
  globalThis.xcomMesh = xcomMesh
  globalThis.getMeshConfig = () => xcomMesh.getConfig()
  globalThis.setMeshConfig = (p) => xcomMesh.setConfig(p)
  globalThis.meshConnect = () => xcomMesh.connect()
  globalThis.meshDisconnect = () => xcomMesh.disconnect()
  globalThis.meshSendText = (t, o) => xcomMesh.sendText(t, o)
  globalThis.meshGetTrafficLog = () => xcomMesh.getTrafficLog()
  globalThis.meshClearTrafficLog = () => xcomMesh.clearTrafficLog()
  globalThis.meshGetNodes = () => xcomMesh.getNodes()
  globalThis.meshClearNodes = () => xcomMesh.clearNodes()
  globalThis.meshGetCoverageSamples = () => meshReadCoverage()
  globalThis.meshAppendCoverageSample = (s) => meshAppendCoverage(s, xcomMesh.getConfig()?.ui?.maxCoverageEntries || 2000)
  globalThis.meshClearCoverageSamples = () => meshClearCoverage()
} catch (_) {
  // ignore
}
