// XTOC-compatible base64url helpers (browser-safe)
// NOTE: XCOM loads scripts as classic <script> (not ESM), so avoid export/import.

function encodeBase64Url(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  const b64 = btoa(binary)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// Make available to non-module scripts (XCOM loads via <script> not ESM).
try {
  globalThis.encodeBase64Url = encodeBase64Url
  globalThis.decodeBase64Url = decodeBase64Url
} catch (_) {
  // ignore
}
