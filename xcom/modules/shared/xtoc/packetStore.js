// XTOC packet store (IndexedDB) for XCOM.
//
// Goals:
// - Persist ALL XTOC packets (location + non-location)
// - Support fast listing by time for the XTOC Data module
//
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

const XCOM_XTOC_DB_NAME = 'xcom.xtoc.db'
const XCOM_XTOC_DB_VERSION = 1
const XCOM_XTOC_STORE_PACKETS = 'packets'

let __xcomXtocDbPromise = null

function xcomOpenXtocDb() {
  if (__xcomXtocDbPromise) return __xcomXtocDbPromise
  __xcomXtocDbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(XCOM_XTOC_DB_NAME, XCOM_XTOC_DB_VERSION)
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'))
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(XCOM_XTOC_STORE_PACKETS)) {
          const store = db.createObjectStore(XCOM_XTOC_STORE_PACKETS, { keyPath: 'key' })
          store.createIndex('receivedAt', 'receivedAt', { unique: false })
          store.createIndex('storedAt', 'storedAt', { unique: false })
          store.createIndex('templateId', 'templateId', { unique: false })
          store.createIndex('mode', 'mode', { unique: false })
          store.createIndex('source', 'source', { unique: false })
          store.createIndex('hasGeo', 'hasGeo', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
    } catch (e) {
      reject(e)
    }
  })
  return __xcomXtocDbPromise
}

function xcomAsNonEmptyString(v) {
  const s = String(v ?? '').trim()
  return s ? s : null
}

function xcomAsFiniteNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function xcomNormalizePacketRecord(rec) {
  const key = xcomAsNonEmptyString(rec?.key)
  if (!key) return null

  const templateId = xcomAsFiniteNumber(rec?.templateId)
  const mode = rec?.mode === 'S' ? 'S' : 'C'
  const id = xcomAsNonEmptyString(rec?.id) || ''
  const raw = xcomAsNonEmptyString(rec?.raw) || ''

  const storedAt = xcomAsFiniteNumber(rec?.storedAt) ?? Date.now()
  const receivedAt = xcomAsFiniteNumber(rec?.receivedAt) ?? storedAt
  const packetAt = xcomAsFiniteNumber(rec?.packetAt)

  const kid = mode === 'S' ? (xcomAsFiniteNumber(rec?.kid) ?? null) : null
  const part = xcomAsFiniteNumber(rec?.part) ?? 1
  const total = xcomAsFiniteNumber(rec?.total) ?? 1

  const summary = xcomAsNonEmptyString(rec?.summary)
  const source = xcomAsNonEmptyString(rec?.source) || 'unknown'

  const hasGeo = rec?.hasGeo === true
  const features = Array.isArray(rec?.features) ? rec.features : []
  const decoded = rec?.decoded != null ? rec.decoded : undefined
  const decodeError = xcomAsNonEmptyString(rec?.decodeError)

  const sources = Array.isArray(rec?.sources)
    ? rec.sources.map((s) => xcomAsNonEmptyString(s)).filter(Boolean)
    : []

  return {
    key,
    templateId: Number.isFinite(templateId) ? Number(templateId) : 0,
    mode,
    id,
    ...(kid != null ? { kid: Number(kid) } : {}),
    part: Number.isFinite(part) ? Math.max(1, Math.floor(Number(part))) : 1,
    total: Number.isFinite(total) ? Math.max(1, Math.floor(Number(total))) : 1,
    raw,
    storedAt,
    receivedAt,
    ...(packetAt != null ? { packetAt } : {}),
    source,
    ...(sources.length ? { sources: Array.from(new Set([source, ...sources])) } : { sources: [source] }),
    ...(summary ? { summary } : {}),
    ...(decoded !== undefined ? { decoded } : {}),
    ...(decodeError ? { decodeError } : {}),
    hasGeo,
    ...(features.length ? { features } : { features: [] }),
  }
}

