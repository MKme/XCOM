// XTOC-KEY bundle parsing helpers for XCOM.
// Format: XTOC-KEY.<b64(json)> where json = {v:1, teamId, kid, keyB64Url}
//
// IMPORTANT: XCOM loads this file via dynamic <script> injection (classic script,
// not ESM). So we must NOT use `import` / `export` here.

function parseKeyBundle(text) {
  const t = String(text || '').trim()
  if (!t.startsWith('XTOC-KEY.')) return null
  try {
    const json = atob(t.slice('XTOC-KEY.'.length))
    const obj = JSON.parse(json)
    if (!obj || obj.v !== 1) return null
    if (!obj.teamId || !Number.isFinite(obj.kid) || !obj.keyB64Url) return null
    // Validate base64url-ish if helper is available.
    try {
      if (typeof globalThis.decodeBase64Url === 'function') globalThis.decodeBase64Url(obj.keyB64Url)
    } catch {
      return null
    }
    return {
      v: 1,
      teamId: String(obj.teamId),
      kid: Number(obj.kid),
      keyB64Url: String(obj.keyB64Url),
    }
  } catch {
    return null
  }
}

function makeKeyBundle(teamId, kid, keyB64Url) {
  const b = { v: 1, teamId, kid, keyB64Url }
  return 'XTOC-KEY.' + btoa(JSON.stringify(b))
}

// Make available to non-module scripts (XCOM loads via <script> not ESM).
try {
  globalThis.parseKeyBundle = parseKeyBundle
  globalThis.makeKeyBundle = makeKeyBundle
} catch (_) {
  // ignore
}
