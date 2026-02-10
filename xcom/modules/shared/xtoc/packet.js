// XTOC packet helpers (CLEAR + SECURE wrappers) + template enc/dec.
// Ported from xtoc-web/src/core/packet.ts (TypeScript) into plain JS.
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

// -----------------------------
// Wrapper parsing/building
// -----------------------------

function parsePacket(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed.startsWith('X1.')) return null
  const parts = trimmed.split('.')
  // CLEAR:  X1.<T>.C.<ID>.<P>/<N>.<PAYLOAD>
  // SECURE: X1.<T>.S.<ID>.<P>/<N>.<KID>.<PAYLOAD>
  if (parts.length < 6) return null
  const version = parts[0]
  if (version !== 'X1') return null

  const templateId = Number(parts[1])
  const mode = parts[2]
  const id = parts[3]
  const pn = parts[4]
  const [pStr, nStr] = pn.split('/')
  const part = Number(pStr)
  const total = Number(nStr)

  if (!Number.isFinite(templateId) || !Number.isFinite(part) || !Number.isFinite(total)) return null
  if (mode !== 'C' && mode !== 'S') return null

  if (mode === 'C') {
    const payload = parts.slice(5).join('.')
    if (!payload) return null
    return { version: 'X1', templateId, mode, id, part, total, payload, raw: trimmed }
  }

  if (parts.length < 7) return null
  const kid = Number(parts[5])
  if (!Number.isFinite(kid)) return null
  const payload = parts.slice(6).join('.')
  if (!payload) return null
  return { version: 'X1', templateId, mode, id, part, total, kid, payload, raw: trimmed }
}

function wrapSecure(templateId, id, part, total, kid, payloadB64Url) {
  return `X1.${templateId}.S.${id}.${part}/${total}.${kid}.${payloadB64Url}`
}

function generatePacketId(len = 8) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

// -----------------------------
// Template 4: CHECKIN/LOC (CLEAR)
// -----------------------------

const CHECKIN_LOC_VERSION = 1
const CHECKIN_LOC_LEN = 16

function encodeCheckinLocClear(payload) {
  const buf = new Uint8Array(CHECKIN_LOC_LEN)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CHECKIN_LOC_VERSION)
  dv.setUint16(1, payload.unitId, false)
  dv.setInt32(3, Math.round(payload.lat * 1e5), false)
  dv.setInt32(7, Math.round(payload.lon * 1e5), false)
  dv.setUint32(11, Math.floor(payload.t / 60000), false)
  dv.setUint8(15, payload.status)
  return encodeBase64Url(buf)
}

