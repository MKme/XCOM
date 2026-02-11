// XTOC-compatible team roster helpers for XCOM.
//
// Purpose:
// - Import XTOC team roster exports (XTOC-TEAM or backup members array)
// - Store the FULL roster record (including personal fields) locally on this device
// - Provide helpers to render "U# (Label)" friendly labels on the map
//
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

const LS_ROSTER = 'xcom.xtoc.teamRoster.v1'
const MAX_ROSTER_MEMBERS = 500

function rosterReadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch (_) {
    return fallback
  }
}

function rosterWriteJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

function notifyRosterUpdated() {
  try {
    globalThis.dispatchEvent(new Event('xcomTeamRosterUpdated'))
  } catch (_) {
    // ignore
  }
}

function normalizeRosterMember(m) {
  if (!m || typeof m !== 'object') return null
  const unitId = Number(m?.unitId)
  if (!Number.isFinite(unitId) || unitId <= 0) return null

  // Keep the full member record (including personal fields) per UX request.
  // Ensure the few critical fields are normalized to safe primitives.
  const out = { ...m }
  out.unitId = Math.floor(unitId)

  const label = String(m?.label ?? '').trim()
  out.label = label || `U${out.unitId}`

  const maybeString = (v) => {
    const s = String(v ?? '').trim()
    return s ? s : undefined
  }
  const maybeNumber = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }

  // Normalize known optional fields (keep undefined for empties).
  out.hamCallsign = maybeString(m?.hamCallsign)
  out.role = maybeString(m?.role)
  out.email = maybeString(m?.email)
  out.phone = maybeString(m?.phone)
  out.bloodType = maybeString(m?.bloodType)
  out.status = maybeString(m?.status)
  out.skills = maybeString(m?.skills)
  out.notes = maybeString(m?.notes)
  out.color = maybeString(m?.color)
  out.meshNodeId = maybeString(m?.meshNodeId)

  out.lastSeenAt = maybeNumber(m?.lastSeenAt)
  out.lastLat = maybeNumber(m?.lastLat)
  out.lastLon = maybeNumber(m?.lastLon)

  out.lastCommsAt = maybeNumber(m?.lastCommsAt)
  out.lastCommsType = maybeString(m?.lastCommsType)
  out.lastCommsTemplateId = maybeNumber(m?.lastCommsTemplateId)
  out.lastCommsSummary = maybeString(m?.lastCommsSummary)
  out.lastCommsRaw = maybeString(m?.lastCommsRaw)

  return out
}

function getTeamRosterStore() {
  const obj = rosterReadJson(LS_ROSTER, null)
  const updatedAt = Number(obj?.updatedAt || obj?.exportedAt || 0)
  const members = Array.isArray(obj?.members) ? obj.members : []
  const normalized = members.map(normalizeRosterMember).filter(Boolean).slice(0, MAX_ROSTER_MEMBERS)
  return {
    v: 1,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    members: normalized,
  }
}

function setTeamRosterStore(store) {
  rosterWriteJson(LS_ROSTER, store)
  notifyRosterUpdated()
}

function listRosterMembers() {
  return getTeamRosterStore().members || []
}

function upsertRosterMembers(members, opts = {}) {
  try {
    const replace = !!opts.replace
    const existing = replace ? [] : listRosterMembers()

    const byUnit = new Map()
    for (const m of existing) {
      const nm = normalizeRosterMember(m)
      if (nm) byUnit.set(nm.unitId, nm)
    }

    let added = 0
    let updated = 0

    for (const m of Array.isArray(members) ? members : []) {
      const nm = normalizeRosterMember(m)
      if (!nm) continue
      const prev = byUnit.get(nm.unitId)
      if (!prev) {
        byUnit.set(nm.unitId, nm)
        added++
        continue
      }
      const next = {
        ...prev,
        ...nm,
      }
      byUnit.set(nm.unitId, next)
      if (JSON.stringify(prev) !== JSON.stringify(next)) updated++
    }

    const out = Array.from(byUnit.values())
      .sort((a, b) => a.unitId - b.unitId)
      .slice(0, MAX_ROSTER_MEMBERS)

    setTeamRosterStore({ v: 1, updatedAt: Date.now(), members: out })
    return { ok: true, added, updated, total: out.length }
  } catch (e) {
    return { ok: false, reason: e?.message ? String(e.message) : String(e) }
  }
}

