// XTOC-compatible chunking helpers
//
// IMPORTANT: XCOM loads this file via dynamic <script> injection (classic script,
// not ESM). So we must NOT use `import` / `export` here.

function getTransportMaxPacketChars(profile) {
  switch (profile) {
    case 'JS8Call':
      return 50
    case 'APRS':
      return 67
    case 'HamOther':
      return 80
    case 'Voice':
      // Voice relay / TTS spelling. Keep lines short enough for humans to follow.
      return 80
    case 'Winlink':
      return 400
    case 'Meshtastic':
      return 180
    case 'MeshCore':
      // MeshCore text payload max is 160 bytes; keep chunking conservative.
      return 160
    case 'HaLow':
      // IP LAN (HaLow/Open MANET/etc). Chunking generally not required.
      return 50000
    case 'Reticulum':
      // Reticulum MeshChat bridge (keep conservative under bridge max bytes).
      return 320
    case 'Email':
      return 800
    case 'QR':
      return 800
    case 'CopyPaste':
    default:
      return 800
  }
}

function splitStringIntoChunks(s, maxChunkLen) {
  if (maxChunkLen <= 0) return [s]
  if (s.length <= maxChunkLen) return [s]
  const out = []
  for (let i = 0; i < s.length; i += maxChunkLen) out.push(s.slice(i, i + maxChunkLen))
  return out
}

function chunkPacketByMaxChars(parsed, maxPacketChars) {
  const baseHeader =
    parsed.mode === 'C'
      ? `X1.${parsed.templateId}.C.${parsed.id}.`
      : `X1.${parsed.templateId}.S.${parsed.id}.`
  const kidPart = parsed.mode === 'S' ? `${parsed.kid}.` : ''

  const payload = parsed.payload
  let payloadChunkLen = Math.max(1, maxPacketChars - (baseHeader.length + kidPart.length + '1/1.'.length))

  for (let iter = 0; iter < 5; iter++) {
    const parts = splitStringIntoChunks(payload, payloadChunkLen)
    const n = parts.length
    const pnLen = `${n}/${n}.`.length
    const newChunkLen = Math.max(1, maxPacketChars - (baseHeader.length + kidPart.length + pnLen))
    if (newChunkLen === payloadChunkLen) break
    payloadChunkLen = newChunkLen
  }

  const payloadParts = splitStringIntoChunks(payload, payloadChunkLen)
  const total = payloadParts.length
  return payloadParts.map((pay, idx) => {
    const part = idx + 1
    if (parsed.mode === 'C') return `${baseHeader}${part}/${total}.${pay}`
    return `${baseHeader}${part}/${total}.${parsed.kid}.${pay}`
  })
}

function reassemblePackets(parts) {
  if (!parts || parts.length === 0) return { ok: false, reason: 'No parts' }
  const p0 = parts[0]
  const same = parts.every(
    (p) =>
      p.version === p0.version &&
      p.templateId === p0.templateId &&
      p.mode === p0.mode &&
      p.id === p0.id &&
      p.total === p0.total &&
      (p0.mode === 'C' ? true : p.kid === p0.kid),
  )
  if (!same) return { ok: false, reason: 'Parts do not match same packet' }

  const total = p0.total
  const seen = new Map()
  for (const p of parts) seen.set(p.part, p)
  for (let i = 1; i <= total; i++) {
    if (!seen.has(i)) return { ok: false, reason: `Missing part ${i}/${total}` }
  }
  const payload = Array.from({ length: total }, (_, i) => seen.get(i + 1).payload).join('')
  const baseHeader = p0.mode === 'C' ? `X1.${p0.templateId}.C.${p0.id}.` : `X1.${p0.templateId}.S.${p0.id}.`
  const kidPart = p0.mode === 'S' ? `${p0.kid}.` : ''
  const packet = p0.mode === 'C' ? `${baseHeader}1/1.${payload}` : `${baseHeader}1/1.${kidPart}${payload}`
  return { ok: true, packet }
}

// Convenience: accept a multi-line string, parse packets, reassemble.
function reassembleFromMultilineText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const parsePacket = globalThis.parsePacket
  if (typeof parsePacket !== 'function') return { ok: false, reason: 'parsePacket not loaded' }

  const parsedList = lines.map(parsePacket).filter(Boolean)
  if (parsedList.length === 0) return { ok: false, reason: 'No valid packets found' }
  if (parsedList.length === 1 && parsedList[0].total === 1) return { ok: true, packet: parsedList[0].raw, parsed: parsedList[0] }

  const res = reassemblePackets(parsedList)
  if (!res.ok) return res
  const p2 = parsePacket(res.packet)
  if (!p2) return { ok: false, reason: 'Failed to parse reassembled packet' }
  return { ok: true, packet: res.packet, parsed: p2 }
}

// Make available to non-module scripts (XCOM loads via <script> not ESM).
try {
  globalThis.getTransportMaxPacketChars = getTransportMaxPacketChars
  globalThis.chunkPacketByMaxChars = chunkPacketByMaxChars
  globalThis.reassemblePackets = reassemblePackets
  globalThis.reassembleFromMultilineText = reassembleFromMultilineText
} catch (_) {
  // ignore
}
