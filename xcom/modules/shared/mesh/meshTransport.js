/**
 * Mesh transport layer for XCOM.
 *
 * Goals:
 * - Provide a small, browser-friendly API for Meshtastic + MeshCore devices (Web Bluetooth)
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
const LS_MESH_DM_UNREAD = LS_MESH_PREFIX + 'dmUnread.v1'
// Note: we keep a legacy key for older builds that only supported Meshtastic.
const LS_MESH_LAST_DEVICE_ID_LEGACY = LS_MESH_PREFIX + 'lastBleDeviceId.v1'
const LS_MESH_LAST_DEVICE_ID_MT = LS_MESH_PREFIX + 'lastBleDeviceId.meshtastic.v1'
const LS_MESH_LAST_DEVICE_ID_MC = LS_MESH_PREFIX + 'lastBleDeviceId.meshcore.v1'
const LS_MESH_NODES = LS_MESH_PREFIX + 'nodes.v1'
const LS_MESH_CHANNELS = LS_MESH_PREFIX + 'channels.v1'
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

function lastBleDeviceKey(driver) {
  return driver === 'meshcore' ? LS_MESH_LAST_DEVICE_ID_MC : LS_MESH_LAST_DEVICE_ID_MT
}

function getLastBleDeviceId(driver) {
  if (driver === 'meshcore') return readString(LS_MESH_LAST_DEVICE_ID_MC)

  // Meshtastic: prefer the new key, fall back to legacy.
  const next = readString(LS_MESH_LAST_DEVICE_ID_MT)
  if (next) return next
  return readString(LS_MESH_LAST_DEVICE_ID_LEGACY)
}

function setLastBleDeviceId(driver, id) {
  writeString(lastBleDeviceKey(driver), id)
  // Keep legacy key in sync for Meshtastic users upgrading from older builds.
  if (driver !== 'meshcore') writeString(LS_MESH_LAST_DEVICE_ID_LEGACY, id)
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
    driver: 'meshtastic', // 'meshtastic' | 'meshcore'
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
    meshcore: {
      // Where to send:
      // - 'broadcast' (to channel)
      // - 'direct' (to pubkey prefix)
      destination: 'broadcast',
      toNodeId: '', // 12 hex chars (6-byte pubkey prefix) for direct sends
      channel: 0, // uint8
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
  next.meshcore = { ...defaults.meshcore, ...(raw?.meshcore && typeof raw.meshcore === 'object' ? raw.meshcore : {}) }
  next.ui = { ...defaults.ui, ...(raw?.ui && typeof raw.ui === 'object' ? raw.ui : {}) }

  next.driver = next.driver === 'meshcore' ? 'meshcore' : (next.driver === 'meshtastic' ? 'meshtastic' : defaults.driver)
  next.connection.kind = next.connection.kind === 'ble' ? 'ble' : defaults.connection.kind

  next.meshtastic.destination = next.meshtastic.destination === 'direct' ? 'direct' : 'broadcast'
  next.meshtastic.toNodeId = String(next.meshtastic.toNodeId || '').trim()
  next.meshtastic.channel = Math.max(0, Math.min(7, Math.floor(Number(next.meshtastic.channel) || 0)))
  next.meshtastic.wantAck = next.meshtastic.wantAck !== false

  next.meshcore.destination = next.meshcore.destination === 'direct' ? 'direct' : 'broadcast'
  next.meshcore.toNodeId = String(next.meshcore.toNodeId || '').trim()
  next.meshcore.channel = Math.max(0, Math.min(255, Math.floor(Number(next.meshcore.channel) || 0)))

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
  if (partial?.meshcore) merged.meshcore = { ...base.meshcore, ...partial.meshcore }
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
// State DBs (persistent)
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

function meshNormalizeMeshcorePrefixHex(raw) {
  const s = meshAsNonEmptyString(raw)
  if (!s) return null
  const cleaned = s.replace(/^!/, '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  return cleaned.length === 12 ? cleaned : null
}

function meshNormalizeMeshtasticNodeId(raw) {
  const s = meshAsNonEmptyString(raw)
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

// -----------------------------
// Direct-message unread DB (persistent)
// -----------------------------

function meshNormalizeDmUnreadMeta(v) {
  if (typeof v === 'number') {
    const ts = meshAsFiniteNumber(v)
    if (!ts) return null
    return { ts: Math.floor(ts), count: 1 }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const ts = meshAsFiniteNumber(v?.ts ?? null)
  if (!ts) return null
  const countRaw = meshAsFiniteNumber(v?.count ?? null)
  const count = countRaw != null ? Math.max(1, Math.min(999, Math.floor(countRaw))) : 1
  return { ts: Math.floor(ts), count }
}

function meshPruneDmUnreadDb(db, maxKeys) {
  const max = Math.max(10, Math.min(2000, Math.floor(Number(maxKeys) || 250)))
  try {
    const entries = Object.entries(db || {})
      .filter(([k, v]) => k != null && String(k).trim() && v && typeof v === 'object')
    if (entries.length <= max) return db
    entries.sort((a, b) => Number(b?.[1]?.ts || 0) - Number(a?.[1]?.ts || 0))
    const next = {}
    for (const [k, v] of entries.slice(0, max)) next[k] = v
    return next
  } catch (_) {
    return db
  }
}

function meshReadDmUnreadDb() {
  const raw = meshReadJson(LS_MESH_DM_UNREAD, {})
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    const key = String(k || '').trim()
    if (!key) continue
    const meta = meshNormalizeDmUnreadMeta(v)
    if (!meta) continue
    out[key] = meta
  }
  return meshPruneDmUnreadDb(out, 250)
}

function meshWriteDmUnreadDb(db) {
  const safe = (db && typeof db === 'object' && !Array.isArray(db)) ? db : {}
  meshWriteJson(LS_MESH_DM_UNREAD, safe)
}

// -----------------------------
// Channel DB (persistent)
// -----------------------------

function meshDefaultChannelName(driver, index) {
  const i = Math.max(0, Math.floor(Number(index) || 0))
  if (driver === 'meshtastic') {
    if (i === 0) return 'Primary'
    if (i === 7) return 'Admin'
    return `Channel ${i}`
  }
  return `Channel ${i}`
}

function meshReadChannelDb() {
  const raw = meshReadJson(LS_MESH_CHANNELS, null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { meshtastic: [], meshcore: [] }
  const mt = Array.isArray(raw.meshtastic) ? raw.meshtastic : []
  const mc = Array.isArray(raw.meshcore) ? raw.meshcore : []
  return { meshtastic: mt, meshcore: mc }
}

function meshWriteChannelDb(db) {
  const safe = (db && typeof db === 'object' && !Array.isArray(db)) ? db : { meshtastic: [], meshcore: [] }
  meshWriteJson(LS_MESH_CHANNELS, safe)
}

function meshNormalizeChannelEntry(driver, entry) {
  const d = driver === 'meshcore' ? 'meshcore' : 'meshtastic'
  const idx = meshAsFiniteNumber(entry?.index ?? entry?.idx ?? entry?.channel ?? entry?.channelIndex ?? null)
  if (idx == null) return null

  const max = d === 'meshcore' ? 255 : 7
  const index = Math.max(0, Math.min(max, Math.floor(idx)))

  const name = meshAsNonEmptyString(entry?.name ?? null) || meshDefaultChannelName(d, index)
  const role = meshAsNonEmptyString(entry?.role ?? null) || undefined
  const ts = meshAsFiniteNumber(entry?.ts ?? entry?.updatedAt ?? null) ?? Date.now()

  return { index, name, ...(role ? { role } : {}), ts }
}

function meshNormalizeMeshtasticChannelPacket(ch) {
  if (!ch || typeof ch !== 'object') return null
  const any = ch
  const idx = meshAsFiniteNumber(any?.index ?? any?.channelNum ?? any?.channelNumber ?? any?.channel ?? null)
  if (idx == null) return null
  const index = Math.max(0, Math.min(7, Math.floor(idx)))

  const settings = any?.settings ?? null
  const name = meshAsNonEmptyString(settings?.name ?? any?.name ?? null) || meshDefaultChannelName('meshtastic', index)

  let role = null
  try {
    const r = any?.role ?? settings?.role ?? null
    if (typeof r === 'string') role = meshAsNonEmptyString(r)
    else if (typeof r === 'number' && Number.isFinite(r)) {
      // Optional: map numeric roles to enum labels when present.
      const Enum =
        globalThis?.Meshtastic?.Protobuf?.Channel?.Channel_Role ||
        globalThis?.Meshtastic?.Protobufs?.Channel?.Channel_Role ||
        globalThis?.Meshtastic?.Protobuf?.Channel?.Channel_Role_ ||
        null
      const label = Enum && Enum[r]
      role = meshAsNonEmptyString(label ?? null) || String(r)
    }
  } catch (_) {
    role = null
  }

  return { index, name, ...(role ? { role } : {}), ts: Date.now() }
}

function meshUpsertChannel(db, driver, entry) {
  const d = driver === 'meshcore' ? 'meshcore' : 'meshtastic'
  const norm = meshNormalizeChannelEntry(d, entry)
  if (!norm) return db

  const base = (db && typeof db === 'object' && !Array.isArray(db)) ? db : { meshtastic: [], meshcore: [] }
  const arr = Array.isArray(base[d]) ? base[d] : []
  const idx = arr.findIndex((c) => Number(c?.index) === norm.index)
  const next = idx >= 0 ? arr.map((c, i) => (i === idx ? { ...(c || {}), ...norm } : c)) : [...arr, norm]
  // Keep sorted and capped (defensive: avoid unbounded growth).
  next.sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0))
  base[d] = next.slice(0, 64)
  return base
}

function meshChannelDbToArray(db, driver) {
  try {
    const d = driver === 'meshcore' ? 'meshcore' : 'meshtastic'
    const arr = Array.isArray(db?.[d]) ? db[d] : []
    return arr
      .filter((c) => c && typeof c === 'object' && Number.isFinite(Number(c.index)))
      .map((c) => ({
        index: Math.floor(Number(c.index)),
        name: meshAsNonEmptyString(c.name) || meshDefaultChannelName(d, Number(c.index)),
        ...(meshAsNonEmptyString(c.role) ? { role: meshAsNonEmptyString(c.role) } : {}),
        ...(Number.isFinite(Number(c.ts)) ? { ts: Number(c.ts) } : {}),
      }))
      .sort((a, b) => a.index - b.index)
  } catch (_) {
    return []
  }
}

function meshFormatMeshtasticNodeId(num) {
  const n = Math.floor(Number(num))
  if (!Number.isFinite(n)) return null
  // Meshtastic commonly displays node IDs as "!deadbeef" (uint32 hex).
  return '!' + ((n >>> 0).toString(16).padStart(8, '0'))
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

// -----------------------------
// Meshtastic ATAK plugin (TAKTracker) PLI decode (protobuf)
// -----------------------------

function meshAtakBytes(payload) {
  if (!payload) return null
  if (payload instanceof Uint8Array) return payload
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (Array.isArray(payload)) {
    try { return new Uint8Array(payload.map((v) => Number(v) & 0xff)) } catch (_) { return null }
  }

  if (typeof payload === 'string') {
    const s = String(payload || '').trim()
    if (!s) return null
    try {
      if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') return new Uint8Array(Buffer.from(s, 'base64'))
    } catch (_) { /* ignore */ }
    try {
      const bin = atob(s)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff
      return out
    } catch (_) {
      return null
    }
  }

  // bufbuild protobuf messages: bytes can be a view over an ArrayBuffer
  try {
    const any = payload
    if (any?.buffer instanceof ArrayBuffer && typeof any?.byteOffset === 'number' && typeof any?.byteLength === 'number') {
      return new Uint8Array(any.buffer, any.byteOffset, any.byteLength)
    }
  } catch (_) {
    // ignore
  }

  return null
}