function clearTeamRoster() {
  try {
    localStorage.removeItem(LS_ROSTER)
  } catch (_) {
    // ignore
  }
  notifyRosterUpdated()
}

function safeLabelFromRosterMember(m) {
  const label = String(m?.label ?? '').trim()
  if (label) return label
  const call = String(m?.hamCallsign ?? '').trim()
  if (call) return call
  const unitId = Number(m?.unitId)
  return Number.isFinite(unitId) && unitId > 0 ? `U${unitId}` : 'U?'
}

function formatUnitWithLabel(unitId, label) {
  const unit = `U${unitId}`
  const trimmed = String(label ?? '').trim()
  if (!trimmed) return unit
  // Avoid duplicates like: `U1 (U1 / Eric)` if the label already includes the unit id.
  if (new RegExp(`\\b${unit}\\b`).test(trimmed)) return trimmed
  return `${unit} (${trimmed})`
}

function buildSafeLabelByUnitId() {
  const map = new Map()
  for (const m of listRosterMembers()) {
    if (!m) continue
    const unitId = Number(m.unitId)
    if (!Number.isFinite(unitId) || unitId <= 0) continue
    map.set(unitId, safeLabelFromRosterMember(m))
  }
  return map
}

function withRosterLabels(text) {
  const s = String(text ?? '')
  if (!s) return s
  const labelByUnitId = buildSafeLabelByUnitId()
  if (labelByUnitId.size === 0) return s

  return s.replace(/\bU(\d+)\b/g, (_m, idStr) => {
    const unitId = Number(idStr)
    if (!Number.isFinite(unitId) || unitId <= 0) return `U${idStr}`
    return formatUnitWithLabel(unitId, labelByUnitId.get(unitId))
  })
}

function setMeshNodeAssignment(nodeKey, unitId) {
  try {
    const key = String(nodeKey ?? '').trim()
    if (!key) return { ok: false, reason: 'bad_node_key' }

    const u = Math.floor(Number(unitId))
    const assignUnitId = Number.isFinite(u) && u > 0 ? u : null

    const store = getTeamRosterStore()
    const members = Array.isArray(store?.members) ? store.members : []
    let changed = false

    const nextMembers = members
      .map((m) => {
        const nm = normalizeRosterMember(m)
        if (!nm) return null

        const currentKey = String(nm?.meshNodeId ?? '').trim()
        const next = { ...nm }

        // Clear this key from everyone except the selected unit.
        if (currentKey === key && (!assignUnitId || next.unitId !== assignUnitId)) {
          next.meshNodeId = undefined
          changed = true
        }

        // Set the key on the selected unit.
        if (assignUnitId && next.unitId === assignUnitId) {
          if (currentKey !== key) {
            next.meshNodeId = key
            changed = true
          }
        }

        return normalizeRosterMember(next)
      })
      .filter(Boolean)
      .slice(0, MAX_ROSTER_MEMBERS)

    if (changed) {
      setTeamRosterStore({ v: 1, updatedAt: Date.now(), members: nextMembers })
    } else {
      // Still notify so UI can refresh popups/titles if needed.
      notifyRosterUpdated()
    }

    return { ok: true, changed }
  } catch (e) {
    return { ok: false, reason: e?.message ? String(e.message) : String(e) }
  }
}

// Expose globals (XCOM loads scripts as classic <script>).
try {
  globalThis.xcomGetTeamRoster = getTeamRosterStore
  globalThis.xcomListRosterMembers = listRosterMembers
  globalThis.xcomUpsertRosterMembers = upsertRosterMembers
  globalThis.xcomClearTeamRoster = clearTeamRoster
  globalThis.xcomFormatUnitWithLabel = formatUnitWithLabel
  globalThis.xcomWithRosterLabels = withRosterLabels
  globalThis.xcomSetMeshNodeAssignment = setMeshNodeAssignment
} catch (_) {
  // ignore
}
