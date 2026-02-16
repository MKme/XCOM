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

const TEMPLATE_MAX_UNIT_IDS = 32

function normalizeUnitIdList(ids, max = TEMPLATE_MAX_UNIT_IDS) {
  if (!Array.isArray(ids)) return []
  const out = []
  const seen = new Set()
  for (const v of ids) {
    const n = Math.floor(Number(v))
    if (!Number.isFinite(n) || n <= 0 || n > 65535) continue
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= max) break
  }
  return out
}

function extraUnitIdsBeyondPrimary(primary, ids, max = TEMPLATE_MAX_UNIT_IDS) {
  const list = normalizeUnitIdList(ids, max)
  if (!list.length) return []
  const out = []
  const seen = new Set()
  // Exclude primary from extras even if it appears in the list.
  seen.add(Math.floor(Number(primary)))
  for (const v of list) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= max - 1) break
  }
  return out
}

// -----------------------------
// Template 4: CHECKIN/LOC (CLEAR)
// -----------------------------

const CHECKIN_LOC_VERSION_V1 = 1
const CHECKIN_LOC_VERSION_V2 = 2
const CHECKIN_LOC_LEN_V1 = 16
const CHECKIN_LOC_MAX_UNITS = 32

function encodeCheckinLocClear(payload) {
  const rawIds = Array.isArray(payload?.unitIds) && payload.unitIds.length ? payload.unitIds : [payload.unitId]
  const unitIds = []
  const seen = new Set()
  for (const v of rawIds) {
    const n = Math.floor(Number(v))
    if (!Number.isFinite(n) || n <= 0 || n > 65535) continue
    if (seen.has(n)) continue
    seen.add(n)
    unitIds.push(n)
    if (unitIds.length >= CHECKIN_LOC_MAX_UNITS) break
  }

  if (unitIds.length <= 1) {
    const unitId = unitIds[0] != null ? unitIds[0] : Math.floor(Number(payload.unitId) || 0)
    if (!Number.isFinite(unitId) || unitId <= 0 || unitId > 65535) throw new Error('Invalid unitId')

    const buf = new Uint8Array(CHECKIN_LOC_LEN_V1)
    const dv = new DataView(buf.buffer)
    dv.setUint8(0, CHECKIN_LOC_VERSION_V1)
    dv.setUint16(1, unitId, false)
    dv.setInt32(3, Math.round(payload.lat * 1e5), false)
    dv.setInt32(7, Math.round(payload.lon * 1e5), false)
    dv.setUint32(11, Math.floor(payload.t / 60000), false)
    dv.setUint8(15, payload.status)
    return encodeBase64Url(buf)
  }

  const n = unitIds.length
  const headerLen = 2 + n * 2
  const fixedLen = 4 + 4 + 4 + 1
  const buf = new Uint8Array(headerLen + fixedLen)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, CHECKIN_LOC_VERSION_V2)
  dv.setUint8(1, n)
  let o = 2
  for (const id of unitIds) {
    dv.setUint16(o, id, false)
    o += 2
  }
  dv.setInt32(o, Math.round(payload.lat * 1e5), false)
  o += 4
  dv.setInt32(o, Math.round(payload.lon * 1e5), false)
  o += 4
  dv.setUint32(o, Math.floor(payload.t / 60000), false)
  o += 4
  dv.setUint8(o, payload.status)
  return encodeBase64Url(buf)
}

