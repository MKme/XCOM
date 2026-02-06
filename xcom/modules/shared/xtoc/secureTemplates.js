// XTOC-compatible secure template helpers for XCOM.
//
// In XTOC, SECURE packets encrypt/decrypt the SAME underlying binary payload
// used by CLEAR templates.
//
// This file mirrors: xtoc-web/src/core/secureTemplates.ts
//
// IMPORTANT: XCOM loads this file via dynamic <script> injection (classic script,
// not ESM). So we must NOT use `import` / `export` here.

function getTemplatePlainBytes(templateId, data) {
  if (typeof globalThis.decodeBase64Url !== 'function') throw new Error('decodeBase64Url not loaded')

  // The encode*Clear functions return base64url of template bytes.
  if (templateId === 4) return globalThis.decodeBase64Url(globalThis.encodeCheckinLocClear(data))
  if (templateId === 1) return globalThis.decodeBase64Url(globalThis.encodeSitrepClear(data))
  if (templateId === 2) return globalThis.decodeBase64Url(globalThis.encodeContactClear(data))
  if (templateId === 3) return globalThis.decodeBase64Url(globalThis.encodeTaskClear(data))
  if (templateId === 5) return globalThis.decodeBase64Url(globalThis.encodeResourceClear(data))
  if (templateId === 6) return globalThis.decodeBase64Url(globalThis.encodeAssetClear(data))
  if (templateId === 7) return globalThis.decodeBase64Url(globalThis.encodeZoneClear(data))
  throw new Error(`Unsupported templateId ${templateId}`)
}

function decodeTemplatePlainBytes(templateId, bytes) {
  if (typeof globalThis.encodeBase64Url !== 'function') throw new Error('encodeBase64Url not loaded')
  const b64 = globalThis.encodeBase64Url(bytes)
  if (templateId === 4) return globalThis.decodeCheckinLocClear(b64)
  if (templateId === 1) return globalThis.decodeSitrepClear(b64)
  if (templateId === 2) return globalThis.decodeContactClear(b64)
  if (templateId === 3) return globalThis.decodeTaskClear(b64)
  if (templateId === 5) return globalThis.decodeResourceClear(b64)
  if (templateId === 6) return globalThis.decodeAssetClear(b64)
  if (templateId === 7) return globalThis.decodeZoneClear(b64)
  throw new Error(`Unsupported templateId ${templateId}`)
}

// Make available to non-module scripts (XCOM loads via <script> not ESM).
try {
  globalThis.getTemplatePlainBytes = getTemplatePlainBytes
  globalThis.decodeTemplatePlainBytes = decodeTemplatePlainBytes
} catch (_) {
  // ignore
}