function decodeCheckinLocClear(payloadB64Url) {
  const bytes = decodeBase64Url(payloadB64Url)
  if (bytes.length < CHECKIN_LOC_LEN) throw new Error('CHECKIN payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ver = dv.getUint8(0)
  if (ver !== CHECKIN_LOC_VERSION) throw new Error(`Unsupported CHECKIN version ${ver}`)
  const unitId = dv.getUint16(1, false)
  const lat = dv.getInt32(3, false) / 1e5
  const lon = dv.getInt32(7, false) / 1e5
  const unixMinutes = dv.getUint32(11, false)
  const status = dv.getUint8(15)
  return { unitId, lat, lon, status, t: unixMinutes * 60000 }
}

function makeCheckinLocClearPacket(payload) {
  const id = generatePacketId(8)
  const encoded = encodeCheckinLocClear(payload)
  return `X1.4.C.${id}.1/1.${encoded}`
}

// -----------------------------
// Template 1: SITREP (CLEAR)
// -----------------------------

const SITREP_VERSION = 1

function encodeSitrepClear(payload) {
  const enc = new TextEncoder()
  const noteBytes = payload.note && String(payload.note).trim() ? enc.encode(String(payload.note).trim()) : undefined
  const hasLoc = Number.isFinite(payload.lat) && Number.isFinite(payload.lon)
  const hasNote = !!noteBytes && noteBytes.length > 0

  const baseLen = 12
  const locLen = hasLoc ? 8 : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const buf = new Uint8Array(baseLen + locLen + noteLen)
  const dv = new DataView(buf.buffer)

  dv.setUint8(0, SITREP_VERSION)
  dv.setUint16(1, payload.src, false)
  dv.setUint16(3, payload.dst, false)
  dv.setUint8(5, payload.pri)
  dv.setUint8(6, payload.status)
  dv.setUint32(7, Math.floor(payload.t / 60000), false)

  let flags = 0
  if (hasLoc) flags |= 1
  if (hasNote) flags |= 2
  dv.setUint8(11, flags)

  let o = 12
  if (hasLoc) {
    dv.setInt32(o, Math.round(payload.lat * 1e5), false)
    o += 4
    dv.setInt32(o, Math.round(payload.lon * 1e5), false)
    o += 4
  }
  if (hasNote) {
    const n = Math.min(noteBytes.length, 120)
    dv.setUint8(o, n)
    o += 1
    buf.set(noteBytes.subarray(0, n), o)
    o += n
  }

  return encodeBase64Url(buf)
}

function decodeSitrepClear(payloadB64Url) {
  const bytes = decodeBase64Url(payloadB64Url)
  if (bytes.length < 12) throw new Error('SITREP payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const ver = dv.getUint8(0)
  if (ver !== SITREP_VERSION) throw new Error(`Unsupported SITREP version ${ver}`)

  const src = dv.getUint16(1, false)
  const dst = dv.getUint16(3, false)
  const pri = dv.getUint8(5)
  const status = dv.getUint8(6)
  const unixMinutes = dv.getUint32(7, false)
  const flags = dv.getUint8(11)
  const hasLoc = (flags & 1) !== 0
  const hasNote = (flags & 2) !== 0

  let o = 12
  let lat
  let lon
  if (hasLoc) {
    if (bytes.length < o + 8) throw new Error('SITREP location truncated')
    lat = dv.getInt32(o, false) / 1e5
    o += 4
    lon = dv.getInt32(o, false) / 1e5
    o += 4
  }

  let note
  if (hasNote) {
    if (bytes.length < o + 1) throw new Error('SITREP note truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('SITREP note truncated')
    const dec = new TextDecoder()
    note = dec.decode(bytes.subarray(o, o + n))
    o += n
  }

  return { src, dst, pri, status, t: unixMinutes * 60000, lat, lon, note }
}

function makeSitrepClearPacket(payload) {
  const id = generatePacketId(8)
  const encoded = encodeSitrepClear(payload)
  return `X1.1.C.${id}.1/1.${encoded}`
}

// -----------------------------
// Template 2: CONTACT (CLEAR)
// -----------------------------

const CONTACT_VERSION = 1

function encodeContactClear(p) {
  const enc = new TextEncoder()
  const noteBytes = p.note && String(p.note).trim() ? enc.encode(String(p.note).trim()) : undefined
  const hasLoc = Number.isFinite(p.lat) && Number.isFinite(p.lon)
  const hasNote = !!noteBytes && noteBytes.length > 0
  const baseLen = 13
  const locLen = hasLoc ? 8 : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const buf = new Uint8Array(baseLen + locLen + noteLen)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CONTACT_VERSION)
  dv.setUint16(1, p.src, false)
  dv.setUint8(3, p.pri)
  dv.setUint32(4, Math.floor(p.t / 60000), false)
  dv.setUint8(8, p.typeCode & 0xff)
  dv.setUint16(9, p.count & 0xffff, false)
  dv.setUint8(11, p.dir & 0xff)
  let flags = 0
  if (hasLoc) flags |= 1
  if (hasNote) flags |= 2
  dv.setUint8(12, flags)
  let o = 13
  if (hasLoc) {
    dv.setInt32(o, Math.round(p.lat * 1e5), false)
    o += 4
    dv.setInt32(o, Math.round(p.lon * 1e5), false)
    o += 4
  }
  if (hasNote) {
    const n = Math.min(noteBytes.length, 120)
    dv.setUint8(o, n)
    o += 1
    buf.set(noteBytes.subarray(0, n), o)
    o += n
  }
  return encodeBase64Url(buf)
}

function decodeContactClear(b64) {
  const bytes = decodeBase64Url(b64)
  if (bytes.length < 13) throw new Error('CONTACT payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ver = dv.getUint8(0)
  if (ver !== CONTACT_VERSION) throw new Error(`Unsupported CONTACT version ${ver}`)
  const src = dv.getUint16(1, false)
  const pri = dv.getUint8(3)
  const unixMinutes = dv.getUint32(4, false)
  const typeCode = dv.getUint8(8)
  const count = dv.getUint16(9, false)
  const dir = dv.getUint8(11)
  const flags = dv.getUint8(12)
  const hasLoc = (flags & 1) !== 0
  const hasNote = (flags & 2) !== 0
  let o = 13
  let lat
  let lon
  if (hasLoc) {
    lat = dv.getInt32(o, false) / 1e5
    o += 4
    lon = dv.getInt32(o, false) / 1e5
    o += 4
  }
  let note
  if (hasNote) {
    const n = dv.getUint8(o)
    o += 1
    const dec = new TextDecoder()
    note = dec.decode(bytes.subarray(o, o + n))
    o += n
  }
  return { src, pri, t: unixMinutes * 60000, typeCode, count, dir, lat, lon, note }
}

function makeContactClearPacket(p) {
  const id = generatePacketId(8)
  const encoded = encodeContactClear(p)
  return `X1.2.C.${id}.1/1.${encoded}`
}

// -----------------------------
// Template 3: TASK (CLEAR)
// -----------------------------

const TASK_VERSION = 1

function encodeTaskClear(p) {
  const enc = new TextEncoder()
  const noteBytes = p.note && String(p.note).trim() ? enc.encode(String(p.note).trim()) : undefined
  const hasLoc = Number.isFinite(p.lat) && Number.isFinite(p.lon)
  const hasNote = !!noteBytes && noteBytes.length > 0
  const baseLen = 14
  const locLen = hasLoc ? 8 : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const buf = new Uint8Array(baseLen + locLen + noteLen)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, TASK_VERSION)
  dv.setUint16(1, p.src, false)
  dv.setUint16(3, p.dst, false)
  dv.setUint8(5, p.pri)
  dv.setUint32(6, Math.floor(p.t / 60000), false)
  dv.setUint8(10, p.actionCode & 0xff)
  dv.setUint16(11, p.dueMins & 0xffff, false)
  let flags = 0
  if (hasLoc) flags |= 1
  if (hasNote) flags |= 2
  dv.setUint8(13, flags)
  let o = 14
  if (hasLoc) {
    dv.setInt32(o, Math.round(p.lat * 1e5), false)
    o += 4
    dv.setInt32(o, Math.round(p.lon * 1e5), false)
    o += 4
  }
  if (hasNote) {
    const n = Math.min(noteBytes.length, 120)
    dv.setUint8(o, n)
    o += 1
    buf.set(noteBytes.subarray(0, n), o)
    o += n
  }
  return encodeBase64Url(buf)
}

function decodeTaskClear(b64) {
  const bytes = decodeBase64Url(b64)
  if (bytes.length < 14) throw new Error('TASK payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ver = dv.getUint8(0)
  if (ver !== TASK_VERSION) throw new Error(`Unsupported TASK version ${ver}`)
  const src = dv.getUint16(1, false)
  const dst = dv.getUint16(3, false)
  const pri = dv.getUint8(5)
  const unixMinutes = dv.getUint32(6, false)
  const actionCode = dv.getUint8(10)
  const dueMins = dv.getUint16(11, false)
  const flags = dv.getUint8(13)
  const hasLoc = (flags & 1) !== 0
  const hasNote = (flags & 2) !== 0
  let o = 14
  let lat
  let lon
  if (hasLoc) {
    lat = dv.getInt32(o, false) / 1e5
    o += 4
    lon = dv.getInt32(o, false) / 1e5
    o += 4
  }
  let note
  if (hasNote) {
    const n = dv.getUint8(o)
    o += 1
    const dec = new TextDecoder()
    note = dec.decode(bytes.subarray(o, o + n))
    o += n
  }
  return { src, dst, pri, t: unixMinutes * 60000, actionCode, dueMins, lat, lon, note }
}

function makeTaskClearPacket(p) {
  const id = generatePacketId(8)
  const encoded = encodeTaskClear(p)
  return `X1.3.C.${id}.1/1.${encoded}`
}

// -----------------------------
// Template 5: RESOURCE (CLEAR)
// -----------------------------

const RESOURCE_VERSION = 1

function encodeResourceClear(p) {
  const enc = new TextEncoder()
  const noteBytes = p.note && String(p.note).trim() ? enc.encode(String(p.note).trim()) : undefined
  const hasLoc = Number.isFinite(p.lat) && Number.isFinite(p.lon)
  const hasNote = !!noteBytes && noteBytes.length > 0
  const baseLen = 12
  const locLen = hasLoc ? 8 : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const buf = new Uint8Array(baseLen + locLen + noteLen)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, RESOURCE_VERSION)
  dv.setUint16(1, p.src, false)
  dv.setUint8(3, p.pri)
  dv.setUint32(4, Math.floor(p.t / 60000), false)
  dv.setUint8(8, p.itemCode & 0xff)
  dv.setUint16(9, p.qty & 0xffff, false)
  let flags = 0
  if (hasLoc) flags |= 1
  if (hasNote) flags |= 2
  dv.setUint8(11, flags)
  let o = 12
  if (hasLoc) {
    dv.setInt32(o, Math.round(p.lat * 1e5), false)
    o += 4
    dv.setInt32(o, Math.round(p.lon * 1e5), false)
    o += 4
  }
  if (hasNote) {
    const n = Math.min(noteBytes.length, 120)
    dv.setUint8(o, n)
    o += 1
    buf.set(noteBytes.subarray(0, n), o)
    o += n
  }
  return encodeBase64Url(buf)
}

function decodeResourceClear(b64) {
  const bytes = decodeBase64Url(b64)
  if (bytes.length < 12) throw new Error('RESOURCE payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ver = dv.getUint8(0)
  if (ver !== RESOURCE_VERSION) throw new Error(`Unsupported RESOURCE version ${ver}`)
  const src = dv.getUint16(1, false)
  const pri = dv.getUint8(3)
  const unixMinutes = dv.getUint32(4, false)
  const itemCode = dv.getUint8(8)
  const qty = dv.getUint16(9, false)
  const flags = dv.getUint8(11)
  const hasLoc = (flags & 1) !== 0
  const hasNote = (flags & 2) !== 0
  let o = 12
  let lat
  let lon
  if (hasLoc) {
    lat = dv.getInt32(o, false) / 1e5
    o += 4
    lon = dv.getInt32(o, false) / 1e5
    o += 4
  }
  let note
  if (hasNote) {
    const n = dv.getUint8(o)
    o += 1
    const dec = new TextDecoder()
    note = dec.decode(bytes.subarray(o, o + n))
    o += n
  }
  return { src, pri, t: unixMinutes * 60000, itemCode, qty, lat, lon, note }
}

function makeResourceClearPacket(p) {
  const id = generatePacketId(8)
  const encoded = encodeResourceClear(p)
  return `X1.5.C.${id}.1/1.${encoded}`
}

// -----------------------------
// Template 6: ASSET (CLEAR)
// -----------------------------

const ASSET_VERSION = 1

function encodeAssetClear(p) {
  const enc = new TextEncoder()
  const labelBytes = p.label && String(p.label).trim() ? enc.encode(String(p.label).trim()) : undefined
  const noteBytes = p.note && String(p.note).trim() ? enc.encode(String(p.note).trim()) : undefined
  const hasLoc = Number.isFinite(p.lat) && Number.isFinite(p.lon)
  const hasLabel = !!labelBytes && labelBytes.length > 0
  const hasNote = !!noteBytes && noteBytes.length > 0

  const baseLen = 10
  const locLen = hasLoc ? 8 : 0
  const labelLen = hasLabel ? 1 + Math.min(labelBytes.length, 48) : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const buf = new Uint8Array(baseLen + locLen + labelLen + noteLen)
  const dv = new DataView(buf.buffer)

  dv.setUint8(0, ASSET_VERSION)
  dv.setUint16(1, p.src, false)
  dv.setUint8(3, p.condition)
  dv.setUint32(4, Math.floor(p.t / 60000), false)
  dv.setUint8(8, p.typeCode & 0xff)

  let flags = 0
  if (hasLoc) flags |= 1
  if (hasLabel) flags |= 2
  if (hasNote) flags |= 4
  dv.setUint8(9, flags)

  let o = 10
  if (hasLoc) {
    dv.setInt32(o, Math.round(p.lat * 1e5), false)
    o += 4
    dv.setInt32(o, Math.round(p.lon * 1e5), false)
    o += 4
  }
  if (hasLabel) {
    const n = Math.min(labelBytes.length, 48)
    dv.setUint8(o, n)
    o += 1
    buf.set(labelBytes.subarray(0, n), o)
    o += n
  }
  if (hasNote) {
    const n = Math.min(noteBytes.length, 120)
    dv.setUint8(o, n)
    o += 1
    buf.set(noteBytes.subarray(0, n), o)
    o += n
  }
  return encodeBase64Url(buf)
}

function decodeAssetClear(b64) {
  const bytes = decodeBase64Url(b64)
  if (bytes.length < 10) throw new Error('ASSET payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ver = dv.getUint8(0)
  if (ver !== ASSET_VERSION) throw new Error(`Unsupported ASSET version ${ver}`)
  const src = dv.getUint16(1, false)
  const condition = dv.getUint8(3)
  const unixMinutes = dv.getUint32(4, false)
  const typeCode = dv.getUint8(8)
  const flags = dv.getUint8(9)
  const hasLoc = (flags & 1) !== 0
  const hasLabel = (flags & 2) !== 0
  const hasNote = (flags & 4) !== 0

  let o = 10
  let lat
  let lon
  if (hasLoc) {
    if (bytes.length < o + 8) throw new Error('ASSET location truncated')
    lat = dv.getInt32(o, false) / 1e5
    o += 4
    lon = dv.getInt32(o, false) / 1e5
    o += 4
  }
  const dec = new TextDecoder()
  let label
  if (hasLabel) {
    if (bytes.length < o + 1) throw new Error('ASSET label truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('ASSET label truncated')
    label = dec.decode(bytes.subarray(o, o + n))
    o += n
  }
  let note
  if (hasNote) {
    if (bytes.length < o + 1) throw new Error('ASSET note truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('ASSET note truncated')
    note = dec.decode(bytes.subarray(o, o + n))
    o += n
  }
  return { src, condition, t: unixMinutes * 60000, typeCode, lat, lon, label, note }
}

function makeAssetClearPacket(p) {
  const id = generatePacketId(8)
  const encoded = encodeAssetClear(p)
  return `X1.6.C.${id}.1/1.${encoded}`
}

// -----------------------------
// Template 7: ZONE (CLEAR)
// -----------------------------

const ZONE_VERSION = 1
const ZONE_MAX_POINTS = 32

function encodeZoneClear(p) {
  const enc = new TextEncoder()
  const labelBytes = p.label && String(p.label).trim() ? enc.encode(String(p.label).trim()) : undefined
  const noteBytes = p.note && String(p.note).trim() ? enc.encode(String(p.note).trim()) : undefined
  const hasLabel = !!labelBytes && labelBytes.length > 0
  const hasNote = !!noteBytes && noteBytes.length > 0

  const shapeIsCircle = p.shape && p.shape.kind === 'circle'
  const labelLen = hasLabel ? 1 + Math.min(labelBytes.length, 48) : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0

  let shapeLen = 0
  if (shapeIsCircle) {
    shapeLen = 4 + 4 + 2
  } else {
    const pts = (p.shape && p.shape.points) ? p.shape.points : []
    const n = Math.min(Math.max(pts.length, 0), ZONE_MAX_POINTS)
    shapeLen = 1 + n * 8
  }

  const baseLen = 10
  const buf = new Uint8Array(baseLen + labelLen + noteLen + shapeLen)
  const dv = new DataView(buf.buffer)

  dv.setUint8(0, ZONE_VERSION)
  dv.setUint16(1, p.src, false)
  dv.setUint8(3, p.threat)
  dv.setUint8(4, p.meaningCode & 0xff)
  dv.setUint32(5, Math.floor(p.t / 60000), false)

  let flags = 0
  if (hasLabel) flags |= 1
  if (hasNote) flags |= 2
  if (shapeIsCircle) flags |= 4
  dv.setUint8(9, flags)

  let o = 10
  if (hasLabel) {
    const n = Math.min(labelBytes.length, 48)
    dv.setUint8(o, n)
    o += 1
    buf.set(labelBytes.subarray(0, n), o)
    o += n
  }
  if (hasNote) {
    const n = Math.min(noteBytes.length, 120)
    dv.setUint8(o, n)
    o += 1
    buf.set(noteBytes.subarray(0, n), o)
    o += n
  }

  if (shapeIsCircle) {
    const c = p.shape
    dv.setInt32(o, Math.round(c.centerLat * 1e5), false)
    o += 4
    dv.setInt32(o, Math.round(c.centerLon * 1e5), false)
    o += 4
    const r = Math.max(0, Math.min(65535, Math.floor(c.radiusM)))
    dv.setUint16(o, r, false)
    o += 2
  } else {
    const pts = (p.shape && p.shape.points) ? p.shape.points : []
    const n = Math.min(Math.max(pts.length, 0), ZONE_MAX_POINTS)
    dv.setUint8(o, n)
    o += 1
    for (let i = 0; i < n; i++) {
      const pt = pts[i]
      dv.setInt32(o, Math.round(pt.lat * 1e5), false)
      o += 4
      dv.setInt32(o, Math.round(pt.lon * 1e5), false)
      o += 4
    }
  }

  return encodeBase64Url(buf)
}

function decodeZoneClear(b64) {
  const bytes = decodeBase64Url(b64)
  if (bytes.length < 10) throw new Error('ZONE payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ver = dv.getUint8(0)
  if (ver !== ZONE_VERSION) throw new Error(`Unsupported ZONE version ${ver}`)

  const src = dv.getUint16(1, false)
  const threat = dv.getUint8(3)
  const meaningCode = dv.getUint8(4)
  const unixMinutes = dv.getUint32(5, false)
  const flags = dv.getUint8(9)
  const hasLabel = (flags & 1) !== 0
  const hasNote = (flags & 2) !== 0
  const shapeIsCircle = (flags & 4) !== 0

  let o = 10
  const dec = new TextDecoder()
  let label
  if (hasLabel) {
    if (bytes.length < o + 1) throw new Error('ZONE label truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('ZONE label truncated')
    label = dec.decode(bytes.subarray(o, o + n))
    o += n
  }
  let note
  if (hasNote) {
    if (bytes.length < o + 1) throw new Error('ZONE note truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('ZONE note truncated')
    note = dec.decode(bytes.subarray(o, o + n))
    o += n
  }

  let shape
  if (shapeIsCircle) {
    if (bytes.length < o + 10) throw new Error('ZONE circle truncated')
    const centerLat = dv.getInt32(o, false) / 1e5
    o += 4
    const centerLon = dv.getInt32(o, false) / 1e5
    o += 4
    const radiusM = dv.getUint16(o, false)
    o += 2
    shape = { kind: 'circle', centerLat, centerLon, radiusM }
  } else {
    if (bytes.length < o + 1) throw new Error('ZONE polygon truncated')
    const n = dv.getUint8(o)
    o += 1
    if (n < 3) throw new Error('ZONE polygon must have >= 3 points')
    if (n > ZONE_MAX_POINTS) throw new Error(`ZONE polygon too many points (${n})`)
    if (bytes.length < o + n * 8) throw new Error('ZONE polygon truncated')
    const points = []
    for (let i = 0; i < n; i++) {
      const lat = dv.getInt32(o, false) / 1e5
      o += 4
      const lon = dv.getInt32(o, false) / 1e5
      o += 4
      points.push({ lat, lon })
    }
    shape = { kind: 'poly', points }
  }

  return { src, t: unixMinutes * 60000, threat, meaningCode, label, note, shape }
}

function makeZoneClearPacket(p) {
  const id = generatePacketId(8)
  const encoded = encodeZoneClear(p)
  return `X1.7.C.${id}.1/1.${encoded}`
}

// -----------------------------
// Template 8: MISSION (CLEAR)
// -----------------------------

const MISSION_VERSION = 1
const MISSION_MAX_ID_BYTES = 32
const MISSION_MAX_TITLE_BYTES = 96
const MISSION_MAX_LOC_LABEL_BYTES = 48
const MISSION_MAX_NOTES_BYTES = 600
const MISSION_MAX_ASSIGNEES = 32

const MISSION_FLAG_HAS_ASSIGNEES = 32

const MISSION_STATUS = ['PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETE', 'ABORTED']

function missionStatusToCode(status) {
  const idx = MISSION_STATUS.indexOf(status)
  return idx >= 0 ? idx : 0
}

function missionCodeToStatus(code) {
  return MISSION_STATUS[code] || 'PLANNED'
}

function encodeMissionClear(m) {
  const enc = new TextEncoder()

  const idBytesAll = enc.encode(String(m && m.id != null ? m.id : ''))
  const titleBytesAll = enc.encode(String(m && m.title != null ? m.title : '').trim())
  const idBytes = idBytesAll.subarray(0, Math.min(idBytesAll.length, MISSION_MAX_ID_BYTES))
  const titleBytes = titleBytesAll.subarray(0, Math.min(titleBytesAll.length, MISSION_MAX_TITLE_BYTES))

  const locLabelBytesAll = m && m.locationLabel && String(m.locationLabel).trim() ? enc.encode(String(m.locationLabel).trim()) : undefined
  const locLabelBytes = locLabelBytesAll
    ? locLabelBytesAll.subarray(0, Math.min(locLabelBytesAll.length, MISSION_MAX_LOC_LABEL_BYTES))
    : undefined

  const notesBytesAll = m && m.notes && String(m.notes).trim() ? enc.encode(String(m.notes).trim()) : undefined
  const notesBytes = notesBytesAll ? notesBytesAll.subarray(0, Math.min(notesBytesAll.length, MISSION_MAX_NOTES_BYTES)) : undefined

  const normalizeUnitIdList = (ids) => {
    if (!Array.isArray(ids)) return []
    const out = []
    const seen = new Set()
    for (const v of ids) {
      const n = Math.floor(Number(v))
      if (!Number.isFinite(n) || n <= 0 || n > 65535) continue
      if (seen.has(n)) continue
      seen.add(n)
      out.push(n)
      if (out.length >= MISSION_MAX_ASSIGNEES) break
    }
    return out
  }

  const list = normalizeUnitIdList(m?.assignedToList)
  const assignedToFromSingle = Number.isFinite(m?.assignedTo) && Number(m.assignedTo || 0) > 0 ? Number(m.assignedTo) : undefined
  const assignedTo = (list[0] != null) ? list[0] : assignedToFromSingle
  const extraAssignees = list.length > 0 ? list.slice(1) : []

  const hasAssigned = Number.isFinite(assignedTo) && Number(assignedTo || 0) > 0
  const hasLoc = Number.isFinite(m?.lat) && Number.isFinite(m?.lon)
  const hasLocLabel = !!locLabelBytes && locLabelBytes.length > 0
  const hasDue = Number.isFinite(m?.dueAt) && Number(m.dueAt || 0) > 0
  const hasNotes = !!notesBytes && notesBytes.length > 0
  const hasAssignees = extraAssignees.length > 0

  const baseLen = 12
  const idLen = 1 + idBytes.length
  const titleLen = 1 + titleBytes.length
  const assignedLen = hasAssigned ? 2 : 0
  const locLen = hasLoc ? 8 : 0
  const locLabelLen = hasLocLabel ? 1 + locLabelBytes.length : 0
  const dueLen = hasDue ? 4 : 0
  const notesLen = hasNotes ? 2 + notesBytes.length : 0
  const assigneesLen = hasAssignees ? 1 + extraAssignees.length * 2 : 0

  const buf = new Uint8Array(baseLen + idLen + titleLen + assignedLen + locLen + locLabelLen + dueLen + notesLen + assigneesLen)
  const dv = new DataView(buf.buffer)

  dv.setUint8(0, MISSION_VERSION)
  dv.setUint32(1, Math.floor(Number(m?.updatedAt ?? Date.now()) / 60000), false)
  dv.setUint32(5, Math.floor(Number(m?.createdAt ?? Date.now()) / 60000), false)

  dv.setUint8(9, missionStatusToCode(String(m?.status || 'PLANNED')))
  dv.setUint8(10, Number(m?.pri || 0) & 3)

  let flags = 0
  if (hasAssigned) flags |= 1
  if (hasLoc) flags |= 2
  if (hasLocLabel) flags |= 4
  if (hasDue) flags |= 8
  if (hasNotes) flags |= 16
  if (hasAssignees) flags |= MISSION_FLAG_HAS_ASSIGNEES
  dv.setUint8(11, flags)

  let o = 12

  dv.setUint8(o, idBytes.length)
  o += 1
  buf.set(idBytes, o)
  o += idBytes.length

  dv.setUint8(o, titleBytes.length)
  o += 1
  buf.set(titleBytes, o)
  o += titleBytes.length

  if (hasAssigned) {
    dv.setUint16(o, Number(assignedTo), false)
    o += 2
  }

  if (hasLoc) {
    dv.setInt32(o, Math.round(Number(m.lat) * 1e5), false)
    o += 4
    dv.setInt32(o, Math.round(Number(m.lon) * 1e5), false)
    o += 4
  }

  if (hasLocLabel) {
    dv.setUint8(o, locLabelBytes.length)
    o += 1
    buf.set(locLabelBytes, o)
    o += locLabelBytes.length
  }

  if (hasDue) {
    dv.setUint32(o, Math.floor(Number(m.dueAt) / 60000), false)
    o += 4
  }

  if (hasNotes) {
    dv.setUint16(o, notesBytes.length, false)
    o += 2
    buf.set(notesBytes, o)
    o += notesBytes.length
  }

  if (hasAssignees) {
    dv.setUint8(o, extraAssignees.length)
    o += 1
    for (const unitId of extraAssignees) {
      dv.setUint16(o, unitId, false)
      o += 2
    }
  }

  return encodeBase64Url(buf)
}

function decodeMissionClear(b64) {
  const bytes = decodeBase64Url(b64)
  if (bytes.length < 12) throw new Error('MISSION payload too short')

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ver = dv.getUint8(0)
  if (ver !== MISSION_VERSION) throw new Error(`Unsupported MISSION version ${ver}`)

  const updatedUnixMinutes = dv.getUint32(1, false)
  const createdUnixMinutes = dv.getUint32(5, false)
  const statusCode = dv.getUint8(9)
  const pri = dv.getUint8(10) & 3
  const flags = dv.getUint8(11)

  const hasAssigned = (flags & 1) !== 0
  const hasLoc = (flags & 2) !== 0
  const hasLocLabel = (flags & 4) !== 0
  const hasDue = (flags & 8) !== 0
  const hasNotes = (flags & 16) !== 0
  const hasAssignees = (flags & MISSION_FLAG_HAS_ASSIGNEES) !== 0

  let o = 12
  const dec = new TextDecoder()

  if (bytes.length < o + 1) throw new Error('MISSION id truncated')
  const idLen = dv.getUint8(o)
  o += 1
  if (bytes.length < o + idLen) throw new Error('MISSION id truncated')
  const id = dec.decode(bytes.subarray(o, o + idLen))
  o += idLen

  if (bytes.length < o + 1) throw new Error('MISSION title truncated')
  const titleLen = dv.getUint8(o)
  o += 1
  if (bytes.length < o + titleLen) throw new Error('MISSION title truncated')
  const title = dec.decode(bytes.subarray(o, o + titleLen))
  o += titleLen

  let assignedTo
  if (hasAssigned) {
    if (bytes.length < o + 2) throw new Error('MISSION assignedTo truncated')
    const v = dv.getUint16(o, false)
    o += 2
    assignedTo = v > 0 ? v : undefined
  }

  let lat
  let lon
  if (hasLoc) {
    if (bytes.length < o + 8) throw new Error('MISSION location truncated')
    lat = dv.getInt32(o, false) / 1e5
    o += 4
    lon = dv.getInt32(o, false) / 1e5
    o += 4
  }

  let locationLabel
  if (hasLocLabel) {
    if (bytes.length < o + 1) throw new Error('MISSION location label truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('MISSION location label truncated')
    locationLabel = dec.decode(bytes.subarray(o, o + n))
    o += n
  }

  let dueAt
  if (hasDue) {
    if (bytes.length < o + 4) throw new Error('MISSION dueAt truncated')
    const dueUnixMinutes = dv.getUint32(o, false)
    o += 4
    dueAt = dueUnixMinutes * 60000
  }

  let notes
  if (hasNotes) {
    if (bytes.length < o + 2) throw new Error('MISSION notes truncated')
    const n = dv.getUint16(o, false)
    o += 2
    if (bytes.length < o + n) throw new Error('MISSION notes truncated')
    notes = dec.decode(bytes.subarray(o, o + n))
    o += n
  }

  let assignedToList
  if (hasAssignees) {
    if (bytes.length < o + 1) throw new Error('MISSION assignees truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n * 2) throw new Error('MISSION assignees truncated')

    const extras = []
    for (let i = 0; i < n; i++) {
      const v = dv.getUint16(o, false)
      o += 2
      if (v > 0) extras.push(v)
    }

    const out = []
    const seen = new Set()
    const add = (v) => {
      if (!v || v <= 0) return
      if (seen.has(v)) return
      seen.add(v)
      out.push(v)
    }
    add(assignedTo)
    for (const v of extras) add(v)

    if (!assignedTo && out.length) assignedTo = out[0]
    assignedToList = out.length ? out : undefined
  }

  return {
    id,
    createdAt: createdUnixMinutes * 60000,
    updatedAt: updatedUnixMinutes * 60000,
    title,
    status: missionCodeToStatus(statusCode),
    pri,
    assignedTo,
    ...(Array.isArray(assignedToList) && assignedToList.length > 1 ? { assignedToList } : {}),
    lat,
    lon,
    locationLabel,
    dueAt,
    notes,
  }
}

function makeMissionClearPacket(m) {
  const id = generatePacketId(8)
  const encoded = encodeMissionClear(m)
  return `X1.8.C.${id}.1/1.${encoded}`
}

// Make available to non-module scripts (XCOM loads via <script> not ESM).
try {
  globalThis.parsePacket = parsePacket
  globalThis.wrapSecure = wrapSecure
  globalThis.generatePacketId = generatePacketId

  globalThis.encodeCheckinLocClear = encodeCheckinLocClear
  globalThis.decodeCheckinLocClear = decodeCheckinLocClear
  globalThis.makeCheckinLocClearPacket = makeCheckinLocClearPacket

  globalThis.encodeSitrepClear = encodeSitrepClear
  globalThis.decodeSitrepClear = decodeSitrepClear
  globalThis.makeSitrepClearPacket = makeSitrepClearPacket

  globalThis.encodeContactClear = encodeContactClear
  globalThis.decodeContactClear = decodeContactClear
  globalThis.makeContactClearPacket = makeContactClearPacket

  globalThis.encodeTaskClear = encodeTaskClear
  globalThis.decodeTaskClear = decodeTaskClear
  globalThis.makeTaskClearPacket = makeTaskClearPacket

  globalThis.encodeResourceClear = encodeResourceClear
  globalThis.decodeResourceClear = decodeResourceClear
  globalThis.makeResourceClearPacket = makeResourceClearPacket

  globalThis.encodeAssetClear = encodeAssetClear
  globalThis.decodeAssetClear = decodeAssetClear
  globalThis.makeAssetClearPacket = makeAssetClearPacket

  globalThis.encodeZoneClear = encodeZoneClear
  globalThis.decodeZoneClear = decodeZoneClear
  globalThis.makeZoneClearPacket = makeZoneClearPacket

  globalThis.encodeMissionClear = encodeMissionClear
  globalThis.decodeMissionClear = decodeMissionClear
  globalThis.makeMissionClearPacket = makeMissionClearPacket
} catch (_) {
  // ignore
}