async function xcomPutXtocPacket(rec) {
  const norm = xcomNormalizePacketRecord(rec)
  if (!norm) return { ok: false, reason: 'Invalid record' }

  const db = await xcomOpenXtocDb()
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction([XCOM_XTOC_STORE_PACKETS], 'readwrite')
      const store = tx.objectStore(XCOM_XTOC_STORE_PACKETS)

      const getReq = store.get(norm.key)
      getReq.onerror = () => resolve({ ok: false, reason: getReq.error?.message || 'Read failed' })
      getReq.onsuccess = () => {
        const prev = getReq.result || null
        const merged = prev
          ? {
              ...prev,
              ...norm,
              sources: Array.from(new Set([...(Array.isArray(prev.sources) ? prev.sources : []), ...(norm.sources || [])])),
            }
          : norm

        const putReq = store.put(merged)
        putReq.onerror = () => resolve({ ok: false, reason: putReq.error?.message || 'Write failed' })
        putReq.onsuccess = () => resolve({ ok: true, key: norm.key })
      }
    } catch (e) {
      resolve({ ok: false, reason: e?.message ? String(e.message) : String(e) })
    }
  })
}

async function xcomPutXtocPackets(records, opts = {}) {
  const list = Array.isArray(records) ? records : []
  const normalized = list.map(xcomNormalizePacketRecord).filter(Boolean)
  if (normalized.length === 0) return { ok: true, put: 0, skipped: list.length }

  const db = await xcomOpenXtocDb()
  const mergeSources = opts.mergeSources !== false

  return await new Promise((resolve) => {
    let put = 0
    let skipped = list.length - normalized.length

    try {
      const tx = db.transaction([XCOM_XTOC_STORE_PACKETS], 'readwrite')
      const store = tx.objectStore(XCOM_XTOC_STORE_PACKETS)

      const runOne = (i) => {
        if (i >= normalized.length) return
        const rec = normalized[i]

        if (!mergeSources) {
          const req = store.put(rec)
          req.onerror = () => {
            skipped++
            runOne(i + 1)
          }
          req.onsuccess = () => {
            put++
            runOne(i + 1)
          }
          return
        }

        const getReq = store.get(rec.key)
        getReq.onerror = () => {
          skipped++
          runOne(i + 1)
        }
        getReq.onsuccess = () => {
          const prev = getReq.result || null
          const merged = prev
            ? {
                ...prev,
                ...rec,
                sources: Array.from(new Set([...(Array.isArray(prev.sources) ? prev.sources : []), ...(rec.sources || [])])),
              }
            : rec
          const putReq = store.put(merged)
          putReq.onerror = () => {
            skipped++
            runOne(i + 1)
          }
          putReq.onsuccess = () => {
            put++
            runOne(i + 1)
          }
        }
      }

      tx.oncomplete = () => resolve({ ok: true, put, skipped })
      tx.onerror = () => resolve({ ok: false, reason: tx.error?.message || 'Transaction failed', put, skipped })
      tx.onabort = () => resolve({ ok: false, reason: tx.error?.message || 'Transaction aborted', put, skipped })

      runOne(0)
    } catch (e) {
      resolve({ ok: false, reason: e?.message ? String(e.message) : String(e), put, skipped })
    }
  })
}

async function xcomCountXtocPackets() {
  const db = await xcomOpenXtocDb()
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction([XCOM_XTOC_STORE_PACKETS], 'readonly')
      const store = tx.objectStore(XCOM_XTOC_STORE_PACKETS)
      const req = store.count()
      req.onerror = () => resolve({ ok: false, reason: req.error?.message || 'Count failed', count: 0 })
      req.onsuccess = () => resolve({ ok: true, count: Number(req.result || 0) || 0 })
    } catch (e) {
      resolve({ ok: false, reason: e?.message ? String(e.message) : String(e), count: 0 })
    }
  })
}

