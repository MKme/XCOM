// XTOC-compatible SECURE helpers (v1/v2 payload format) for vanilla XCOM.
//
// This expects `NobleCiphers` global to exist (from assets/vendor/noble-ciphers.iife.min.js)
//   NobleCiphers.xchacha20poly1305(key, nonce, aad)
//   NobleCiphers.chacha20poly1305(key, nonce, aad)

// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

const SECURE_VERSION = 1
const SECURE_VERSION_COMPACT = 2

function makeSecureAad(version, templateId, mode, id, part, total, kid) {
  const s = `${version}|${templateId}|${mode}|${id}|${part}|${total}|${kid}`
  return new TextEncoder().encode(s)
}

function getNoble() {
  const n = globalThis.NobleCiphers
  if (!n) throw new Error('Missing NobleCiphers global. Load assets/vendor/noble-ciphers.iife.min.js first.')
  return n
}

function randomBytes(len) {
  const out = new Uint8Array(len)
  crypto.getRandomValues(out)
  return out
}

function generateTeamKeyB64Url() {
  return encodeBase64Url(randomBytes(32))
}

function encodeSecurePayloadV1(plaintext, keyB64Url, aad) {
  const key = decodeBase64Url(keyB64Url)
  if (key.length !== 32) throw new Error('Team key must be 32 bytes')
  const nonce = randomBytes(24)
  const { xchacha20poly1305 } = getNoble()
  const aead = xchacha20poly1305(key, nonce, aad)
  const ciphertext = aead.encrypt(plaintext)

  const out = new Uint8Array(1 + nonce.length + ciphertext.length)
  out[0] = SECURE_VERSION
  out.set(nonce, 1)
  out.set(ciphertext, 1 + nonce.length)
  return encodeBase64Url(out)
}

function encodeSecurePayloadV2Compact(plaintext, keyB64Url, aad) {
  const key = decodeBase64Url(keyB64Url)
  if (key.length !== 32) throw new Error('Team key must be 32 bytes')
  const nonce = randomBytes(12)
  const { chacha20poly1305 } = getNoble()
  const aead = chacha20poly1305(key, nonce, aad)
  const ciphertext = aead.encrypt(plaintext)

  const out = new Uint8Array(1 + nonce.length + ciphertext.length)
  out[0] = SECURE_VERSION_COMPACT
  out.set(nonce, 1)
  out.set(ciphertext, 1 + nonce.length)
  return encodeBase64Url(out)
}

function decodeSecurePayload(payloadB64Url, keyB64Url, aad) {
  const bytes = decodeBase64Url(payloadB64Url)
  if (bytes.length < 1 + 12 + 16) throw new Error('Secure payload too short')

  const ver = bytes[0]
  const key = decodeBase64Url(keyB64Url)
  if (key.length !== 32) throw new Error('Team key must be 32 bytes')
  const n = getNoble()

  if (ver === SECURE_VERSION) {
    if (bytes.length < 1 + 24 + 16) throw new Error('Secure payload too short')
    const nonce = bytes.subarray(1, 25)
    const ciphertext = bytes.subarray(25)
    const aead = n.xchacha20poly1305(key, nonce, aad)
    return aead.decrypt(ciphertext)
  }
  if (ver === SECURE_VERSION_COMPACT) {
    const nonce = bytes.subarray(1, 13)
    const ciphertext = bytes.subarray(13)
    const aead = n.chacha20poly1305(key, nonce, aad)
    return aead.decrypt(ciphertext)
  }
  throw new Error(`Unsupported secure payload version ${ver}`)
}

// Make available to non-module scripts.
try {
  globalThis.makeSecureAad = makeSecureAad
  globalThis.generateTeamKeyB64Url = generateTeamKeyB64Url
  globalThis.encodeSecurePayloadV1 = encodeSecurePayloadV1
  globalThis.encodeSecurePayloadV2Compact = encodeSecurePayloadV2Compact
  globalThis.decodeSecurePayload = decodeSecurePayload
} catch (_) {
  // ignore
}

// Make available to non-module scripts (XCOM loads via <script> not ESM).
try {
  globalThis.makeSecureAad = makeSecureAad
  globalThis.encodeSecurePayloadV1 = encodeSecurePayloadV1
  globalThis.encodeSecurePayloadV2Compact = encodeSecurePayloadV2Compact
  globalThis.decodeSecurePayload = decodeSecurePayload
  globalThis.generateTeamKeyB64Url = generateTeamKeyB64Url
} catch (_) {
  // ignore
}