function meshAtakReadVarint(buf, offset) {
  let o = offset
  let shift = 0n
  let v = 0n
  for (let i = 0; i < 10; i++) {
    if (o >= buf.length) return null
    const b = buf[o++]
    v |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value: v, offset: o }
    shift += 7n
  }
  return null
}

function meshAtakReadSFixed32(buf, offset) {
  const o = offset
  if (o + 4 > buf.length) return null
  const dv = new DataView(buf.buffer, buf.byteOffset + o, 4)
  return { value: dv.getInt32(0, true), offset: o + 4 }
}

function meshAtakSkipField(buf, offset, wireType) {
  const wt = wireType | 0
  if (wt === 0) {
    const v = meshAtakReadVarint(buf, offset)
    return v ? v.offset : null
  }
  if (wt === 1) return offset + 8 <= buf.length ? offset + 8 : null
  if (wt === 2) {
    const l = meshAtakReadVarint(buf, offset)
    if (!l) return null
    const len = Number(l.value)
    if (!Number.isFinite(len) || len < 0) return null
    const end = l.offset + len
    return end <= buf.length ? end : null
  }
  if (wt === 5) return offset + 4 <= buf.length ? offset + 4 : null
  return null
}

function meshAtakU32(v) { return Number(v & 0xffff_ffffn) }
function meshAtakI32(v) {
  const u = meshAtakU32(v)
  return u >= 0x8000_0000 ? u - 0x1_0000_0000 : u
}

function meshAtakLooksPrintable(s) {
  const t = String(s || '').trim()
  if (!t) return false
  let printable = 0
  let total = 0
  for (const ch of t) {
    total++
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x7e)) printable++
  }
  return total > 0 && printable / total >= 0.8
}