async function xcomGetXtocPacket(key) {
  const k = xcomAsNonEmptyString(key)
  if (!k) return null
  const db = await xcomOpenXtocDb()
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction([XCOM_XTOC_STORE_PACKETS], 'readonly')
      const store = tx.objectStore(XCOM_XTOC_STORE_PACKETS)
      const req = store.get(k)
      req.onerror = () => resolve(null)
      req.onsuccess = () => resolve(req.result || null)
    } catch (_) {
      resolve(null)
    }
  })
}

async function xcomListXtocPackets(opts = {}) {
  const limit = Math.max(1, Math.min(5000, Math.floor(Number(opts.limit) || 500)))
  const sinceMs = xcomAsFiniteNumber(opts.sinceMs)
  const templateId = xcomAsFiniteNumber(opts.templateId)
  const mode = opts.mode === 'S' ? 'S' : (opts.mode === 'C' ? 'C' : null)
  const source = xcomAsNonEmptyString(opts.source)
  const hasGeo = opts.hasGeo === true ? true : (opts.hasGeo === false ? false : null)
  const q = xcomAsNonEmptyString(opts.query)?.toLowerCase() || null

  const db = await xcomOpenXtocDb()
  return await new Promise((resolve) => {
    const out = []
    try {
      const tx = db.transaction([XCOM_XTOC_STORE_PACKETS], 'readonly')
      const store = tx.objectStore(XCOM_XTOC_STORE_PACKETS)
      const index = store.index('receivedAt')
      const req = index.openCursor(null, 'prev')

      req.onerror = () => resolve({ ok: false, reason: req.error?.message || 'Cursor failed', packets: [] })
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve({ ok: true, packets: out })
          return
        }

        const rec = cursor.value || null

        const rxAt = Number(rec?.receivedAt || 0) || 0
        if (sinceMs != null && rxAt && rxAt < sinceMs) {
          // Cursor is descending by receivedAt; once we pass the window we can stop.
          resolve({ ok: true, packets: out })
          return
        }

        let ok = true
        if (templateId != null && Number(rec?.templateId) !== templateId) ok = false
        if (mode != null && String(rec?.mode) !== mode) ok = false
        if (source && String(rec?.source || '') !== source) ok = false
        if (hasGeo != null && !!rec?.hasGeo !== hasGeo) ok = false
        if (q) {
          const hay = `${String(rec?.summary || '')}\n${String(rec?.raw || '')}`.toLowerCase()
          if (!hay.includes(q)) ok = false
        }

        if (ok) out.push(rec)
        if (out.length >= limit) {
          resolve({ ok: true, packets: out })
          return
        }
        cursor.continue()
      }
    } catch (e) {
      resolve({ ok: false, reason: e?.message ? String(e.message) : String(e), packets: [] })
    }
  })
}

async function xcomClearXtocPackets() {
  const db = await xcomOpenXtocDb()
  return await new Promise((resolve) => {
    try {
      const tx = db.transaction([XCOM_XTOC_STORE_PACKETS], 'readwrite')
      const store = tx.objectStore(XCOM_XTOC_STORE_PACKETS)
      const req = store.clear()
      req.onerror = () => resolve({ ok: false, reason: req.error?.message || 'Clear failed' })
      req.onsuccess = () => resolve({ ok: true })
    } catch (e) {
      resolve({ ok: false, reason: e?.message ? String(e.message) : String(e) })
    }
  })
}

// Expose globals (XCOM loads scripts as classic <script>).
try {
  globalThis.xcomOpenXtocDb = xcomOpenXtocDb
  globalThis.xcomPutXtocPacket = xcomPutXtocPacket
  globalThis.xcomPutXtocPackets = xcomPutXtocPackets
  globalThis.xcomCountXtocPackets = xcomCountXtocPackets
  globalThis.xcomGetXtocPacket = xcomGetXtocPacket
  globalThis.xcomListXtocPackets = xcomListXtocPackets
  globalThis.xcomClearXtocPackets = xcomClearXtocPackets
} catch (_) {
  // ignore
}

