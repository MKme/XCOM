// Simple localStorage-backed storage for XCOM Comms/Secure.
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

const LS_PREFIX = 'xcom.xtoc.'
const LS_ACTIVE_TEAM = LS_PREFIX + 'activeTeamId'
const LS_ACTIVE_KID = LS_PREFIX + 'activeKid'
const LS_KEYS = LS_PREFIX + 'teamKeys'

// XCOM Comms uses a single "active imported key" slot.
// This intentionally does NOT bind to TeamID/KID input fields in the Comms UI.
// It mirrors XTOC Comms behavior: import/select key, then generate SECURE packets.
const LS_COMMS_ACTIVE_KEY = LS_PREFIX + 'commsActiveKey'

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

function getActiveTeamId() {
  return localStorage.getItem(LS_ACTIVE_TEAM) || 'TEAM'
}

function setActiveTeamId(teamId) {
  localStorage.setItem(LS_ACTIVE_TEAM, String(teamId || 'TEAM'))
}

function getActiveKid() {
  const raw = localStorage.getItem(LS_ACTIVE_KID)
  const n = raw ? Number(raw) : 1
  return Number.isFinite(n) && n > 0 ? n : 1
}

function setActiveKid(kid) {
  const n = Number(kid)
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid KID')
  localStorage.setItem(LS_ACTIVE_KID, String(n))
}

// Returns { [teamId]: { [kid]: { keyB64Url } } }
function getTeamKeysMap() {
  const obj = readJson(LS_KEYS, {})
  return obj && typeof obj === 'object' ? obj : {}
}

function putTeamKey(teamId, kid, keyB64Url) {
  const t = String(teamId)
  const k = String(Number(kid))
  if (!t) throw new Error('Missing teamId')
  if (!k || k === 'NaN') throw new Error('Invalid kid')
  if (!keyB64Url) throw new Error('Missing key')

  const map = getTeamKeysMap()
  if (!map[t]) map[t] = {}
  map[t][k] = { keyB64Url: String(keyB64Url) }
  writeJson(LS_KEYS, map)
}

function getTeamKey(teamId, kid) {
  const map = getTeamKeysMap()
  const t = String(teamId)
  const k = String(Number(kid))
  return map?.[t]?.[k] || null
}

function listKids(teamId) {
  const map = getTeamKeysMap()
  const t = String(teamId)
  const kids = Object.keys(map?.[t] || {})
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  return kids
}

function deleteTeamKey(teamId, kid) {
  const t = String(teamId)
  const k = String(Number(kid))
  if (!t) throw new Error('Missing teamId')
  if (!k || k === 'NaN') throw new Error('Invalid kid')

  const map = getTeamKeysMap()
  if (!map?.[t]?.[k]) return false
  delete map[t][k]
  // Clean up empty team bucket
  if (map[t] && Object.keys(map[t]).length === 0) delete map[t]
  writeJson(LS_KEYS, map)
  return true
}

// -----------------------------
// Comms active key slot
// -----------------------------

// Returns { kid:number, keyB64Url:string, importedAt:number, teamId?:string } | null
function getCommsActiveKey() {
  const obj = readJson(LS_COMMS_ACTIVE_KEY, null)
  if (!obj || typeof obj !== 'object') return null
  const kid = Number(obj.kid)
  const keyB64Url = String(obj.keyB64Url || '')
  if (!Number.isFinite(kid) || kid <= 0) return null
  if (!keyB64Url) return null
  const importedAt = Number(obj.importedAt || 0)
  const teamId = obj.teamId ? String(obj.teamId) : undefined
  return { kid, keyB64Url, importedAt: Number.isFinite(importedAt) ? importedAt : 0, teamId }
}

function setCommsActiveKey(k) {
  if (!k) throw new Error('Missing key')
  const kid = Number(k.kid)
  const keyB64Url = String(k.keyB64Url || '')
  if (!Number.isFinite(kid) || kid <= 0) throw new Error('Invalid KID')
  if (!keyB64Url) throw new Error('Missing key')

  writeJson(LS_COMMS_ACTIVE_KEY, {
    kid,
    keyB64Url,
    importedAt: Date.now(),
    teamId: k.teamId ? String(k.teamId) : undefined,
  })
}

function clearCommsActiveKey() {
  localStorage.removeItem(LS_COMMS_ACTIVE_KEY)
}

// Make available to non-module scripts (XCOM loads via <script> not ESM).
try {
  globalThis.getActiveTeamId = getActiveTeamId
  globalThis.setActiveTeamId = setActiveTeamId
  globalThis.getActiveKid = getActiveKid
  globalThis.setActiveKid = setActiveKid
  globalThis.getTeamKeysMap = getTeamKeysMap
  globalThis.putTeamKey = putTeamKey
  globalThis.getTeamKey = getTeamKey
  globalThis.listKids = listKids
  globalThis.deleteTeamKey = deleteTeamKey

  globalThis.getCommsActiveKey = getCommsActiveKey
  globalThis.setCommsActiveKey = setCommsActiveKey
  globalThis.clearCommsActiveKey = clearCommsActiveKey
} catch (_) {
  // ignore
}