function meshAtakDecodeUtf8(bytes) {
  try {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch (_) {
    // ignore
  }
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function meshAtakCleanString(bytes) {
  const s = meshAtakDecodeUtf8(bytes).replace(/\u0000/g, '').trim()
  return (s && meshAtakLooksPrintable(s)) ? s : null
}

function meshAtakParseContact(bytes) {
  let callsign = null
  let deviceCallsign = null
  let o = 0
  while (o < bytes.length) {
    const key = meshAtakReadVarint(bytes, o)
    if (!key) break
    o = key.offset
    const fieldNo = Number(key.value >> 3n)
    const wt = Number(key.value & 7n)
    if (wt === 2) {
      const len = meshAtakReadVarint(bytes, o)
      if (!len) break
      o = len.offset
      const n = Number(len.value)
      if (!Number.isFinite(n) || n < 0 || o + n > bytes.length) break
      const v = bytes.slice(o, o + n)
      o += n
      const s = meshAtakCleanString(v)
      if (fieldNo === 1 && s) callsign = s
      else if (fieldNo === 2 && s) deviceCallsign = s
      continue
    }
    const skipped = meshAtakSkipField(bytes, o, wt)
    if (skipped == null) break
    o = skipped
  }
  return { callsign, deviceCallsign }
}

function meshAtakParseStatus(bytes) {
  let battery = null
  let o = 0
  while (o < bytes.length) {
    const key = meshAtakReadVarint(bytes, o)
    if (!key) break
    o = key.offset
    const fieldNo = Number(key.value >> 3n)
    const wt = Number(key.value & 7n)
    if (fieldNo === 1 && wt === 0) {
      const v = meshAtakReadVarint(bytes, o)
      if (!v) break
      o = v.offset
      battery = meshAtakU32(v.value)
      continue
    }
    const skipped = meshAtakSkipField(bytes, o, wt)
    if (skipped == null) break
    o = skipped
  }
  return { battery }
}

function meshAtakParsePli(bytes) {
  let latI = null
  let lonI = null
  let alt = null

  let o = 0
  while (o < bytes.length) {
    const key = meshAtakReadVarint(bytes, o)
    if (!key) break
    o = key.offset
    const fieldNo = Number(key.value >> 3n)
    const wt = Number(key.value & 7n)

    if (fieldNo === 1 && wt === 5) {
      const v = meshAtakReadSFixed32(bytes, o)
      if (!v) break
      o = v.offset
      latI = v.value
      continue
    }
    if (fieldNo === 2 && wt === 5) {
      const v = meshAtakReadSFixed32(bytes, o)
      if (!v) break
      o = v.offset
      lonI = v.value
      continue
    }
    if (fieldNo === 3 && wt === 0) {
      const v = meshAtakReadVarint(bytes, o)
      if (!v) break
      o = v.offset
      alt = meshAtakI32(v.value)
      continue
    }

    const skipped = meshAtakSkipField(bytes, o, wt)
    if (skipped == null) break
    o = skipped
  }

  if (latI == null || lonI == null) return null
  const lat = latI * 1e-7
  const lon = lonI * 1e-7
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon, alt }
}

function meshAtakDecodeTakPacket(payload) {
  const bytes = meshAtakBytes(payload)
  if (!bytes || bytes.length === 0) return null

  let callsign = null
  let deviceCallsign = null
  let battery = null
  let pli = null

  let o = 0
  while (o < bytes.length) {
    const key = meshAtakReadVarint(bytes, o)
    if (!key) break
    o = key.offset
    const fieldNo = Number(key.value >> 3n)
    const wt = Number(key.value & 7n)

    if (wt === 2) {
      const len = meshAtakReadVarint(bytes, o)
      if (!len) break
      o = len.offset
      const n = Number(len.value)
      if (!Number.isFinite(n) || n < 0 || o + n > bytes.length) break
      const v = bytes.slice(o, o + n)
      o += n

      if (fieldNo === 2) {
        const c = meshAtakParseContact(v)
        if (c.callsign) callsign = c.callsign
        if (c.deviceCallsign) deviceCallsign = c.deviceCallsign
      } else if (fieldNo === 4) {
        const s = meshAtakParseStatus(v)
        if (s.battery != null) battery = s.battery
      } else if (fieldNo === 5) {
        const p = meshAtakParsePli(v)
        if (p) pli = p
      }
      continue
    }

    const skipped = meshAtakSkipField(bytes, o, wt)
    if (skipped == null) break
    o = skipped
  }

  if (!callsign && !deviceCallsign && battery == null && !pli) return null
  return { callsign, deviceCallsign, battery, pli }
}

function meshIsAtakPluginPort(portnum) {
  try {
    if (String(portnum ?? '').toUpperCase() === 'ATAK_PLUGIN') return true
    const atak =
      globalThis?.Meshtastic?.Protobuf?.Portnums?.PortNum?.ATAK_PLUGIN ??
      globalThis?.Meshtastic?.Protobufs?.Portnums?.PortNum?.ATAK_PLUGIN ??
      null
    return atak != null && Number(portnum) === Number(atak)
  } catch (_) {
    return false
  }
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

    this._channelSubscribers = new Set()
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

  onChannel(fn) {
    if (typeof fn !== 'function') return () => {}
    this._channelSubscribers.add(fn)
    return () => this._channelSubscribers.delete(fn)
  }

  _emitChannel(ch) {
    try {
      for (const fn of Array.from(this._channelSubscribers)) {
        try { fn(ch) } catch (_) { /* ignore */ }
      }
    } catch (_) {
      // ignore
    }
  }

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
      if (ev?.onChannelPacket?.subscribe) {
        this.subs.push(ev.onChannelPacket.subscribe((ch) => this._emitChannel(ch)))
      }
    } catch (_) {
      // ignore
    }

    const cfg = _meshConfigGet()
    const filter = cfg?.meshtastic?.deviceFilter || undefined

    let preferred = opts?.device || null
    if (!preferred) {
      const lastId = getLastBleDeviceId('meshtastic')
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
      if (typeof id === 'string' && id) setLastBleDeviceId('meshtastic', id)
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

    // Destination
    const destination = String(mt.destination || 'broadcast')
    const toNodeId = String(mt.toNodeId || '').trim()
    // Broadcast messages do not have a single recipient to ACK; requesting ACK can lead to ROUTING_APP TIMEOUT errors.
    const wantAck = (destination === 'direct' && !!toNodeId) ? !!mt.wantAck : false

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

  async requestChannels(opts) {
    if (!this.bleConn || !this.connected) throw new Error('Not connected to a Meshtastic device')
    const conn = this.bleConn

    const timeoutMs = Math.max(500, Math.min(15000, Math.floor(Number(opts?.timeoutMs) || 4000)))
    const want = [0, 1, 2, 3, 4, 5, 6, 7]
    const got = new Map()

    const unsub = this.onChannel((ch) => {
      const norm = meshNormalizeMeshtasticChannelPacket(ch)
      if (norm) got.set(norm.index, norm)
    })

    try {
      if (typeof conn?.getAllChannels === 'function') {
        try { await conn.getAllChannels() } catch (_) { /* ignore */ }
      } else if (typeof conn?.getChannel === 'function') {
        for (const i of want) {
          try { await conn.getChannel(i) } catch (_) { /* ignore */ }
        }
      } else {
        throw new Error('Meshtastic connection does not support channel import (getChannel/getAllChannels missing)')
      }

      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && got.size < want.length) {
        await new Promise((r) => setTimeout(r, 50))
      }
      return Array.from(got.values()).sort((a, b) => a.index - b.index)
    } finally {
      try { unsub() } catch (_) { /* ignore */ }
    }
  }
}

// -----------------------------
// Mesh driver (MeshCore)
// -----------------------------

// MeshCore uses a Nordic UART Service (NUS)-style BLE service for its command protocol.
const MESHCORE_NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
const MESHCORE_NUS_RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e' // write (central -> device)
const MESHCORE_NUS_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e' // notify (device -> central)

const MESHCORE_BLE_CHUNK = 20

// MeshCore command/response codes (see MeshCore Command Protocol docs).
const MESHCORE_CMD = Object.freeze({
  OK: 0x00,
  GET_DEVICE_QEURY: 0x01,
  APP_START: 0x02,
  GET_CONTACTS: 0x03,
  EXPORT_CONTACT: 0x04,
  SEND_TXT_MSG: 0x07,
  SEND_CHANNEL_TXT_MSG: 0x08,
  SYNC_NEXT_MESSAGE: 0x09,
  NO_MORE_MESSAGES: 0x0a,
  CONTACTS_START: 0x0b,
  CONTACT: 0x0c,
  END_OF_CONTACTS: 0x0d,
  GET_CHANNELS: 0x0e,
  CHANNEL: 0x0f,
  SEND_LOGIN: 0x10,
  LOGIN: 0x11,
  INVALID: 0x12,

  // Push codes
  PUSH_ADVERT: 0x80,
  PUSH_PATH_UPDATED: 0x81,
  PUSH_SEND_CONFIRMED: 0x82,
  PUSH_MSG_WAITING: 0x83,
  PUSH_RAW_DATA: 0x84,
  PUSH_FILE_REQUEST: 0x85,
  PUSH_FILE_SENT: 0x86,
  PUSH_FILE_RECV: 0x87,
  PUSH_FILE_DONE: 0x88,
  PUSH_NEW_ADVERT: 0x8a,
  PUSH_LOGIN_FAIL: 0x8b,
  PUSH_LOG_RX: 0x8c,
  PUSH_LOG_TX: 0x8d,
  PUSH_CONTROL_DATA: 0x8e,
})

const meshcoreTextEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
const meshcoreTextDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null

function meshcoreEncodeUtf8(s) {
  const t = String(s ?? '')
  if (meshcoreTextEncoder) return meshcoreTextEncoder.encode(t)
  const out = new Uint8Array(t.length)
  for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i) & 0xff
  return out
}

function meshcoreDecodeUtf8(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0)
  if (meshcoreTextDecoder) return meshcoreTextDecoder.decode(b)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

function meshcoreLooksLikeHumanText(s) {
  const t = String(s ?? '')
  if (!t.trim()) return false
  if (t.includes('X1.')) return true

  let bad = 0
  let total = 0
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    const code = t.charCodeAt(i)
    total++

    if (ch === '\uFFFD' || code === 0) {
      bad += 2
      continue
    }
    if (code < 0x20) {
      if (ch !== '\n' && ch !== '\r' && ch !== '\t') bad++
      continue
    }
    if (code === 0x7f) {
      bad++
      continue
    }
  }
  const ratio = total > 0 ? bad / total : 1
  return ratio <= 0.08
}

function meshcoreXorChecksum(payload) {
  let c = 0
  for (let i = 0; i < payload.length; i++) c ^= payload[i]
  return c & 0xff
}

function meshcoreWrapFrame(payload) {
  const len = payload.length >>> 0
  const out = new Uint8Array(len + 3)
  out[0] = len & 0xff
  out[1] = (len >> 8) & 0xff
  out.set(payload, 2)
  out[out.length - 1] = meshcoreXorChecksum(payload)
  return out
}

function meshcoreUnwrapFrames(buffer) {
  let buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(0)
  const frames = []

  while (buf.length >= 3) {
    const len = (buf[0] | (buf[1] << 8)) >>> 0
    const total = len + 3
    if (buf.length < total) break

    const payload = buf.subarray(2, 2 + len)
    const chk = buf[2 + len]
    const expected = meshcoreXorChecksum(payload)
    if (chk !== expected) {
      // Desync protection: drop buffer and let the next notification re-seed.
      buf = new Uint8Array(0)
      break
    }

    frames.push(payload)
    buf = buf.subarray(total)
  }

  return { frames, buffer: buf }
}

function meshcoreU32le(n) {
  const x = Number(n) >>> 0
  const b = new Uint8Array(4)
  b[0] = x & 0xff
  b[1] = (x >> 8) & 0xff
  b[2] = (x >> 16) & 0xff
  b[3] = (x >> 24) & 0xff
  return b
}

function meshcoreToHex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s
}

function meshcoreParseHexPrefix6(hex) {
  const raw = String(hex ?? '')
    .trim()
    .replace(/^!/, '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase()

  if (!raw || raw.length !== 12) return null

  const bytes = new Uint8Array(6)
  for (let i = 0; i < 6; i++) {
    const v = parseInt(raw.slice(i * 2, i * 2 + 2), 16)
    if (!Number.isFinite(v)) return null
    bytes[i] = v & 0xff
  }
  return bytes
}

function meshcoreNodeNumFromPrefix(prefix6) {
  if (!prefix6 || prefix6.length < 4) return null
  const n = ((prefix6[0] << 24) | (prefix6[1] << 16) | (prefix6[2] << 8) | prefix6[3]) >>> 0
  return n > 0 ? n : null
}

function meshcoreReadNullTerminatedString(bytes) {
  let end = bytes.length
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      end = i
      break
    }
  }
  return meshcoreDecodeUtf8(bytes.subarray(0, end)).trim()
}

function meshcoreParseSelfInfo(payload) {
  if (!(payload instanceof Uint8Array)) return null
  if (payload.length < 4 + 6 + 1 + 4 + 4 + 4 + 32 + 1 + 1) return null

  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let o = 0
  const nodeId = dv.getUint32(o, true)
  o += 4
  const prefix6 = payload.subarray(o, o + 6)
  o += 6
  o += 1 // adv_type
  const latI = dv.getInt32(o, true)
  o += 4
  const lonI = dv.getInt32(o, true)
  o += 4
  o += 4 // adv_loc_timestamp
  const nameBytes = payload.subarray(o, o + 32)
  o += 32
  o += 1 // adv_gps_pdop
  const battery = payload[o] ?? null

  const lat = Number.isFinite(latI) ? latI / 1e6 : null
  const lon = Number.isFinite(lonI) ? lonI / 1e6 : null
  const name = meshcoreReadNullTerminatedString(nameBytes)
  const prefixHex = meshcoreToHex(prefix6)
  const num = meshcoreNodeNumFromPrefix(prefix6)

  return { nodeId, prefix6, prefixHex, num, name, lat, lon, battery: battery == null ? null : Number(battery) }
}

function meshcoreParseIncomingMessage(payload) {
  if (!(payload instanceof Uint8Array)) return null
  if (payload.length < 4 + 6 + 1) return null
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let o = 0
  const senderTs = dv.getUint32(o, true)
  o += 4
  const prefix6 = payload.subarray(o, o + 6)
  o += 6
  const textLen = payload[o] ?? 0
  o += 1
  if (payload.length < o + textLen) return null
  const textBytes = payload.subarray(o, o + textLen)
  const text = meshcoreDecodeUtf8(textBytes)
  const prefixHex = meshcoreToHex(prefix6)
  const num = meshcoreNodeNumFromPrefix(prefix6)
  return { senderTs, prefix6, prefixHex, num, text }
}

class MeshCoreDriver {
  constructor() {
    this.device = null
    this.rx = null
    this.tx = null

    this.connected = false
    this.lastDeviceInfo = null

    this._onReceive = null
    this._onLog = null
    this._onDeviceStatus = null
    this._onDeviceInfo = null
    this._onNodeInfo = null
    this._onPosition = null

    this.rxBuffer = new Uint8Array(0)
    this.inbox = []
    this.inboxWaiters = []
    this.queue = Promise.resolve()
    this.syncQueued = false

    this.boundNotify = null
    this.boundDisconnected = null
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
  onPosition(fn) { this._onPosition = fn }

  // Interface compatibility with MeshtasticDriver (not all events exist in MeshCore).
  onUser(_fn) {}
  onTelemetry(_fn) {}
  onChannel(_fn) {}

  _emitNodeInfoFromInfo(info, source) {
    if (!info || typeof info !== 'object') return

    const num = meshAsFiniteNumber(info?.num ?? info?.nodeId ?? null)
    if (num == null) return

    const label = meshAsNonEmptyString(info?.name ?? null) || 'MeshCore'
    const lat = meshAsFiniteNumber(info?.lat ?? null)
    const lon = meshAsFiniteNumber(info?.lon ?? null)
    const hasPos = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180

    const nodeInfo = {
      num,
      user: { shortName: label, longName: label },
      prefixHex: meshAsNonEmptyString(info?.prefixHex ?? null) || undefined,
      position: hasPos ? { lat, lon } : undefined,
      meshcore: info,
      source: source || 'advert',
    }

    if (typeof this._onNodeInfo === 'function') {
      try { this._onNodeInfo(nodeInfo) } catch (_) { /* ignore */ }
    }

    // Best-effort: some consumers prefer a Position-like callback.
    if (hasPos && typeof this._onPosition === 'function') {
      try { this._onPosition({ from: num, data: { lat, lon }, meshcore: info, source: source || 'advert' }) } catch (_) { /* ignore */ }
    }
  }

  _emitDeviceStatus(status) {
    const s = Number(status)
    const normalized = Number.isFinite(s) ? s : status
    const label = meshDeviceStatusLabel(normalized) || String(normalized)
    const linkConnected = meshIsLinkConnected(normalized)
    this.connected = linkConnected
    if (typeof this._onDeviceStatus === 'function') {
      try { this._onDeviceStatus({ status: normalized, label, linkConnected, ready: linkConnected }) } catch (_) { /* ignore */ }
    }
  }

  getBleDevice() {
    return this.device || null
  }

  _enqueue(task) {
    const run = async () => await task()
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  _pushInbox(cmd) {
    this.inbox.push(cmd)
    const waiters = this.inboxWaiters.splice(0)
    for (const w of waiters) {
      try { w() } catch (_) { /* ignore */ }
    }
  }

  async _waitInbox(timeoutMs) {
    const ms = Math.max(100, Math.floor(Number(timeoutMs) || 5000))
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for MeshCore response')), ms)
      this.inboxWaiters.push(() => {
        try { clearTimeout(t) } catch (_) { /* ignore */ }
        resolve()
      })
    })
  }