function decodeCheckinLocClear(payloadB64Url) {
  const bytes = decodeBase64Url(payloadB64Url)
  if (bytes.length < 1) throw new Error('CHECKIN payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ver = dv.getUint8(0)

  if (ver === CHECKIN_LOC_VERSION_V1) {
    if (bytes.length < CHECKIN_LOC_LEN_V1) throw new Error('CHECKIN payload too short')
    const unitId = dv.getUint16(1, false)
    const lat = dv.getInt32(3, false) / 1e5
    const lon = dv.getInt32(7, false) / 1e5
    const unixMinutes = dv.getUint32(11, false)
    const status = dv.getUint8(15)
    return { unitId, lat, lon, status, t: unixMinutes * 60000 }
  }

  if (ver === CHECKIN_LOC_VERSION_V2) {
    if (bytes.length < 2) throw new Error('CHECKIN payload too short')
    const unitCount = dv.getUint8(1)
    if (!unitCount) throw new Error('CHECKIN unit count missing')
    if (unitCount > CHECKIN_LOC_MAX_UNITS) throw new Error('CHECKIN unit count too large')

    const requiredLen = 15 + unitCount * 2
    if (bytes.length < requiredLen) throw new Error('CHECKIN payload truncated')

    let o = 2
    const rawIds = []
    for (let i = 0; i < unitCount; i++) {
      rawIds.push(dv.getUint16(o, false))
      o += 2
    }

    const lat = dv.getInt32(o, false) / 1e5
    o += 4
    const lon = dv.getInt32(o, false) / 1e5
    o += 4
    const unixMinutes = dv.getUint32(o, false)
    o += 4
    const status = dv.getUint8(o)

    const unitIds = []
    const seen = new Set()
    for (const id of rawIds) {
      if (!Number.isFinite(id) || id <= 0) continue
      if (seen.has(id)) continue
      seen.add(id)
      unitIds.push(id)
      if (unitIds.length >= CHECKIN_LOC_MAX_UNITS) break
    }
    if (!unitIds.length) throw new Error('CHECKIN unitIds missing')

    return { unitId: unitIds[0], unitIds, lat, lon, status, t: unixMinutes * 60000 }
  }

  throw new Error(`Unsupported CHECKIN version ${ver}`)
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
  const extraSrcIds = extraUnitIdsBeyondPrimary(payload.src, payload.srcIds)
  const hasSrcIds = extraSrcIds.length > 0

  const baseLen = 12
  const locLen = hasLoc ? 8 : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const srcIdsLen = hasSrcIds ? 1 + extraSrcIds.length * 2 : 0
  const buf = new Uint8Array(baseLen + locLen + noteLen + srcIdsLen)
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
  if (hasSrcIds) flags |= 4
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
  if (hasSrcIds) {
    dv.setUint8(o, extraSrcIds.length)
    o += 1
    for (const unitId of extraSrcIds) {
      dv.setUint16(o, unitId, false)
      o += 2
    }
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
  const hasSrcIds = (flags & 4) !== 0

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

  let srcIds
  if (hasSrcIds) {
    if (bytes.length < o + 1) throw new Error('SITREP srcIds truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n * 2) throw new Error('SITREP srcIds truncated')
    const extras = []
    for (let i = 0; i < n; i++) {
      extras.push(dv.getUint16(o, false))
      o += 2
    }
    const out = []
    const seen = new Set()
    const add = (v) => {
      const n = Math.floor(Number(v))
      if (!Number.isFinite(n) || n <= 0) return
      if (seen.has(n)) return
      seen.add(n)
      out.push(n)
    }
    add(src)
    for (const v of extras) add(v)
    if (out.length > 1) srcIds = out
  }

  return { src, ...(srcIds ? { srcIds } : {}), dst, pri, status, t: unixMinutes * 60000, lat, lon, note }
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
  const extraSrcIds = extraUnitIdsBeyondPrimary(p.src, p.srcIds)
  const hasSrcIds = extraSrcIds.length > 0
  const baseLen = 13
  const locLen = hasLoc ? 8 : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const srcIdsLen = hasSrcIds ? 1 + extraSrcIds.length * 2 : 0
  const buf = new Uint8Array(baseLen + locLen + noteLen + srcIdsLen)
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
  if (hasSrcIds) flags |= 4
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
  if (hasSrcIds) {
    dv.setUint8(o, extraSrcIds.length)
    o += 1
    for (const unitId of extraSrcIds) {
      dv.setUint16(o, unitId, false)
      o += 2
    }
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
  const hasSrcIds = (flags & 4) !== 0
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
  let srcIds
  if (hasSrcIds) {
    if (bytes.length < o + 1) throw new Error('CONTACT srcIds truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n * 2) throw new Error('CONTACT srcIds truncated')
    const extras = []
    for (let i = 0; i < n; i++) {
      extras.push(dv.getUint16(o, false))
      o += 2
    }
    const out = []
    const seen = new Set()
    const add = (v) => {
      const n = Math.floor(Number(v))
      if (!Number.isFinite(n) || n <= 0) return
      if (seen.has(n)) return
      seen.add(n)
      out.push(n)
    }
    add(src)
    for (const v of extras) add(v)
    if (out.length > 1) srcIds = out
  }

  return { src, ...(srcIds ? { srcIds } : {}), pri, t: unixMinutes * 60000, typeCode, count, dir, lat, lon, note }
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
  const extraSrcIds = extraUnitIdsBeyondPrimary(p.src, p.srcIds)
  const hasSrcIds = extraSrcIds.length > 0
  const baseLen = 14
  const locLen = hasLoc ? 8 : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const srcIdsLen = hasSrcIds ? 1 + extraSrcIds.length * 2 : 0
  const buf = new Uint8Array(baseLen + locLen + noteLen + srcIdsLen)
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
  if (hasSrcIds) flags |= 4
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
  if (hasSrcIds) {
    dv.setUint8(o, extraSrcIds.length)
    o += 1
    for (const unitId of extraSrcIds) {
      dv.setUint16(o, unitId, false)
      o += 2
    }
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
  const hasSrcIds = (flags & 4) !== 0
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
  let srcIds
  if (hasSrcIds) {
    if (bytes.length < o + 1) throw new Error('TASK srcIds truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n * 2) throw new Error('TASK srcIds truncated')
    const extras = []
    for (let i = 0; i < n; i++) {
      extras.push(dv.getUint16(o, false))
      o += 2
    }
    const out = []
    const seen = new Set()
    const add = (v) => {
      const n = Math.floor(Number(v))
      if (!Number.isFinite(n) || n <= 0) return
      if (seen.has(n)) return
      seen.add(n)
      out.push(n)
    }
    add(src)
    for (const v of extras) add(v)
    if (out.length > 1) srcIds = out
  }

  return { src, ...(srcIds ? { srcIds } : {}), dst, pri, t: unixMinutes * 60000, actionCode, dueMins, lat, lon, note }
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
  const extraSrcIds = extraUnitIdsBeyondPrimary(p.src, p.srcIds)
  const hasSrcIds = extraSrcIds.length > 0
  const baseLen = 12
  const locLen = hasLoc ? 8 : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const srcIdsLen = hasSrcIds ? 1 + extraSrcIds.length * 2 : 0
  const buf = new Uint8Array(baseLen + locLen + noteLen + srcIdsLen)
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
  if (hasSrcIds) flags |= 4
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
  if (hasSrcIds) {
    dv.setUint8(o, extraSrcIds.length)
    o += 1
    for (const unitId of extraSrcIds) {
      dv.setUint16(o, unitId, false)
      o += 2
    }
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
  const hasSrcIds = (flags & 4) !== 0
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
  let srcIds
  if (hasSrcIds) {
    if (bytes.length < o + 1) throw new Error('RESOURCE srcIds truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n * 2) throw new Error('RESOURCE srcIds truncated')
    const extras = []
    for (let i = 0; i < n; i++) {
      extras.push(dv.getUint16(o, false))
      o += 2
    }
    const out = []
    const seen = new Set()
    const add = (v) => {
      const n = Math.floor(Number(v))
      if (!Number.isFinite(n) || n <= 0) return
      if (seen.has(n)) return
      seen.add(n)
      out.push(n)
    }
    add(src)
    for (const v of extras) add(v)
    if (out.length > 1) srcIds = out
  }

  return { src, ...(srcIds ? { srcIds } : {}), pri, t: unixMinutes * 60000, itemCode, qty, lat, lon, note }
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
  const extraSrcIds = extraUnitIdsBeyondPrimary(p.src, p.srcIds)
  const hasSrcIds = extraSrcIds.length > 0

  const baseLen = 10
  const locLen = hasLoc ? 8 : 0
  const labelLen = hasLabel ? 1 + Math.min(labelBytes.length, 48) : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, 120) : 0
  const srcIdsLen = hasSrcIds ? 1 + extraSrcIds.length * 2 : 0
  const buf = new Uint8Array(baseLen + locLen + labelLen + noteLen + srcIdsLen)
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
  if (hasSrcIds) flags |= 8
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
  if (hasSrcIds) {
    dv.setUint8(o, extraSrcIds.length)
    o += 1
    for (const unitId of extraSrcIds) {
      dv.setUint16(o, unitId, false)
      o += 2
    }
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
  const hasSrcIds = (flags & 8) !== 0

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
  let srcIds
  if (hasSrcIds) {
    if (bytes.length < o + 1) throw new Error('ASSET srcIds truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n * 2) throw new Error('ASSET srcIds truncated')
    const extras = []
    for (let i = 0; i < n; i++) {
      extras.push(dv.getUint16(o, false))
      o += 2
    }
    const out = []
    const seen = new Set()
    const add = (v) => {
      const n = Math.floor(Number(v))
      if (!Number.isFinite(n) || n <= 0) return
      if (seen.has(n)) return
      seen.add(n)
      out.push(n)
    }
    add(src)
    for (const v of extras) add(v)
    if (out.length > 1) srcIds = out
  }

  return { src, ...(srcIds ? { srcIds } : {}), condition, t: unixMinutes * 60000, typeCode, lat, lon, label, note }
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
  const extraSrcIds = extraUnitIdsBeyondPrimary(p.src, p.srcIds)
  const hasSrcIds = extraSrcIds.length > 0

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
  const srcIdsLen = hasSrcIds ? 1 + extraSrcIds.length * 2 : 0
  const buf = new Uint8Array(baseLen + labelLen + noteLen + shapeLen + srcIdsLen)
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
  if (hasSrcIds) flags |= 8
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

  if (hasSrcIds) {
    dv.setUint8(o, extraSrcIds.length)
    o += 1
    for (const unitId of extraSrcIds) {
      dv.setUint16(o, unitId, false)
      o += 2
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
  const hasSrcIds = (flags & 8) !== 0

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

  let srcIds
  if (hasSrcIds) {
    if (bytes.length < o + 1) throw new Error('ZONE srcIds truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n * 2) throw new Error('ZONE srcIds truncated')
    const extras = []
    for (let i = 0; i < n; i++) {
      extras.push(dv.getUint16(o, false))
      o += 2
    }
    const out = []
    const seen = new Set()
    const add = (v) => {
      const n = Math.floor(Number(v))
      if (!Number.isFinite(n) || n <= 0) return
      if (seen.has(n)) return
      seen.add(n)
      out.push(n)
    }
    add(src)
    for (const v of extras) add(v)
    if (out.length > 1) srcIds = out
  }

  return { src, ...(srcIds ? { srcIds } : {}), t: unixMinutes * 60000, threat, meaningCode, label, note, shape }
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

  if (hasSrcIds) {
    dv.setUint8(o, extraSrcIds.length)
    o += 1
    for (const unitId of extraSrcIds) {
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

// -----------------------------
// Template 9: EVENT (CLEAR)
// -----------------------------

// binary layout (v1):
// [0] u8 ver=1
// [1..2] u16 src
// [3..4] u16 dst
// [5] u8 pri
// [6] u8 status
// [7..10] u32 unixMinutes (reportedAt)
// [11] u8 typeCode
// [12] u8 flags bit0 hasLoc bit1 hasLabel bit2 hasLocLabel bit3 hasNote bit4 hasStart bit5 hasEnd bit6 hasSrcIds
// if hasStart: u32 startUnixMinutes
// if hasEnd: u32 endUnixMinutes
// if hasLoc: i32 latE5, i32 lonE5
// if hasLabel: u8 labelLen, label bytes (utf8, max 48)
// if hasLocLabel: u8 locLabelLen, locLabel bytes (utf8, max 48)
// if hasNote: u8 noteLen, note bytes (utf8, max 160)
// if hasSrcIds: u8 n + (n * u16 unitId) // extra unitIds beyond src

const EVENT_VERSION = 1
const EVENT_MAX_LABEL_BYTES = 48
const EVENT_MAX_LOC_LABEL_BYTES = 48
const EVENT_MAX_NOTE_BYTES = 160

function encodeEventClear(p) {
  const enc = new TextEncoder()
  const labelBytes = p?.label && String(p.label).trim() ? enc.encode(String(p.label).trim()) : undefined
  const locLabelBytes = p?.locationLabel && String(p.locationLabel).trim() ? enc.encode(String(p.locationLabel).trim()) : undefined
  const noteBytes = p?.note && String(p.note).trim() ? enc.encode(String(p.note).trim()) : undefined

  const hasLoc = Number.isFinite(p?.lat) && Number.isFinite(p?.lon)
  const hasLabel = !!labelBytes && labelBytes.length > 0
  const hasLocLabel = !!locLabelBytes && locLabelBytes.length > 0
  const hasNote = !!noteBytes && noteBytes.length > 0
  const hasStart = Number.isFinite(p?.startAt)
  const hasEnd = Number.isFinite(p?.endAt)
  const extraSrcIds = extraUnitIdsBeyondPrimary(p?.src, p?.srcIds)
  const hasSrcIds = extraSrcIds.length > 0

  const baseLen = 13
  const startLen = hasStart ? 4 : 0
  const endLen = hasEnd ? 4 : 0
  const locLen = hasLoc ? 8 : 0
  const labelLen = hasLabel ? 1 + Math.min(labelBytes.length, EVENT_MAX_LABEL_BYTES) : 0
  const locLabelLen = hasLocLabel ? 1 + Math.min(locLabelBytes.length, EVENT_MAX_LOC_LABEL_BYTES) : 0
  const noteLen = hasNote ? 1 + Math.min(noteBytes.length, EVENT_MAX_NOTE_BYTES) : 0
  const srcIdsLen = hasSrcIds ? 1 + extraSrcIds.length * 2 : 0

  const buf = new Uint8Array(baseLen + startLen + endLen + locLen + labelLen + locLabelLen + noteLen + srcIdsLen)
  const dv = new DataView(buf.buffer)

  dv.setUint8(0, EVENT_VERSION)
  dv.setUint16(1, Math.floor(Number(p?.src) || 0), false)
  dv.setUint16(3, Math.floor(Number(p?.dst) || 0), false)
  dv.setUint8(5, (Math.floor(Number(p?.pri) || 0) & 3))
  dv.setUint8(6, Math.max(0, Math.min(255, Math.floor(Number(p?.status) || 0))))
  dv.setUint32(7, Math.floor(Number(p?.t || Date.now()) / 60000), false)
  dv.setUint8(11, Math.max(0, Math.min(255, Math.floor(Number(p?.typeCode) || 0))))

  let flags = 0
  if (hasLoc) flags |= 1
  if (hasLabel) flags |= 2
  if (hasLocLabel) flags |= 4
  if (hasNote) flags |= 8
  if (hasStart) flags |= 16
  if (hasEnd) flags |= 32
  if (hasSrcIds) flags |= 64
  dv.setUint8(12, flags)

  let o = 13
  if (hasStart) {
    dv.setUint32(o, Math.floor(Number(p.startAt) / 60000), false)
    o += 4
  }
  if (hasEnd) {
    dv.setUint32(o, Math.floor(Number(p.endAt) / 60000), false)
    o += 4
  }
  if (hasLoc) {
    dv.setInt32(o, Math.round(Number(p.lat) * 1e5), false)
    o += 4
    dv.setInt32(o, Math.round(Number(p.lon) * 1e5), false)
    o += 4
  }
  if (hasLabel) {
    const n = Math.min(labelBytes.length, EVENT_MAX_LABEL_BYTES)
    dv.setUint8(o, n)
    o += 1
    buf.set(labelBytes.subarray(0, n), o)
    o += n
  }
  if (hasLocLabel) {
    const n = Math.min(locLabelBytes.length, EVENT_MAX_LOC_LABEL_BYTES)
    dv.setUint8(o, n)
    o += 1
    buf.set(locLabelBytes.subarray(0, n), o)
    o += n
  }
  if (hasNote) {
    const n = Math.min(noteBytes.length, EVENT_MAX_NOTE_BYTES)
    dv.setUint8(o, n)
    o += 1
    buf.set(noteBytes.subarray(0, n), o)
    o += n
  }
  if (hasSrcIds) {
    dv.setUint8(o, extraSrcIds.length)
    o += 1
    for (const unitId of extraSrcIds) {
      dv.setUint16(o, unitId, false)
      o += 2
    }
  }

  return encodeBase64Url(buf)
}

function decodeEventClear(b64) {
  const bytes = decodeBase64Url(b64)
  if (bytes.length < 13) throw new Error('EVENT payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const ver = dv.getUint8(0)
  if (ver !== EVENT_VERSION) throw new Error(`Unsupported EVENT version ${ver}`)

  const src = dv.getUint16(1, false)
  const dst = dv.getUint16(3, false)
  const pri = dv.getUint8(5) & 3
  const status = dv.getUint8(6)
  const unixMinutes = dv.getUint32(7, false)
  const typeCode = dv.getUint8(11)
  const flags = dv.getUint8(12)
  const hasLoc = (flags & 1) !== 0
  const hasLabel = (flags & 2) !== 0
  const hasLocLabel = (flags & 4) !== 0
  const hasNote = (flags & 8) !== 0
  const hasStart = (flags & 16) !== 0
  const hasEnd = (flags & 32) !== 0
  const hasSrcIds = (flags & 64) !== 0

  let o = 13
  const dec = new TextDecoder()

  let startAt = undefined
  if (hasStart) {
    if (bytes.length < o + 4) throw new Error('EVENT startAt truncated')
    const startUnixMinutes = dv.getUint32(o, false)
    o += 4
    startAt = startUnixMinutes * 60000
  }

  let endAt = undefined
  if (hasEnd) {
    if (bytes.length < o + 4) throw new Error('EVENT endAt truncated')
    const endUnixMinutes = dv.getUint32(o, false)
    o += 4
    endAt = endUnixMinutes * 60000
  }

  let lat = undefined
  let lon = undefined
  if (hasLoc) {
    if (bytes.length < o + 8) throw new Error('EVENT location truncated')
    lat = dv.getInt32(o, false) / 1e5
    o += 4
    lon = dv.getInt32(o, false) / 1e5
    o += 4
  }

  let label = undefined
  if (hasLabel) {
    if (bytes.length < o + 1) throw new Error('EVENT label truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('EVENT label truncated')
    label = dec.decode(bytes.subarray(o, o + n))
    o += n
  }

  let locationLabel = undefined
  if (hasLocLabel) {
    if (bytes.length < o + 1) throw new Error('EVENT location label truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('EVENT location label truncated')
    locationLabel = dec.decode(bytes.subarray(o, o + n))
    o += n
  }

  let note = undefined
  if (hasNote) {
    if (bytes.length < o + 1) throw new Error('EVENT note truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('EVENT note truncated')
    note = dec.decode(bytes.subarray(o, o + n))
    o += n
  }

  let srcIds = undefined
  if (hasSrcIds) {
    if (bytes.length < o + 1) throw new Error('EVENT srcIds truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n * 2) throw new Error('EVENT srcIds truncated')
    const extras = []
    for (let i = 0; i < n; i++) {
      const v = dv.getUint16(o, false)
      o += 2
      extras.push(v)
    }

    const out = []
    const seen = new Set()
    const add = (v) => {
      const n = Math.floor(Number(v))
      if (!Number.isFinite(n) || n <= 0) return
      if (seen.has(n)) return
      seen.add(n)
      out.push(n)
    }
    add(src)
    for (const v of extras) add(v)
    if (out.length > 1) srcIds = out
  }

  return {
    src,
    ...(srcIds ? { srcIds } : {}),
    dst,
    pri,
    status,
    t: unixMinutes * 60000,
    ...(hasStart ? { startAt } : {}),
    ...(hasEnd ? { endAt } : {}),
    typeCode,
    label,
    locationLabel,
    lat,
    lon,
    note,
  }
}

function makeEventClearPacket(p) {
  const id = generatePacketId(8)
  const encoded = encodeEventClear(p)
  return `X1.9.C.${id}.1/1.${encoded}`
}

// -----------------------------
// Template 10: PHASE LINE (CLEAR)
// -----------------------------

// binary layout (v1):
// [0] u8 ver=1
// [1..2] u16 src
// [3] u8 status
// [4] u8 kind
// [5] u8 style
// [6] u8 color
// [7] u8 flags bit0 hasLabel bit1 hasInstruction bit2 hasStart bit3 hasEnd bit4 hasSrcIds bit5 autoDetectCross
// [8..11] u32 updatedUnixMinutes
// [12..15] u32 createdUnixMinutes
// then:
//   u8 idLen + id bytes (utf8, max 32)
//   if hasLabel: u8 labelLen + label bytes (utf8, max 48)
//   if hasInstruction: u8 instructionLen + instruction bytes (utf8, max 160)
//   if hasStart: u32 startUnixMinutes
//   if hasEnd: u32 endUnixMinutes
//   u8 nPoints (2..32)
//   repeated nPoints: i32 latE5, i32 lonE5
//   if hasSrcIds: u8 n + (n * u16 unitId) // extra unitIds beyond src

const PHASE_LINE_VERSION = 1
const PHASE_LINE_MAX_ID_BYTES = 32
const PHASE_LINE_MAX_LABEL_BYTES = 48
const PHASE_LINE_MAX_INSTRUCTION_BYTES = 160
const PHASE_LINE_MAX_POINTS = 32

function encodePhaseLineClear(p) {
  const enc = new TextEncoder()

  const idBytesAll = enc.encode(String(p?.id ?? '').trim())
  const idBytes = idBytesAll.subarray(0, Math.min(idBytesAll.length, PHASE_LINE_MAX_ID_BYTES))
  if (!idBytes.length) throw new Error('PHASE_LINE id is required')

  const labelBytes = p?.label && String(p.label).trim() ? enc.encode(String(p.label).trim()) : undefined
  const instructionBytes = p?.instruction && String(p.instruction).trim() ? enc.encode(String(p.instruction).trim()) : undefined

  const hasLabel = !!labelBytes && labelBytes.length > 0
  const hasInstruction = !!instructionBytes && instructionBytes.length > 0
  const hasStart = Number.isFinite(p?.startAt)
  const hasEnd = Number.isFinite(p?.endAt)
  const extraSrcIds = extraUnitIdsBeyondPrimary(p?.src, p?.srcIds)
  const hasSrcIds = extraSrcIds.length > 0
  const autoDetectCross = p?.autoDetectCross === true

  const pts = Array.isArray(p?.points) ? p.points : []
  const nPoints = Math.min(Math.max(pts.length, 0), PHASE_LINE_MAX_POINTS)
  if (nPoints < 2) throw new Error('PHASE_LINE must have >= 2 points')

  const baseLen = 16
  const idLen = 1 + idBytes.length
  const labelLen = hasLabel ? 1 + Math.min(labelBytes.length, PHASE_LINE_MAX_LABEL_BYTES) : 0
  const instructionLen = hasInstruction ? 1 + Math.min(instructionBytes.length, PHASE_LINE_MAX_INSTRUCTION_BYTES) : 0
  const startLen = hasStart ? 4 : 0
  const endLen = hasEnd ? 4 : 0
  const pointsLen = 1 + nPoints * 8
  const srcIdsLen = hasSrcIds ? 1 + extraSrcIds.length * 2 : 0

  const buf = new Uint8Array(baseLen + idLen + labelLen + instructionLen + startLen + endLen + pointsLen + srcIdsLen)
  const dv = new DataView(buf.buffer)

  dv.setUint8(0, PHASE_LINE_VERSION)
  dv.setUint16(1, Number(p?.src) || 0, false)
  dv.setUint8(3, Math.max(0, Math.min(255, Math.floor(Number(p?.status) || 0))))
  dv.setUint8(4, Math.max(0, Math.min(255, Math.floor(Number(p?.kind) || 0))))
  dv.setUint8(5, Math.max(0, Math.min(255, Math.floor(Number(p?.style) || 0))))
  dv.setUint8(6, Math.max(0, Math.min(255, Math.floor(Number(p?.color) || 0))))

  let flags = 0
  if (hasLabel) flags |= 1
  if (hasInstruction) flags |= 2
  if (hasStart) flags |= 4
  if (hasEnd) flags |= 8
  if (hasSrcIds) flags |= 16
  if (autoDetectCross) flags |= 32
  dv.setUint8(7, flags)

  dv.setUint32(8, Math.floor(Number(p?.updatedAt ?? Date.now()) / 60000), false)
  dv.setUint32(12, Math.floor(Number(p?.createdAt ?? Date.now()) / 60000), false)

  let o = 16

  dv.setUint8(o, idBytes.length)
  o += 1
  buf.set(idBytes, o)
  o += idBytes.length

  if (hasLabel) {
    const n = Math.min(labelBytes.length, PHASE_LINE_MAX_LABEL_BYTES)
    dv.setUint8(o, n)
    o += 1
    buf.set(labelBytes.subarray(0, n), o)
    o += n
  }
  if (hasInstruction) {
    const n = Math.min(instructionBytes.length, PHASE_LINE_MAX_INSTRUCTION_BYTES)
    dv.setUint8(o, n)
    o += 1
    buf.set(instructionBytes.subarray(0, n), o)
    o += n
  }

  if (hasStart) {
    dv.setUint32(o, Math.floor(Number(p.startAt) / 60000), false)
    o += 4
  }
  if (hasEnd) {
    dv.setUint32(o, Math.floor(Number(p.endAt) / 60000), false)
    o += 4
  }

  dv.setUint8(o, nPoints)
  o += 1
  for (let i = 0; i < nPoints; i++) {
    const pt = pts[i] || {}
    dv.setInt32(o, Math.round(Number(pt.lat) * 1e5), false)
    o += 4
    dv.setInt32(o, Math.round(Number(pt.lon) * 1e5), false)
    o += 4
  }

  if (hasSrcIds) {
    dv.setUint8(o, extraSrcIds.length)
    o += 1
    for (const unitId of extraSrcIds) {
      dv.setUint16(o, unitId, false)
      o += 2
    }
  }

  return encodeBase64Url(buf)
}

function decodePhaseLineClear(b64) {
  const bytes = decodeBase64Url(b64)
  if (bytes.length < 16) throw new Error('PHASE_LINE payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const ver = dv.getUint8(0)
  if (ver !== PHASE_LINE_VERSION) throw new Error(`Unsupported PHASE_LINE version ${ver}`)

  const src = dv.getUint16(1, false)
  const status = dv.getUint8(3)
  const kind = dv.getUint8(4)
  const style = dv.getUint8(5)
  const color = dv.getUint8(6)
  const flags = dv.getUint8(7)
  const hasLabel = (flags & 1) !== 0
  const hasInstruction = (flags & 2) !== 0
  const hasStart = (flags & 4) !== 0
  const hasEnd = (flags & 8) !== 0
  const hasSrcIds = (flags & 16) !== 0
  const autoDetectCross = (flags & 32) !== 0

  const updatedUnixMinutes = dv.getUint32(8, false)
  const createdUnixMinutes = dv.getUint32(12, false)

  let o = 16
  const dec = new TextDecoder()

  if (bytes.length < o + 1) throw new Error('PHASE_LINE id truncated')
  const idLen = dv.getUint8(o)
  o += 1
  if (!idLen) throw new Error('PHASE_LINE id missing')
  if (bytes.length < o + idLen) throw new Error('PHASE_LINE id truncated')
  const id = dec.decode(bytes.subarray(o, o + idLen))
  o += idLen

  let label = undefined
  if (hasLabel) {
    if (bytes.length < o + 1) throw new Error('PHASE_LINE label truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('PHASE_LINE label truncated')
    label = dec.decode(bytes.subarray(o, o + n))
    o += n
  }

  let instruction = undefined
  if (hasInstruction) {
    if (bytes.length < o + 1) throw new Error('PHASE_LINE instruction truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('PHASE_LINE instruction truncated')
    instruction = dec.decode(bytes.subarray(o, o + n))
    o += n
  }

  let startAt = undefined
  if (hasStart) {
    if (bytes.length < o + 4) throw new Error('PHASE_LINE startAt truncated')
    const startUnixMinutes = dv.getUint32(o, false)
    o += 4
    startAt = startUnixMinutes * 60000
  }

  let endAt = undefined
  if (hasEnd) {
    if (bytes.length < o + 4) throw new Error('PHASE_LINE endAt truncated')
    const endUnixMinutes = dv.getUint32(o, false)
    o += 4
    endAt = endUnixMinutes * 60000
  }

  if (bytes.length < o + 1) throw new Error('PHASE_LINE points truncated')
  const nPoints = dv.getUint8(o)
  o += 1
  if (nPoints < 2) throw new Error('PHASE_LINE must have >= 2 points')
  if (nPoints > PHASE_LINE_MAX_POINTS) throw new Error(`PHASE_LINE too many points (${nPoints})`)
  if (bytes.length < o + nPoints * 8) throw new Error('PHASE_LINE points truncated')

  const points = []
  for (let i = 0; i < nPoints; i++) {
    const lat = dv.getInt32(o, false) / 1e5
    o += 4
    const lon = dv.getInt32(o, false) / 1e5
    o += 4
    points.push({ lat, lon })
  }

  let srcIds = undefined
  if (hasSrcIds) {
    if (bytes.length < o + 1) throw new Error('PHASE_LINE srcIds truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n * 2) throw new Error('PHASE_LINE srcIds truncated')
    const extras = []
    for (let i = 0; i < n; i++) {
      const v = dv.getUint16(o, false)
      o += 2
      extras.push(v)
    }

    const out = []
    const seen = new Set()
    const add = (v) => {
      const n = Math.floor(Number(v))
      if (!Number.isFinite(n) || n <= 0) return
      if (seen.has(n)) return
      seen.add(n)
      out.push(n)
    }
    add(src)
    for (const v of extras) add(v)
    if (out.length > 1) srcIds = out
  }

  return {
    id,
    src,
    ...(srcIds ? { srcIds } : {}),
    createdAt: createdUnixMinutes * 60000,
    updatedAt: updatedUnixMinutes * 60000,
    status,
    kind,
    style,
    color,
    ...(hasStart ? { startAt } : {}),
    ...(hasEnd ? { endAt } : {}),
    label,
    instruction,
    points,
    ...(autoDetectCross ? { autoDetectCross: true } : {}),
  }
}

function makePhaseLineClearPacket(p) {
  const id = generatePacketId(8)
  const encoded = encodePhaseLineClear(p)
  return `X1.10.C.${id}.1/1.${encoded}`
}

// -----------------------------
// Template 11: SENTINEL (CLEAR)
// -----------------------------

const SENTINEL_VERSION = 1
const SENTINEL_MAX_SENSORS = 32
const SENTINEL_MAX_LABEL_BYTES = 32

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.floor(Number(n) || 0)))
}

function normalizeSentinelSensors(sensors) {
  const list = Array.isArray(sensors) ? sensors : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const type = Math.floor(Number(item.type))
    const value = Math.floor(Number(item.value))
    if (!Number.isFinite(type) || type < 0 || type > 255) continue
    if (!Number.isFinite(value) || value < -32768 || value > 32767) continue
    out.push({ type, value })
    if (out.length >= SENTINEL_MAX_SENSORS) break
  }
  return out
}

function encodeSentinelClear(payload) {
  const nodeId = Number(payload?.nodeId)
  if (!Number.isFinite(nodeId) || nodeId < 0 || nodeId > 0xffffffff) throw new Error('Invalid nodeId')
  if (!Number.isFinite(payload?.t) || Number(payload.t) <= 0) throw new Error('Invalid t')
  if (!Number.isFinite(payload?.lat) || !Number.isFinite(payload?.lon)) throw new Error('Invalid location')

  const sensors = normalizeSentinelSensors(payload?.sensors)

  const enc = new TextEncoder()
  const labelBytes = payload?.label && String(payload.label).trim() ? enc.encode(String(payload.label).trim()) : null
  const hasLabel = !!labelBytes && labelBytes.length > 0

  const hasIo = Number.isFinite(payload?.inMask) || Number.isFinite(payload?.outMask)
  const inMask = clampByte(payload?.inMask)
  const outMask = clampByte(payload?.outMask)

  let flags = 0
  if (payload?.alert) flags |= 1
  if (hasIo) flags |= 2
  if (hasLabel) flags |= 4

  const baseLen = 19
  const ioLen = hasIo ? 2 : 0
  const labelLen = hasLabel ? (1 + Math.min(labelBytes.length, SENTINEL_MAX_LABEL_BYTES)) : 0
  const sensorsLen = sensors.length * 3
  const totalLen = baseLen + ioLen + labelLen + sensorsLen

  const buf = new Uint8Array(totalLen)
  const dv = new DataView(buf.buffer)

  dv.setUint8(0, SENTINEL_VERSION)
  dv.setUint8(1, sensors.length)
  dv.setUint32(2, Math.floor(Number(payload.t) / 60000), false)
  dv.setInt32(6, Math.round(Number(payload.lat) * 1e5), false)
  dv.setInt32(10, Math.round(Number(payload.lon) * 1e5), false)
  dv.setUint32(14, nodeId >>> 0, false)
  dv.setUint8(18, flags)

  let o = 19
  if (hasIo) {
    dv.setUint8(o, inMask)
    o += 1
    dv.setUint8(o, outMask)
    o += 1
  }

  if (hasLabel) {
    const n = Math.min(labelBytes.length, SENTINEL_MAX_LABEL_BYTES)
    dv.setUint8(o, n)
    o += 1
    buf.set(labelBytes.subarray(0, n), o)
    o += n
  }

  for (const s of sensors) {
    dv.setUint8(o, s.type)
    o += 1
    dv.setInt16(o, s.value, false)
    o += 2
  }

  return encodeBase64Url(buf)
}

function decodeSentinelClear(payloadB64Url) {
  const bytes = decodeBase64Url(payloadB64Url)
  if (bytes.length < 19) throw new Error('SENTINEL payload too short')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const ver = dv.getUint8(0)
  if (ver !== SENTINEL_VERSION) throw new Error(`Unsupported SENTINEL version ${ver}`)

  const sensorCount = dv.getUint8(1)
  if (sensorCount > SENTINEL_MAX_SENSORS) throw new Error(`SENTINEL too many sensors (${sensorCount})`)

  const unixMinutes = dv.getUint32(2, false)
  const lat = dv.getInt32(6, false) / 1e5
  const lon = dv.getInt32(10, false) / 1e5
  const nodeId = dv.getUint32(14, false)

  const flags = dv.getUint8(18)
  const alert = (flags & 1) !== 0
  const hasIo = (flags & 2) !== 0
  const hasLabel = (flags & 4) !== 0

  let o = 19
  let inMask
  let outMask
  if (hasIo) {
    if (bytes.length < o + 2) throw new Error('SENTINEL io truncated')
    inMask = dv.getUint8(o)
    o += 1
    outMask = dv.getUint8(o)
    o += 1
  }

  let label
  if (hasLabel) {
    if (bytes.length < o + 1) throw new Error('SENTINEL label truncated')
    const n = dv.getUint8(o)
    o += 1
    if (bytes.length < o + n) throw new Error('SENTINEL label truncated')
    const dec = new TextDecoder()
    const s = dec.decode(bytes.subarray(o, o + n)).trim()
    label = s || undefined
    o += n
  }

  const need = sensorCount * 3
  if (bytes.length < o + need) throw new Error('SENTINEL sensors truncated')
  const sensors = []
  for (let i = 0; i < sensorCount; i++) {
    const type = dv.getUint8(o)
    o += 1
    const value = dv.getInt16(o, false)
    o += 2
    sensors.push({ type, value })
  }

  return {
    nodeId,
    t: unixMinutes * 60000,
    lat,
    lon,
    ...(alert ? { alert: true } : {}),
    ...(label ? { label } : {}),
    ...(hasIo ? { inMask, outMask } : {}),
    sensors,
  }
}

function makeSentinelClearPacket(p) {
  const id = generatePacketId(8)
  const encoded = encodeSentinelClear(p)
  return `X1.11.C.${id}.1/1.${encoded}`
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

  globalThis.encodeEventClear = encodeEventClear
  globalThis.decodeEventClear = decodeEventClear
  globalThis.makeEventClearPacket = makeEventClearPacket

  globalThis.encodePhaseLineClear = encodePhaseLineClear
  globalThis.decodePhaseLineClear = decodePhaseLineClear
  globalThis.makePhaseLineClearPacket = makePhaseLineClearPacket

  globalThis.encodeSentinelClear = encodeSentinelClear
  globalThis.decodeSentinelClear = decodeSentinelClear
  globalThis.makeSentinelClearPacket = makeSentinelClearPacket
} catch (_) {
  // ignore
}
