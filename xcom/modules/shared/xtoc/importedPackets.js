// Imported packet overlay storage (localStorage).
// Used by:
// - Comms: "Import to map" from pasted/received packet wrappers
// - Map: render Imported overlay (points/zones)
//
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

const LS_IMPORTED_PACKETS = 'xcom.xtoc.importedPackets.v1'
// Keep more markers; rendering is additionally filtered on the Map (e.g., last 7 days).
const MAX_IMPORTED_PACKETS = 5000

function importedReadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch (_) {
    return fallback
  }
}

function importedWriteJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

function importedUid() {
  // Prefer crypto.randomUUID when present (modern browsers), otherwise fallback.
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  } catch (_) {
    // ignore
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function getImportedPackets() {
  const arr = importedReadJson(LS_IMPORTED_PACKETS, [])
  if (!Array.isArray(arr)) return []

  // Basic normalization + cap.
  return arr
    .map((e) => {
      if (!e || typeof e !== 'object') return null
      const raw = String(e.raw || '').trim()
      if (!raw) return null
      const templateId = Number(e.templateId)
      const mode = e.mode === 'S' ? 'S' : 'C'
      const packetId = String(e.packetId || e.id || '').trim()
      const kid = e.kid != null ? Number(e.kid) : undefined
      const importedAt = Number(e.importedAt || 0)
      const summary = e.summary != null ? String(e.summary) : ''
      const features = Array.isArray(e.features) ? e.features : []
      return {
        key: e.key ? String(e.key) : importedUid(),
        importedAt: Number.isFinite(importedAt) ? importedAt : 0,
        raw,
        templateId: Number.isFinite(templateId) ? templateId : 0,
        mode,
        packetId,
        kid: Number.isFinite(kid) ? kid : undefined,
        summary,
        features,
      }
    })
    .filter(Boolean)
    .slice(-MAX_IMPORTED_PACKETS)
}

function notifyImportedUpdated() {
  try {
    globalThis.dispatchEvent(new Event('xcomImportedPacketsUpdated'))
  } catch (_) {
    // ignore
  }
}

function addImportedPacket(entry) {
  try {
    const raw = String(entry?.raw || '').trim()
    if (!raw) return { ok: false, reason: 'Missing raw wrapper' }

    const list = getImportedPackets()
    if (list.some((x) => x.raw === raw)) return { ok: true, added: false, count: list.length }

    const next = [
      ...list,
      {
        key: entry?.key ? String(entry.key) : importedUid(),
        importedAt: Date.now(),
        raw,
        templateId: Number(entry?.templateId) || 0,
        mode: entry?.mode === 'S' ? 'S' : 'C',
        packetId: String(entry?.packetId || '').trim(),
        kid: entry?.kid != null ? Number(entry.kid) : undefined,
        summary: entry?.summary != null ? String(entry.summary) : '',
        features: Array.isArray(entry?.features) ? entry.features : [],
      },
    ].slice(-MAX_IMPORTED_PACKETS)

    importedWriteJson(LS_IMPORTED_PACKETS, next)
    notifyImportedUpdated()
    return { ok: true, added: true, count: next.length }
  } catch (e) {
    return { ok: false, reason: e?.message ? String(e.message) : String(e) }
  }
}

// Bulk variant (performance): add many overlay entries with a single localStorage write + single update event.
function addImportedPackets(entries) {
  try {
    const list = getImportedPackets()
    const seen = new Set(list.map((x) => x.raw))

    let added = 0
    let dup = 0

    const next = [...list]
    for (const entry of Array.isArray(entries) ? entries : []) {
      const raw = String(entry?.raw || '').trim()
      if (!raw) continue
      if (seen.has(raw)) {
        dup++
        continue
      }
      seen.add(raw)
      next.push({
        key: entry?.key ? String(entry.key) : importedUid(),
        importedAt: Number.isFinite(Number(entry?.importedAt)) ? Number(entry.importedAt) : Date.now(),
        raw,
        templateId: Number(entry?.templateId) || 0,
        mode: entry?.mode === 'S' ? 'S' : 'C',
        packetId: String(entry?.packetId || '').trim(),
        kid: entry?.kid != null ? Number(entry.kid) : undefined,
        summary: entry?.summary != null ? String(entry.summary) : '',
        features: Array.isArray(entry?.features) ? entry.features : [],
      })
      added++
    }

    const capped = next.slice(-MAX_IMPORTED_PACKETS)
    importedWriteJson(LS_IMPORTED_PACKETS, capped)
    notifyImportedUpdated()
    return { ok: true, added, dup, count: capped.length }
  } catch (e) {
    return { ok: false, reason: e?.message ? String(e.message) : String(e) }
  }
}

function clearImportedPackets() {
  try {
    localStorage.removeItem(LS_IMPORTED_PACKETS)
  } catch (_) {
    // ignore
  }
  notifyImportedUpdated()
}

// Expose globals (XCOM loads scripts as classic <script>).
try {
  globalThis.getImportedPackets = getImportedPackets
  globalThis.addImportedPacket = addImportedPacket
  globalThis.addImportedPackets = addImportedPackets
  globalThis.clearImportedPackets = clearImportedPackets
} catch (_) {
  // ignore
}