  async _nextOf(types, timeoutMs) {
    const want = new Set(Array.isArray(types) ? types : [])
    const deadline = Date.now() + Math.max(100, Math.floor(Number(timeoutMs) || 5000))

    while (Date.now() < deadline) {
      const idx = this.inbox.findIndex((x) => want.has(x.type))
      if (idx >= 0) return this.inbox.splice(idx, 1)[0]
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await this._waitInbox(remaining)
    }

    throw new Error(`Timed out waiting for MeshCore response (${Array.from(want).map((n) => '0x' + n.toString(16)).join(', ')})`)
  }

  async _writeWrappedFrame(payload) {
    if (!this.rx) throw new Error('MeshCore RX characteristic not ready')
    const wrapped = meshcoreWrapFrame(payload)

    for (let i = 0; i < wrapped.length; i += MESHCORE_BLE_CHUNK) {
      const chunk = wrapped.subarray(i, i + MESHCORE_BLE_CHUNK)
      if (typeof this.rx.writeValueWithoutResponse === 'function') {
        await this.rx.writeValueWithoutResponse(chunk)
      } else {
        await this.rx.writeValue(chunk)
      }
    }
  }

  async _sendCommand(type, payload) {
    const p = payload ?? new Uint8Array(0)
    const cmd = new Uint8Array(1 + p.length)
    cmd[0] = type & 0xff
    cmd.set(p, 1)
    await this._writeWrappedFrame(cmd)
  }

  _handleCommandPayload(cmdPayload) {
    if (!(cmdPayload instanceof Uint8Array)) return
    if (cmdPayload.length < 1) return
    const type = cmdPayload[0] & 0xff
    const payload = cmdPayload.subarray(1)

    // Push codes (asynchronous). Ignore any we don't explicitly handle.
    if (type >= 0x80) {
      if (type === MESHCORE_CMD.PUSH_ADVERT || type === MESHCORE_CMD.PUSH_NEW_ADVERT) {
        try {
          const info = meshcoreParseSelfInfo(payload)
          if (info) this._emitNodeInfoFromInfo(info, type === MESHCORE_CMD.PUSH_NEW_ADVERT ? 'new_advert' : 'advert')
        } catch (e) {
          this._emitLog('warn', `MeshCore: failed to parse ADVERT push: ${formatError(e)}`, e)
        }
        return
      }
      if (type === MESHCORE_CMD.PUSH_MSG_WAITING) {
        this._emitLog('info', 'MeshCore: message(s) waiting; syncing…')
        this._queueSyncMessages()
        return
      }

      if (type === MESHCORE_CMD.PUSH_RAW_DATA) {
        // Structure: rssi(int8), snr(uint8, SNR*4), reserved(2), payload_type(uint8), payload_len(uint8), payload(bytes)
        try {
          if (payload.length >= 1 + 1 + 2 + 1 + 1) {
            const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
            let o = 0
            const rssi = dv.getInt8(o)
            o += 1
            const snr = payload[o] / 4
            o += 1
            o += 2 // reserved
            const payloadType = payload[o]
            o += 1
            const payloadLen = payload[o]
            o += 1
            const data = payload.subarray(o, o + payloadLen)

            const asText = meshcoreDecodeUtf8(data)
            const looksLikeText = meshcoreLooksLikeHumanText(asText)

            if (looksLikeText) {
              const msg = {
                from: null,
                to: null,
                channel: null,
                data: asText,
                rssi,
                snr,
                payloadType,
                bytes: Array.from(data),
              }
              if (typeof this._onReceive === 'function') {
                try { this._onReceive({ kind: 'message', ts: Date.now(), msg }) } catch (_) { /* ignore */ }
              }
            } else {
              // Keep non-text payloads visible in the traffic log.
              const pkt = {
                from: null,
                to: null,
                channel: null,
                rxRssi: rssi,
                rxSnr: snr,
                decoded: { portnum: payloadType },
                bytes: Array.from(data),
              }
              if (typeof this._onReceive === 'function') {
                try { this._onReceive({ kind: 'packet', ts: Date.now(), pkt }) } catch (_) { /* ignore */ }
              }
            }
          }
        } catch (e) {
          this._emitLog('warn', `MeshCore: failed to parse RAW_DATA push: ${formatError(e)}`, e)
        }
        return
      }

      return
    }

    // Non-push: enqueue for the current request flow to consume.
    this._pushInbox({ type, payload, raw: cmdPayload })
  }

  _onNotifyValue(value) {
    try {
      const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      const merged = new Uint8Array(this.rxBuffer.length + chunk.length)
      merged.set(this.rxBuffer, 0)
      merged.set(chunk, this.rxBuffer.length)
      this.rxBuffer = merged

      const res = meshcoreUnwrapFrames(this.rxBuffer)
      this.rxBuffer = res.buffer
      for (const frame of res.frames) this._handleCommandPayload(frame)
    } catch (_) {
      // ignore
    }
  }

  _queueSyncMessages() {
    if (this.syncQueued) return
    this.syncQueued = true
    void this._enqueue(async () => {
      try {
        await this._syncMessages()
      } catch (e) {
        this._emitLog('warn', `MeshCore sync failed: ${formatError(e)}`, e)
      } finally {
        this.syncQueued = false
      }
    })
  }

  async _syncMessages() {
    for (let iter = 0; iter < 200; iter++) {
      await this._sendCommand(MESHCORE_CMD.SYNC_NEXT_MESSAGE)
      const cmd = await this._nextOf([MESHCORE_CMD.SYNC_NEXT_MESSAGE, MESHCORE_CMD.NO_MORE_MESSAGES], 10_000)
      if (cmd.type === MESHCORE_CMD.NO_MORE_MESSAGES) return
      const msg = meshcoreParseIncomingMessage(cmd.payload)
      if (msg && typeof this._onReceive === 'function') {
        const msgObj = {
          from: msg.num ?? null,
          to: null,
          channel: null,
          data: msg.text,
          meshcore: msg,
        }
        try { this._onReceive({ kind: 'message', ts: Date.now(), msg: msgObj }) } catch (_) { /* ignore */ }
      }
    }
    this._emitLog('warn', 'MeshCore: sync loop stopped after 200 messages (guard)')
  }

  async _initProtocol(appName) {
    // Device query (protocol v4 is current in MeshCore docs; older devices may ignore unknown fields)
    await this._sendCommand(MESHCORE_CMD.GET_DEVICE_QEURY, new Uint8Array([4]))
    await this._nextOf([MESHCORE_CMD.GET_DEVICE_QEURY], 6000)

    // App start (announce ourselves so the device enables pushes).
    const nameBytes = meshcoreEncodeUtf8(appName || 'XCOM')
    const startPayload = new Uint8Array(1 + 6 + nameBytes.length)
    startPayload[0] = 4 // app_ver
    startPayload.set([0, 0, 0, 0, 0, 0], 1)
    startPayload.set(nameBytes, 1 + 6)
    await this._sendCommand(MESHCORE_CMD.APP_START, startPayload)

    const self = await this._nextOf([MESHCORE_CMD.APP_START], 6000)
    const info = meshcoreParseSelfInfo(self.payload)
    if (info) {
      const label = info.name?.trim() || 'MeshCore'
      this.lastDeviceInfo = { myNodeNum: info.num ?? undefined, nodeId: info.num ?? undefined, shortName: label, longName: label }
      if (typeof this._onDeviceInfo === 'function') {
        try { this._onDeviceInfo(this.lastDeviceInfo) } catch (_) { /* ignore */ }
      }
      try { this._emitNodeInfoFromInfo(info, 'selfinfo') } catch (_) { /* ignore */ }
    }

    // Drain any queued messages.
    await this._syncMessages()
  }

  async connectBle(opts) {
    const interactive = opts?.interactive !== false
    if (!globalThis.navigator?.bluetooth) throw new Error('Web Bluetooth not available')

    let dev = opts?.device || null

    if (!dev && !interactive) {
      try {
        const lastId = getLastBleDeviceId('meshcore')
        if (lastId && typeof globalThis.navigator.bluetooth.getDevices === 'function') {
          const list = await globalThis.navigator.bluetooth.getDevices()
          dev = Array.isArray(list) ? (list.find((d) => d?.id === lastId) || null) : null
        }
      } catch (_) {
        dev = null
      }
    }

    if (!dev) {
      if (!interactive) throw new Error('No previously authorized MeshCore device. Use Connect first.')
      dev = await globalThis.navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [MESHCORE_NUS_SERVICE_UUID],
      })
    }

    this.device = dev
    try {
      const id = dev?.id
      if (typeof id === 'string' && id) setLastBleDeviceId('meshcore', id)
    } catch (_) {
      // ignore
    }

    // bind disconnect listener
    try {
      if (this.boundDisconnected && this.device) this.device.removeEventListener('gattserverdisconnected', this.boundDisconnected)
    } catch (_) {
      // ignore
    }
    this.boundDisconnected = () => {
      this.connected = false
      this._emitDeviceStatus(2)
    }
    try {
      this.device.addEventListener('gattserverdisconnected', this.boundDisconnected)
    } catch (_) {
      // ignore
    }

    this._emitDeviceStatus(3)

    if (!dev?.gatt) throw new Error('Bluetooth device does not support GATT')

    const server = await dev.gatt.connect()
    const svc = await server.getPrimaryService(MESHCORE_NUS_SERVICE_UUID)
    this.rx = await svc.getCharacteristic(MESHCORE_NUS_RX_UUID)
    this.tx = await svc.getCharacteristic(MESHCORE_NUS_TX_UUID)

    this.boundNotify = (ev) => {
      try {
        const v = ev?.target?.value
        if (v) this._onNotifyValue(v)
      } catch (_) {
        // ignore
      }
    }

    this.tx.addEventListener('characteristicvaluechanged', this.boundNotify)
    await this.tx.startNotifications()

    this._emitDeviceStatus(5)

    await this._enqueue(async () => await this._initProtocol('XCOM'))
    return this.lastDeviceInfo
  }

  async disconnect() {
    this.connected = false

    try {
      if (this.tx && this.boundNotify) this.tx.removeEventListener('characteristicvaluechanged', this.boundNotify)
    } catch (_) {
      // ignore
    }
    this.boundNotify = null

    try {
      if (this.tx && typeof this.tx.stopNotifications === 'function') void this.tx.stopNotifications()
    } catch (_) {
      // ignore
    }

    const dev = this.device
    this.device = null
    this.rx = null
    this.tx = null

    try {
      if (dev && this.boundDisconnected) dev.removeEventListener('gattserverdisconnected', this.boundDisconnected)
    } catch (_) {
      // ignore
    }
    this.boundDisconnected = null

    try {
      if (dev?.gatt?.connected) dev.gatt.disconnect()
    } catch (_) {
      // ignore
    }

    this._emitLog('info', 'Disconnected')
    this._emitDeviceStatus(2)
  }

  async sendText(text, opts) {
    if (!this.connected) throw new Error('Not connected to a MeshCore device')

    const cfg = _meshConfigGet()
    const mc = { ...cfg.meshcore, ...(opts || {}) }

    const msgBytes = meshcoreEncodeUtf8(text ?? '')
    if (msgBytes.length > 160) throw new Error('MeshCore text too long (max 160 bytes)')

    const dest = mc.destination === 'direct' ? 'direct' : 'broadcast'
    const channel = Math.max(0, Math.min(255, Math.floor(Number(mc.channel) || 0)))
    const ts = (Math.floor(Date.now() / 1000) >>> 0)

    if (dest === 'direct') {
      const prefix6 = meshcoreParseHexPrefix6(mc.toNodeId)
      if (!prefix6) throw new Error('MeshCore direct send requires a 6-byte pubkey prefix (12 hex chars)')

      const payload = new Uint8Array(1 + 1 + 4 + 6 + msgBytes.length)
      let o = 0
      payload[o++] = 0 // txt_type (plain)
      payload[o++] = 0 // attempt
      payload.set(meshcoreU32le(ts), o)
      o += 4
      payload.set(prefix6, o)
      o += 6
      payload.set(msgBytes, o)

      await this._enqueue(async () => {
        await this._sendCommand(MESHCORE_CMD.SEND_TXT_MSG, payload)
        try { await this._nextOf([MESHCORE_CMD.OK], 1500) } catch (_) { /* ignore */ }
      })
      return
    }

    const payload = new Uint8Array(1 + 1 + 4 + 1 + 1 + msgBytes.length)
    let o = 0
    payload[o++] = 0 // txt_type (plain)
    payload[o++] = 0 // attempt
    payload.set(meshcoreU32le(ts), o)
    o += 4
    payload[o++] = channel & 0xff
    payload[o++] = 0 // channel_idx (reserved)
    payload.set(msgBytes, o)

    await this._enqueue(async () => {
      await this._sendCommand(MESHCORE_CMD.SEND_CHANNEL_TXT_MSG, payload)
      try { await this._nextOf([MESHCORE_CMD.OK], 1500) } catch (_) { /* ignore */ }
    })
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
    this.lastBleDeviceByDriver = { meshtastic: null, meshcore: null }
    this.reconnectTimer = null
    this.reconnectAttempt = 0

    this.nodeDb = meshReadNodeDb()
    this.channelDb = meshReadChannelDb()
    this.dmUnreadDb = meshReadDmUnreadDb()
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

  getDmUnreadDb() {
    const db = (this.dmUnreadDb && typeof this.dmUnreadDb === 'object') ? this.dmUnreadDb : {}
    // Return a defensive copy so consumers can't mutate our internal DB.
    const out = {}
    for (const [k, v] of Object.entries(db)) {
      const key = String(k || '').trim()
      if (!key) continue
      const meta = meshNormalizeDmUnreadMeta(v)
      if (!meta) continue
      out[key] = meta
    }
    return out
  }

  getDmUnreadMeta(peerKey) {
    const k = String(peerKey || '').trim()
    if (!k) return null
    const meta = meshNormalizeDmUnreadMeta(this.dmUnreadDb?.[k] ?? null)
    return meta ? { ...meta } : null
  }

  _markDmUnread(peerKey, ts) {
    const k = String(peerKey || '').trim()
    if (!k) return
    const t = meshAsFiniteNumber(ts) ?? Date.now()
    if (!t) return

    const db = (this.dmUnreadDb && typeof this.dmUnreadDb === 'object') ? this.dmUnreadDb : {}
    const prev = meshNormalizeDmUnreadMeta(db?.[k] ?? null) || null
    const next = {
      ts: Math.max(prev?.ts ?? 0, Math.floor(t)),
      count: Math.max(1, Math.min(999, (prev?.count ?? 0) + 1)),
    }

    db[k] = next
    this.dmUnreadDb = meshPruneDmUnreadDb(db, 250)
    meshWriteDmUnreadDb(this.dmUnreadDb)
  }

  markDmRead(peerKey) {
    const k = String(peerKey || '').trim()
    if (!k) return
    const db = (this.dmUnreadDb && typeof this.dmUnreadDb === 'object') ? this.dmUnreadDb : {}
    if (!db[k]) return
    delete db[k]
    this.dmUnreadDb = db
    meshWriteDmUnreadDb(db)
    this._notify()
  }

  clearDmUnread() {
    this.dmUnreadDb = {}
    meshWriteDmUnreadDb({})
    this._notify()
  }

  getNodeDb() { return this.nodeDb || {} }
  getNodes() { return meshNodeDbToArray(this.getNodeDb()) }
  clearNodes() { this.nodeDb = {}; meshWriteNodeDb({}); this._notify() }

  getChannelDb() { return this.channelDb || { meshtastic: [], meshcore: [] } }
  getChannels(driver) {
    const cfg = this.getConfig()
    const d = driver || ((cfg?.driver === 'meshcore') ? 'meshcore' : 'meshtastic')
    return meshChannelDbToArray(this.getChannelDb(), d)
  }
  clearChannels(driver) {
    const d = driver
      ? (driver === 'meshcore' ? 'meshcore' : 'meshtastic')
      : null

    if (!d) {
      this.channelDb = { meshtastic: [], meshcore: [] }
      meshWriteChannelDb(this.channelDb)
      this._notify()
      return
    }

    const db = this.getChannelDb()
    db[d] = []
    this.channelDb = db
    meshWriteChannelDb(db)
    this._notify()
  }

  _upsertChannel(driver, entry) {
    const db = this.getChannelDb()
    const next = meshUpsertChannel(db, driver, entry)
    this.channelDb = next
    meshWriteChannelDb(next)
  }

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
      channels: this.getChannels(),
    }
  }

  _appendLog(entry) {
    meshAppendTraffic(entry)

    // Auto-ingest incoming XTOC packet text so packets appear on the Map immediately
    // (even if Comms is not open).
    try {
      if (entry && entry.dir === 'in' && String(entry.kind || '') === 'message') {
        const text = typeof entry.text === 'string' ? entry.text : ''
        if (text && text.trim()) {
          const fn = globalThis.xcomAutoIngestXtocPacketText
          if (typeof fn === 'function') {
            void fn({ text, source: 'mesh', receivedAt: Number(entry.ts) || Date.now(), from: entry.from ?? null })
          }
        }
      }
    } catch (_) {
      // ignore
    }

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
    const driverName = cfg?.driver === 'meshcore' ? 'meshcore' : 'meshtastic'
    if (!cfg?.ui?.autoReconnect) return
    if (this.manualDisconnect) return
    if (this.reconnectTimer) return
    if (this.connectInFlight) return
    if (!this.lastBleDeviceByDriver?.[driverName] && !getLastBleDeviceId(driverName)) return

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

  async importChannels() {
    if (!this.driver) throw new Error('Mesh not connected')
    const cfg = this.getConfig()
    const driverName = (cfg?.driver === 'meshcore') ? 'meshcore' : 'meshtastic'

    if (driverName !== 'meshtastic') {
      throw new Error('Channel import is currently supported for Meshtastic only.')
    }
    if (typeof this.driver?.requestChannels !== 'function') {
      throw new Error('Active Meshtastic driver does not support channel import.')
    }

    const list = await this.driver.requestChannels({ timeoutMs: 6000 })
    for (const c of Array.isArray(list) ? list : []) {
      this._upsertChannel('meshtastic', c)
    }
    this._notify()
    return this.getChannels('meshtastic')
  }

  async _connectInternal(opts) {
    if (this.connectInFlight) return await this.connectInFlight

      const p = (async () => {
        const auto = !!opts?.auto
        const cfg = this.getConfig()
        const driverName = cfg.driver === 'meshcore' ? 'meshcore' : 'meshtastic'
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

        const d = driverName === 'meshcore' ? new MeshCoreDriver() : new MeshtasticDriver()
        d.onLog((e) => this._appendLog({ dir: 'sys', ...e }))
        d.onChannel((ch) => {
          try {
            if (driverName !== 'meshtastic') return
            const norm = meshNormalizeMeshtasticChannelPacket(ch)
            if (!norm) return
            this._upsertChannel('meshtastic', norm)
          } catch (_) {
            // ignore
          } finally {
            this._notify()
          }
        })
        d.onDeviceStatus((e) => {
          try {
            const dev = d.getBleDevice?.()
            if (dev) this.lastBleDeviceByDriver[driverName] = dev
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
          const patch = { lastSeenTs: Date.now(), driver: driverName }
          if (shortName) patch.shortName = shortName
          if (longName) patch.longName = longName
          if (ll) patch.position = { ...ll, alt: meshAsFiniteNumber(pos?.altitude ?? null) ?? undefined, ts: Date.now(), source: 'nodeinfo' }
          if (driverName === 'meshtastic' && num != null) {
            const id = meshFormatMeshtasticNodeId(num)
            if (id) patch.id = id
          } else if (driverName === 'meshcore') {
            const id = meshAsNonEmptyString(info?.prefixHex ?? info?.meshcore?.prefixHex ?? null)
            if (id) patch.id = id
          }
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
          const patch = { lastSeenTs: Date.now(), driver: driverName }
          if (shortName) patch.shortName = shortName
          if (longName) patch.longName = longName
          if (driverName === 'meshtastic' && from != null) {
            const id = meshFormatMeshtasticNodeId(from)
            if (id) patch.id = id
          }
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
          const patch = { lastSeenTs: Date.now(), driver: driverName, position: { ...ll, alt: alt ?? undefined, ts: Date.now(), source: 'position' } }
          if (driverName === 'meshtastic') {
            const id = meshFormatMeshtasticNodeId(from)
            if (id) patch.id = id
          } else if (driverName === 'meshcore') {
            const id = meshAsNonEmptyString(m?.prefixHex ?? m?.meshcore?.prefixHex ?? null)
            if (id) patch.id = id
          }
          this._upsertNode(from, patch)
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
          const patch = { lastSeenTs: Date.now(), driver: driverName }
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
          if (driverName === 'meshtastic') {
            const id = meshFormatMeshtasticNodeId(from)
            if (id) patch.id = id
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
        let msgType = null
        let fromKey = null
        let toKey = null
        try {
          const ts = Date.now()
          if (e?.kind === 'message') {
            const from = meshAsFiniteNumber(e?.msg?.from ?? null)
            if (from != null) {
              const patch = { lastSeenTs: ts, driver: driverName }
              if (driverName === 'meshtastic') {
                const id = meshFormatMeshtasticNodeId(from)
                if (id) {
                  patch.id = id
                  fromKey = `meshtastic:${id}`
                }
                const t = String(e?.msg?.type ?? '').trim()
                msgType = (t === 'direct' || t === 'broadcast') ? t : null
                if (msgType === 'direct') {
                  const to = meshAsFiniteNumber(e?.msg?.to ?? null)
                  const toId = to != null ? meshFormatMeshtasticNodeId(to) : null
                  if (toId) toKey = `meshtastic:${toId}`
                }
              } else if (driverName === 'meshcore') {
                const raw = meshAsNonEmptyString(e?.msg?.meshcore?.prefixHex ?? null)
                const id = raw ? (meshNormalizeMeshcorePrefixHex(raw) || raw) : null
                if (id) {
                  patch.id = id
                  fromKey = `meshcore:${id}`
                }
                msgType = 'direct'
              }
              this._upsertNode(from, patch)
            }
          } else if (e?.kind === 'packet') {
            const pkt = e?.pkt
            const from = meshAsFiniteNumber(pkt?.from ?? null)
            if (from != null) {
              const rxSnr = meshAsFiniteNumber(pkt?.rxSnr ?? pkt?.rx_snr ?? null)
              const rxRssi = meshAsFiniteNumber(pkt?.rxRssi ?? pkt?.rx_rssi ?? null)
              const hopStart = meshAsFiniteNumber(pkt?.hopStart ?? pkt?.hop_start ?? null)
              const hopLimit = meshAsFiniteNumber(pkt?.hopLimit ?? pkt?.hop_limit ?? null)
              const portnum = pkt?.decoded?.portnum ?? pkt?.decoded?.portNum ?? null
              const patch = {
                lastSeenTs: ts,
                driver: driverName,
                lastSnr: rxSnr ?? undefined,
                lastRssi: rxRssi ?? undefined,
                lastHopStart: hopStart ?? undefined,
                lastHopLimit: hopLimit ?? undefined,
                lastPort: portnum != null ? String(portnum) : undefined,
              }
              if (driverName === 'meshtastic') {
                const id = meshFormatMeshtasticNodeId(from)
                if (id) patch.id = id

                // Meshtastic TAK Tracker mode uses ATAK_PLUGIN payloads instead of POSITION_APP.
                // Decode PLI so node locations still show up on the map.
                if (meshIsAtakPluginPort(portnum)) {
                  const tak = meshAtakDecodeTakPacket(pkt?.decoded?.payload ?? null)
                  if (tak?.callsign && !patch.shortName) patch.shortName = tak.callsign
                  if (tak?.deviceCallsign && !patch.longName) patch.longName = tak.deviceCallsign
                  if (tak?.pli && Number.isFinite(Number(tak.pli.lat)) && Number.isFinite(Number(tak.pli.lon))) {
                    const alt = Number.isFinite(Number(tak.pli.alt)) ? Number(tak.pli.alt) : null
                    patch.position = {
                      lat: Number(tak.pli.lat),
                      lon: Number(tak.pli.lon),
                      ...(alt != null ? { alt } : {}),
                      ts,
                      source: 'atak-pli',
                    }
                  }
                }
              }
              this._upsertNode(from, patch)
            }
          }
        } catch (_) {
          // ignore
        }

        // Mark unread DMs before notifying the UI via log append.
        try {
          if (e?.kind === 'message' && msgType === 'direct' && fromKey) {
            this._markDmUnread(fromKey, e.ts)
          }
        } catch (_) {
          // ignore
        }

        this._appendLog({
          dir: 'in',
          ts: e.ts,
          kind: e.kind,
          driver: driverName,
          ...(msgType ? { msgType } : {}),
          ...(fromKey ? { fromKey } : {}),
          ...(toKey ? { toKey } : {}),
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
          driver: driverName,
          connection: connKind,
          deviceStatus: 3,
          deviceStatusLabel: meshDeviceStatusLabel(3),
          lastDeviceInfo: auto ? (this.status.lastDeviceInfo || null) : null,
          reconnecting: auto,
          reconnectAttempt: auto ? this.reconnectAttempt : 0,
          nextReconnectAt: null,
          lastError: null,
        })

        const info = await d.connectBle({ device: this.lastBleDeviceByDriver[driverName], interactive: !auto })
        try {
          const dev = d.getBleDevice?.()
          if (dev) this.lastBleDeviceByDriver[driverName] = dev
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

    const ts = Date.now()

    // Best-effort metadata for UI threading.
    let meta = null
    try {
      const cfg = this.getConfig()
      const driverName = cfg?.driver === 'meshcore' ? 'meshcore' : 'meshtastic'
      if (driverName === 'meshcore') {
        const mc = { ...(cfg?.meshcore || {}), ...(opts || {}) }
        const destination = mc.destination === 'direct' ? 'direct' : 'broadcast'
        const channel = Math.max(0, Math.min(255, Math.floor(Number(mc.channel) || 0)))
        const toNodeId = meshAsNonEmptyString(mc.toNodeId ?? null) || undefined
        const toNorm = (destination === 'direct' && toNodeId) ? (meshNormalizeMeshcorePrefixHex(toNodeId) || null) : null
        const toKey = (destination === 'direct' && toNodeId && toNorm) ? `meshcore:${toNorm}` : undefined
        meta = { driver: driverName, destination, channel, ...(destination === 'direct' && toNodeId ? { toNodeId } : {}), ...(toKey ? { toKey } : {}) }
      } else {
        const mt = { ...(cfg?.meshtastic || {}), ...(opts || {}) }
        const destination = mt.destination === 'direct' ? 'direct' : 'broadcast'
        const channel = Math.max(0, Math.min(7, Math.floor(Number(mt.channel) || 0)))
        const toNodeId = meshAsNonEmptyString(mt.toNodeId ?? null) || undefined
        const toNorm = (destination === 'direct' && toNodeId) ? (meshNormalizeMeshtasticNodeId(toNodeId) || null) : null
        const toKey = (destination === 'direct' && toNodeId && toNorm) ? `meshtastic:${toNorm}` : undefined
        meta = { driver: driverName, destination, channel, ...(destination === 'direct' && toNodeId ? { toNodeId } : {}), ...(toKey ? { toKey } : {}) }
      }
    } catch (_) {
      meta = null
    }

    const updateOut = (patch) => {
      try {
        const log = _meshTrafficGet()
        for (let i = log.length - 1; i >= 0; i--) {
          const e = log[i]
          if (e?.dir === 'out' && e?.ts === ts && String(e?.kind || '') === 'text') {
            Object.assign(e, patch || {})
            meshWriteJson(LS_MESH_LOG, log)
            break
          }
        }
      } catch (_) {
        // ignore
      }
    }

    this._appendLog({ dir: 'out', ts, kind: 'text', text: msg, opts: opts || null, status: 'pending', ...(meta || {}) })

    try {
      const res = await this.driver.sendText(msg, opts)
      const id = (typeof res === 'number') ? res : null
      updateOut({ ...(id != null ? { id } : {}), status: 'ok', doneAt: Date.now() })
      this._notify()
      return res
    } catch (e) {
      updateOut({ status: 'error', error: formatError(e), doneAt: Date.now() })
      this._notify()
      throw e
    }
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
  globalThis.meshGetChannels = () => xcomMesh.getChannels()
  globalThis.meshClearChannels = (d) => xcomMesh.clearChannels(d)
  globalThis.meshImportChannels = () => xcomMesh.importChannels()
  globalThis.meshGetCoverageSamples = () => meshReadCoverage()
  globalThis.meshAppendCoverageSample = (s) => meshAppendCoverage(s, xcomMesh.getConfig()?.ui?.maxCoverageEntries || 2000)
  globalThis.meshClearCoverageSamples = () => meshClearCoverage()
} catch (_) {
  // ignore
}
