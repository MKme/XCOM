// XTOC auto-ingest (XCOM)
// - Watches incoming Mesh + MANET (HaLow) traffic
// - Decodes XTOC packet wrappers
// - Stores into IndexedDB packet store (modules/shared/xtoc/packetStore.js)
// - Auto-imports geo packets to the Map "Imported" overlay (modules/shared/xtoc/importedPackets.js)
//
// NOTE: XCOM loads scripts as classic <script> (not ESM). Avoid export/import.

(() => {
  if (typeof globalThis.xcomAutoIngestXtocPacketText === 'function') return

  const BUFFER_TTL_MS = 15 * 60 * 1000
  const buffers = new Map()

  function nowMs() {
    return Date.now()
  }

  function templateName(templateId) {
    const t = Number(templateId)
    switch (t) {
      case 1: return 'SITREP'
      case 2: return 'CONTACT'
      case 3: return 'TASK'
      case 4: return 'CHECKIN/LOC'
      case 5: return 'RESOURCE'
      case 6: return 'ASSET'
      case 7: return 'ZONE'
      case 8: return 'MISSION'
      default: return `T=${String(templateId)}`
    }
  }

  function makePacketStoreKey(wrapper) {
    const tpl = Number(wrapper?.templateId) || 0
    const mode = wrapper?.mode === 'S' ? 'S' : 'C'
    const id = String(wrapper?.id || '').trim()
    const kid = mode === 'S' ? Number(wrapper?.kid) : undefined
    if (mode === 'S' && Number.isFinite(kid)) return `X1:${tpl}:${mode}:${id}:${kid}`
    return `X1:${tpl}:${mode}:${id}`
  }

  function getCommsActiveKeySafe() {
    try {
      if (typeof globalThis.getCommsActiveKey === 'function') return globalThis.getCommsActiveKey()
    } catch (_) {
      // ignore
    }
    // Fallback: read localStorage directly (works even if storage.js is not loaded).
    try {
      const raw = localStorage.getItem('xcom.xtoc.commsActiveKey')
      if (!raw) return null
      const obj = JSON.parse(raw)
      if (!obj || typeof obj !== 'object') return null
      const kid = Number(obj.kid)
      const keyB64Url = String(obj.keyB64Url || '')
      if (!Number.isFinite(kid) || kid <= 0) return null
      if (!keyB64Url) return null
      const importedAt = Number(obj.importedAt || 0)
      const teamId = obj.teamId ? String(obj.teamId) : undefined
      return { kid, keyB64Url, importedAt: Number.isFinite(importedAt) ? importedAt : 0, teamId }
    } catch (_) {
      return null
    }
  }

  function getTeamKeysMapSafe() {
    try {
      if (typeof globalThis.getTeamKeysMap === 'function') return globalThis.getTeamKeysMap()
    } catch (_) {
      // ignore
    }
    // Fallback: read localStorage directly.
    try {
      const raw = localStorage.getItem('xcom.xtoc.teamKeys')
      if (!raw) return {}
      const obj = JSON.parse(raw)
      return obj && typeof obj === 'object' ? obj : {}
    } catch (_) {
      return {}
    }
  }

  function keyStatusForWrapper(wrapper) {
    try {
      const mode = wrapper?.mode === 'S' ? 'S' : 'C'
      if (mode !== 'S') return {}
      const packetKid = Number(wrapper?.kid)
      if (!Number.isFinite(packetKid) || packetKid <= 0) return {}

      const activeKey = getCommsActiveKeySafe()
      const activeKid = activeKey ? Number(activeKey.kid) : NaN
      if (!Number.isFinite(activeKid) || activeKid <= 0) return {}

      if (packetKid === activeKid) return {}
      return { nonActiveKey: true, activeKidAtStore: activeKid }
    } catch (_) {
      return {}
    }
  }

  function packetAtFromDecoded(wrapper, decodedObj) {
    try {
      const tpl = Number(wrapper?.templateId) || 0
      if (!decodedObj || typeof decodedObj !== 'object') return null
      const n = tpl === 8 ? Number(decodedObj?.updatedAt) : Number(decodedObj?.t)
      return Number.isFinite(n) && n > 0 ? n : null
    } catch (_) {
      return null
    }
  }

  function circleToPolygon(centerLat, centerLon, radiusM, steps = 64) {
    const lat = Number(centerLat)
    const lon = Number(centerLon)
    const r = Math.max(0, Number(radiusM) || 0)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(r) || r <= 0) return null

    const R = 6378137
    const latRad = (lat * Math.PI) / 180
    const angDist = r / R

    const coords = []
    const n = Math.max(12, Math.min(180, Math.floor(Number(steps) || 64)))
    for (let i = 0; i < n; i++) {
      const brng = (i / n) * 2 * Math.PI
      const sinLat = Math.sin(latRad)
      const cosLat = Math.cos(latRad)
      const sinAd = Math.sin(angDist)
      const cosAd = Math.cos(angDist)

      const lat2 = Math.asin(sinLat * cosAd + cosLat * sinAd * Math.cos(brng))
      const lon2 = ((lon * Math.PI) / 180) + Math.atan2(Math.sin(brng) * sinAd * cosLat, cosAd - sinLat * Math.sin(lat2))

      coords.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI])
    }
    if (coords.length) coords.push(coords[0])
    return coords
  }

  function buildImportedFeatures(args) {
    const key = String(args?.key || '')
    const wrapper = args?.wrapper
    const decodedObj = args?.decodedObj
    const summary = String(args?.summary || '').trim()
    const receivedAtRaw = Number(args?.receivedAt || 0)
    const receivedAt = (Number.isFinite(receivedAtRaw) && receivedAtRaw > 0) ? receivedAtRaw : nowMs()

    const t = Number(wrapper?.templateId)
    const mode = wrapper?.mode === 'S' ? 'S' : 'C'
    const packetId = String(wrapper?.id || '').trim()
    const kid = mode === 'S' ? Number(wrapper?.kid) : undefined
    const raw = String(wrapper?.raw || '').trim()

    const packetAt = packetAtFromDecoded(wrapper, decodedObj)

    const baseProps = {
      source: 'imported',
      templateId: Number.isFinite(t) ? t : 0,
      mode,
      packetId,
      kid: Number.isFinite(kid) ? kid : undefined,
      summary,
      note: raw,
      receivedAt,
      ...(packetAt != null ? { packetAt } : {}),
      ...keyStatusForWrapper(wrapper),
    }

    const feats = []

    if (t === 7 && decodedObj && typeof decodedObj === 'object') {
      const z = decodedObj
      const shape = z?.shape
      const threat = Number(z?.threat)
      const meaningCode = Number(z?.meaningCode)
      const label = z?.label ? String(z.label).trim() : ''
      const zNote = z?.note ? String(z.note).trim() : ''

      const zoneProps = {
        ...baseProps,
        kind: 'zone',
        threat: Number.isFinite(threat) ? threat : undefined,
        meaningCode: Number.isFinite(meaningCode) ? meaningCode : undefined,
        label: label || undefined,
        note: zNote || baseProps.note,
      }

      if (shape && shape.kind === 'circle' && Number.isFinite(shape.centerLat) && Number.isFinite(shape.centerLon) && Number.isFinite(shape.radiusM)) {
        const ring = circleToPolygon(shape.centerLat, shape.centerLon, shape.radiusM, 72)
        if (Array.isArray(ring) && ring.length >= 4) {
          feats.push({
            type: 'Feature',
            id: `imported:${key}:zone`,
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: zoneProps,
          })
        }
        feats.push({
          type: 'Feature',
          id: `imported:${key}:zoneCenter`,
          geometry: { type: 'Point', coordinates: [Number(shape.centerLon), Number(shape.centerLat)] },
          properties: { ...zoneProps, kind: 'zoneCenter' },
        })
        return feats
      }

      if (shape && (shape.kind === 'poly' || shape.kind === 'polygon')) {
        const pts = Array.isArray(shape.points) ? shape.points : []
        const ring = pts
          .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
          .map((p) => [Number(p.lon), Number(p.lat)])
        if (ring.length >= 3) {
          ring.push(ring[0])
          feats.push({
            type: 'Feature',
            id: `imported:${key}:zone`,
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: zoneProps,
          })

          const avg = ring.slice(0, -1).reduce((acc, c) => {
            acc.lon += Number(c[0])
            acc.lat += Number(c[1])
            acc.n += 1
            return acc
          }, { lon: 0, lat: 0, n: 0 })
          if (avg.n > 0) {
            feats.push({
              type: 'Feature',
              id: `imported:${key}:zoneCenter`,
              geometry: { type: 'Point', coordinates: [avg.lon / avg.n, avg.lat / avg.n] },
              properties: { ...zoneProps, kind: 'zoneCenter' },
            })
          }
          return feats
        }
      }

      return feats
    }

    if (decodedObj && typeof decodedObj === 'object' && Number.isFinite(decodedObj?.lat) && Number.isFinite(decodedObj?.lon)) {
      feats.push({
        type: 'Feature',
        id: `imported:${key}:loc`,
        geometry: { type: 'Point', coordinates: [Number(decodedObj.lon), Number(decodedObj.lat)] },
        properties: { ...baseProps, kind: 'loc' },
      })
    }

    return feats
  }

  function decodeTemplateClear(templateId, payloadB64Url) {
    switch (Number(templateId)) {
      case 1: return globalThis.decodeSitrepClear(payloadB64Url)
      case 2: return globalThis.decodeContactClear(payloadB64Url)
      case 3: return globalThis.decodeTaskClear(payloadB64Url)
      case 4: return globalThis.decodeCheckinLocClear(payloadB64Url)
      case 5: return globalThis.decodeResourceClear(payloadB64Url)
      case 6: return globalThis.decodeAssetClear(payloadB64Url)
      case 7: return globalThis.decodeZoneClear(payloadB64Url)
      case 8: return globalThis.decodeMissionClear(payloadB64Url)
      default: return { payloadB64Url }
    }
  }

  function findKeyB64UrlForKid(kid) {
    const k = Number(kid)
    if (!Number.isFinite(k) || k <= 0) return null

    // 1) Prefer active key slot
    try {
      const active = getCommsActiveKeySafe()
      if (active && Number(active.kid) === k && active.keyB64Url) return String(active.keyB64Url)
    } catch (_) {
      // ignore
    }

    // 2) Search all stored team keys
    try {
      const map = getTeamKeysMapSafe()
      const kidStr = String(k)
      for (const teamId of Object.keys(map || {})) {
        const rec = map?.[teamId]?.[kidStr]
        if (rec && rec.keyB64Url) return String(rec.keyB64Url)
      }
    } catch (_) {
      // ignore
    }

    return null
  }

  function decodeWrapperBestEffort(wrapper) {
    if (!wrapper) return { decodedObj: null, decodeError: 'Missing wrapper' }

    try {
      if (wrapper.mode === 'C') {
        return { decodedObj: decodeTemplateClear(wrapper.templateId, wrapper.payload), decodeError: '' }
      }

      const kid = Number(wrapper.kid)
      const keyB64Url = findKeyB64UrlForKid(kid)
      if (!keyB64Url) return { decodedObj: null, decodeError: `No key found for KID ${String(wrapper.kid)}. Import the matching XTOC-KEY bundle.` }

      if (typeof globalThis.makeSecureAad !== 'function' || typeof globalThis.decodeSecurePayload !== 'function') {
        return { decodedObj: null, decodeError: 'Secure helpers not loaded' }
      }

      const aad = globalThis.makeSecureAad(wrapper.version || 'X1', wrapper.templateId, 'S', wrapper.id, wrapper.part, wrapper.total, wrapper.kid)
      const plainBytes = globalThis.decodeSecurePayload(wrapper.payload, keyB64Url, aad)

      try {
        if (typeof globalThis.decodeTemplatePlainBytes === 'function') {
          return { decodedObj: globalThis.decodeTemplatePlainBytes(wrapper.templateId, plainBytes), decodeError: '' }
        }
        throw new Error('decodeTemplatePlainBytes not loaded')
      } catch (_) {
        const payloadB64Url = new TextDecoder().decode(plainBytes)
        return { decodedObj: decodeTemplateClear(wrapper.templateId, payloadB64Url), decodeError: '' }
      }
    } catch (e) {
      return { decodedObj: null, decodeError: e?.message ? String(e.message) : String(e) }
    }
  }

  function summaryFromDecoded(wrapper, decoded) {
    const tpl = Number(wrapper?.templateId) || 0
    const isSecure = wrapper?.mode === 'S'

    const priLabel = (n) => {
      const i = Math.max(0, Math.min(3, Math.floor(Number(n) || 0)))
      return ['P1', 'P2', 'P3', 'UNK'][i] || 'UNK'
    }
    const statusLabel = (n) => {
      const i = Math.max(0, Math.min(3, Math.floor(Number(n) || 0)))
      return ['OK', 'HELP', 'RTB', 'UNK'][i] || 'UNK'
    }
    const srcLabel = (d) => {
      const ids = Array.isArray(d?.srcIds) && d.srcIds.length ? d.srcIds : (d?.src != null ? [d.src] : [])
      const out = []
      const seen = new Set()
      for (const v of ids) {
        const n = Math.floor(Number(v))
        if (!Number.isFinite(n) || n <= 0) continue
        if (seen.has(n)) continue
        seen.add(n)
        out.push(n)
      }
      return out.length ? out.map((n) => `U${n}`).join(',') : ''
    }

    if (tpl === 4) {
      const unitId = Number(decoded?.unitId)
      const unitIds = Array.isArray(decoded?.unitIds) && decoded.unitIds.length
        ? decoded.unitIds
        : (Number.isFinite(unitId) ? [unitId] : [])
      const unitsLabel = unitIds.length ? unitIds.map((n) => `U${n}`).join(',') : ''
      const lat = Number(decoded?.lat)
      const lon = Number(decoded?.lon)
      if (isSecure) return `SECURE CHECKIN ${unitsLabel}`.trim()
      if (Number.isFinite(lat) && Number.isFinite(lon) && unitIds.length) {
        return `CHECKIN ${unitsLabel} ${lat.toFixed(4)},${lon.toFixed(4)}`.trim()
      }
      return `CHECKIN${unitsLabel ? ` ${unitsLabel}` : ''}`.trim()
    }

    if (tpl === 1) {
      const pri = priLabel(decoded?.pri)
      const st = statusLabel(decoded?.status)
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const dst = Number(decoded?.dst)
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `${pri} ${st} FROM${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} TO ${dst === 0 ? 'ALL' : `U${Number.isFinite(dst) ? dst : ''}`}`.trim()
      if (isSecure) return `SECURE ${head}`.trim()
      if (note) return `${head} — ${note}`.trim()
      return head
    }

    if (tpl === 2) {
      const pri = priLabel(decoded?.pri)
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const typeCode = Number(decoded?.typeCode)
      const count = Number(decoded?.count)
      const dir = Number(decoded?.dir)
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `${pri} CONTACT${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} type=${Number.isFinite(typeCode) ? typeCode : ''} ct=${Number.isFinite(count) ? count : ''} dir=${Number.isFinite(dir) ? (dir * 10) : ''}°`.trim()
      if (isSecure) return `SECURE ${head}`.trim()
      if (note) return `${head} — ${note}`.trim()
      return head
    }

    if (tpl === 3) {
      const pri = priLabel(decoded?.pri)
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const dst = Number(decoded?.dst)
      const actionCode = Number(decoded?.actionCode)
      const dueMins = Number(decoded?.dueMins)
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `${pri} TASK${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} -> ${dst === 0 ? 'ALL' : `U${Number.isFinite(dst) ? dst : ''}`} act=${Number.isFinite(actionCode) ? actionCode : ''} due=${Number.isFinite(dueMins) ? `${dueMins}m` : ''}`.trim()
      if (isSecure) return `SECURE ${head}`.trim()
      if (note) return `${head} — ${note}`.trim()
      return head
    }

    if (tpl === 5) {
      const pri = priLabel(decoded?.pri)
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const itemCode = Number(decoded?.itemCode)
      const qty = Number(decoded?.qty)
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `${pri} REQ${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} item=${Number.isFinite(itemCode) ? itemCode : ''} qty=${Number.isFinite(qty) ? qty : ''}`.trim()
      if (isSecure) return `SECURE ${head}`.trim()
      if (note) return `${head} — ${note}`.trim()
      return head
    }

    if (tpl === 6) {
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)
      const condition = Number(decoded?.condition)
      const typeCode = Number(decoded?.typeCode)
      const label = String(decoded?.label || '').trim()
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const head = `ASSET${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} cond=${Number.isFinite(condition) ? condition : ''} type=${Number.isFinite(typeCode) ? typeCode : ''}`.trim()
      if (isSecure) return `SECURE ${head}${label ? ` "${label}"` : ''}`.trim()
      return `${head}${label ? ` "${label}"` : ''}${note ? ` — ${note}` : ''}`.trim()
    }

    if (tpl === 7) {
      const threat = Number(decoded?.threat)
      const meaningCode = Number(decoded?.meaningCode)
      const label = String(decoded?.label || '').trim()
      const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
      const src = Number(decoded?.src)
      const from = srcLabel(decoded)

      const threatLabel = ['SAFE', 'DANGER', 'UNKNOWN'][Math.max(0, Math.min(2, Math.floor(threat || 0)))] || 'UNKNOWN'
      const head = `${threatLabel} ZONE${from ? ` ${from}` : Number.isFinite(src) ? ` U${src}` : ''} meaning=${Number.isFinite(meaningCode) ? meaningCode : ''}`.trim()

      if (isSecure) return `SECURE ${head}${label ? ` "${label}"` : ''}`.trim()
      return `${head}${label ? ` "${label}"` : ''}${note ? ` — ${note}` : ''}`.trim()
    }

    if (tpl === 8) {
      const pri = priLabel(decoded?.pri)
      const status = String(decoded?.status || '').trim() || 'PLANNED'
      const missionId = String(decoded?.id || '').trim()
      const title = String(decoded?.title || '').trim()
      const notes = !isSecure && decoded?.notes ? String(decoded.notes).trim() : ''

      const head = `${pri} ${status} MISSION`.trim()
      const mid = missionId ? ` ${missionId}` : ''
      const team = Array.isArray(decoded?.assignedToList)
        ? decoded.assignedToList
        : (decoded?.assignedTo ? [decoded.assignedTo] : [])
      const teamText = team.length ? ` -> ${team.map((n) => `U${Math.floor(Number(n))}`).join(',')}` : ''
      const quotedTitle = (title ? ` "${title}"` : '') + teamText

      if (isSecure) return `SECURE ${head}${mid}${quotedTitle}`.trim()
      return `${head}${mid}${quotedTitle}${notes ? ` — ${notes}` : ''}`.trim()
    }

    const note = !isSecure && decoded?.note ? String(decoded.note).trim() : ''
    return `${isSecure ? 'SECURE ' : ''}${templateName(tpl)}${note ? ` — ${note}` : ''}`.trim()
  }

  function fallbackSummary(wrapper, decodeError) {
    const tpl = templateName(wrapper?.templateId)
    const mode = wrapper?.mode === 'S' ? 'SECURE' : 'CLEAR'
    const id = String(wrapper?.id || '').trim()
    const kid = wrapper?.mode === 'S' ? ` KID ${String(wrapper?.kid ?? '')}` : ''
    const err = decodeError ? ` (decode: ${String(decodeError)})` : ''
    return `${tpl} (${mode}) ID ${id}${kid}${err}`.trim()
  }

  function cleanCandidatePacketString(s) {
    const t = String(s || '').trim()
    if (!t) return ''
    const idx = t.indexOf('X1.')
    if (idx < 0) return ''
    let cand = t.slice(idx)
    cand = cand.replace(/[^A-Za-z0-9._/-]+$/g, '')
    return cand
  }

  function extractPacketCandidatesFromText(text) {
    const raw = String(text || '')
    if (!raw.trim()) return []

    const out = []
    for (const line of raw.split(/\r?\n/)) {
      const l = String(line || '').trim()
      if (!l) continue

      const direct = cleanCandidatePacketString(l)
      if (direct.startsWith('X1.')) out.push(direct)

      const tokens = l.split(/\s+/).map((s) => s.trim()).filter(Boolean)
      for (const tok of tokens) {
        const c = cleanCandidatePacketString(tok)
        if (c.startsWith('X1.')) out.push(c)
      }
    }

    const seen = new Set()
    const uniq = []
    for (const s of out) {
      if (seen.has(s)) continue
      seen.add(s)
      uniq.push(s)
    }
    return uniq
  }

  function groupKeyForParsed(p) {
    const tpl = Number(p?.templateId) || 0
    const mode = p?.mode === 'S' ? 'S' : 'C'
    const id = String(p?.id || '').trim()
    const kid = mode === 'S' ? String(Number(p?.kid)) : ''
    return `X1:${tpl}:${mode}:${id}:${kid}`
  }

  function metaMatches(a, b) {
    if (!a || !b) return false
    if (Number(a.templateId) !== Number(b.templateId)) return false
    if (String(a.mode) !== String(b.mode)) return false
    if (String(a.id) !== String(b.id)) return false
    if (Number(a.total) !== Number(b.total)) return false
    if (String(a.mode) === 'S' && Number(a.kid) !== Number(b.kid)) return false
    return true
  }

  function cleanupBuffers(now) {
    if (buffers.size === 0) return
    for (const [k, buf] of Array.from(buffers.entries())) {
      const last = Number(buf?.lastSeenAt || 0)
      if (!last || (now - last) > BUFFER_TTL_MS) buffers.delete(k)
    }
  }

  function reassembleParsedParts(parts) {
    const list = Array.isArray(parts) ? parts.filter(Boolean) : []
    if (!list.length) return { ok: false, reason: 'No parts' }

    // Prefer shared helper if loaded.
    try {
      if (typeof globalThis.reassemblePackets === 'function') {
        const res = globalThis.reassemblePackets(list)
        return res && typeof res === 'object' ? res : { ok: false, reason: 'Reassemble failed' }
      }
    } catch (_) {
      // fall through
    }

    const p0 = list[0]
    const same = list.every(
      (p) =>
        p.version === p0.version &&
        p.templateId === p0.templateId &&
        p.mode === p0.mode &&
        p.id === p0.id &&
        p.total === p0.total &&
        (p0.mode === 'C' ? true : p.kid === p0.kid),
    )
    if (!same) return { ok: false, reason: 'Parts do not match same packet' }

    const total = Number(p0.total) || 1
    const seen = new Map()
    for (const p of list) seen.set(p.part, p)
    for (let i = 1; i <= total; i++) {
      if (!seen.has(i)) return { ok: false, reason: `Missing part ${i}/${total}` }
    }
    const payload = Array.from({ length: total }, (_, i) => seen.get(i + 1).payload).join('')
    const baseHeader = p0.mode === 'C' ? `X1.${p0.templateId}.C.${p0.id}.` : `X1.${p0.templateId}.S.${p0.id}.`
    const kidPart = p0.mode === 'S' ? `${p0.kid}.` : ''
    const packet = p0.mode === 'C' ? `${baseHeader}1/1.${payload}` : `${baseHeader}1/1.${kidPart}${payload}`
    return { ok: true, packet }
  }

  function notifyXtocPacketsUpdated() {
    try {
      globalThis.dispatchEvent(new Event('xcomXtocPacketsUpdated'))
    } catch (_) {
      // ignore
    }
  }

  async function storePacketsToDb(records) {
    if (typeof globalThis.xcomPutXtocPackets === 'function') {
      const res = await globalThis.xcomPutXtocPackets(records, { mergeSources: true })
      if (res?.ok) notifyXtocPacketsUpdated()
      return res
    }
    if (typeof globalThis.xcomPutXtocPacket === 'function') {
      let put = 0
      let skipped = 0
      for (const rec of Array.isArray(records) ? records : []) {
        // eslint-disable-next-line no-await-in-loop
        const res = await globalThis.xcomPutXtocPacket(rec)
        if (res?.ok) put++
        else skipped++
      }
      if (put > 0) notifyXtocPacketsUpdated()
      return { ok: true, put, skipped }
    }
    return { ok: false, reason: 'Packet store helpers not loaded' }
  }

  function maybeEnableImportedOverlay() {
    try {
      if (typeof globalThis.setTacticalMapImportedEnabled === 'function') {
        globalThis.setTacticalMapImportedEnabled(true)
      }
    } catch (_) {
      // ignore
    }
  }

  async function ingestCompleteWrapper(wrapper, opts) {
    const receivedAt = Number(opts?.receivedAt || 0) || nowMs()
    const source = String(opts?.source || 'unknown')

    const storeKey = makePacketStoreKey(wrapper)
    const raw = String(wrapper?.raw || '').trim()

    const decodedRes = decodeWrapperBestEffort(wrapper)
    const decodedObj = decodedRes.decodedObj
    const decodeError = String(decodedRes.decodeError || '').trim()

    const summary = decodedObj ? summaryFromDecoded(wrapper, decodedObj) : fallbackSummary(wrapper, decodeError)
    const feats = decodedObj ? buildImportedFeatures({ key: storeKey, wrapper, decodedObj, summary, receivedAt }) : []
    const hasGeo = feats.length > 0

    const packetAt = decodedObj ? packetAtFromDecoded(wrapper, decodedObj) : null

    const rec = {
      key: storeKey,
      templateId: Number(wrapper?.templateId) || 0,
      mode: wrapper?.mode === 'S' ? 'S' : 'C',
      id: String(wrapper?.id || '').trim(),
      ...(wrapper?.mode === 'S' && Number.isFinite(Number(wrapper?.kid)) ? { kid: Number(wrapper.kid) } : {}),
      ...keyStatusForWrapper(wrapper),
      part: Number(wrapper?.part) || 1,
      total: Number(wrapper?.total) || 1,
      raw,
      storedAt: nowMs(),
      receivedAt,
      ...(packetAt != null ? { packetAt } : {}),
      source,
      summary,
      ...(decodedObj ? { decoded: decodedObj } : {}),
      ...(decodeError ? { decodeError } : {}),
      hasGeo,
      features: feats,
    }

    const overlayEntry = hasGeo
      ? {
          key: storeKey,
          raw,
          templateId: Number(wrapper?.templateId) || 0,
          mode: wrapper?.mode === 'S' ? 'S' : 'C',
          packetId: String(wrapper?.id || '').trim(),
          kid: wrapper?.mode === 'S' ? wrapper?.kid : undefined,
          summary,
          features: feats,
        }
      : null

    return { rec, overlayEntry }
  }

  async function ingestFromText(args) {
    const text = String(args?.text || '')
    const source = String(args?.source || 'unknown')
    const receivedAt = Number(args?.receivedAt || 0) || nowMs()

    const parsePacket = globalThis.parsePacket
    if (typeof parsePacket !== 'function') return { ok: false, reason: 'parsePacket not loaded' }

    const candidates = extractPacketCandidatesFromText(text)
    if (candidates.length === 0) return { ok: true, ingested: 0, imported: 0, skipped: 0 }

    const parsedList = candidates.map((c) => {
      try { return parsePacket(c) } catch (_) { return null }
    }).filter(Boolean)
    if (parsedList.length === 0) return { ok: true, ingested: 0, imported: 0, skipped: 0 }

    cleanupBuffers(receivedAt)

    const complete = []

    for (const p of parsedList) {
      const total = Number(p?.total) || 1
      if (total <= 1) {
        complete.push(p)
        continue
      }

      const gk = groupKeyForParsed(p)
      const meta = { templateId: p.templateId, mode: p.mode, id: p.id, total: p.total, kid: p.kid }
      const existing = buffers.get(gk)
      const buf = existing && metaMatches(existing.meta, meta)
        ? existing
        : { meta, parts: new Map(), lastSeenAt: receivedAt }

      buf.parts.set(Number(p.part) || 1, p)
      buf.lastSeenAt = receivedAt
      buffers.set(gk, buf)

      let isComplete = true
      for (let i = 1; i <= total; i++) {
        if (!buf.parts.has(i)) {
          isComplete = false
          break
        }
      }
      if (!isComplete) continue

      const parts = Array.from({ length: total }, (_v, i) => buf.parts.get(i + 1)).filter(Boolean)
      if (parts.length !== total) continue

      const reas = reassembleParsedParts(parts)
      if (!reas?.ok || !reas.packet) continue

      try {
        const p2 = parsePacket(String(reas.packet))
        if (p2) complete.push(p2)
      } catch (_) {
        // ignore
      }

      buffers.delete(gk)
    }

    if (complete.length === 0) return { ok: true, ingested: 0, imported: 0, skipped: 0 }

    const records = []
    const overlayEntries = []

    for (const w of complete) {
      // eslint-disable-next-line no-await-in-loop
      const built = await ingestCompleteWrapper(w, { source, receivedAt })
      if (built?.rec) records.push(built.rec)
      if (built?.overlayEntry) overlayEntries.push(built.overlayEntry)
    }

    let storedOk = false
    try {
      const storeRes = await storePacketsToDb(records)
      storedOk = !!storeRes?.ok
    } catch (_) {
      storedOk = false
    }

    let imported = 0
    try {
      if (overlayEntries.length) {
        if (typeof globalThis.addImportedPackets === 'function') {
          const r = globalThis.addImportedPackets(overlayEntries)
          imported = Number(r?.added || 0) || 0
        } else if (typeof globalThis.addImportedPacket === 'function') {
          for (const e of overlayEntries) {
            const r = globalThis.addImportedPacket(e)
            if (r?.ok && r?.added) imported++
          }
        }
        // Ensure the overlay is visible when geo packets arrive (even if already present).
        maybeEnableImportedOverlay()
      }
    } catch (_) {
      imported = 0
    }

    // Optional UI hint for field use.
    try {
      if (imported > 0) globalThis.radioApp?.updateStatus?.(`Auto-mapped ${imported} packet(s) from ${source}`)
      else if (storedOk && records.length) globalThis.radioApp?.updateStatus?.(`Stored ${records.length} packet(s) from ${source}`)
    } catch (_) {
      // ignore
    }

    return { ok: true, ingested: records.length, imported, skipped: 0 }
  }

  // Public global used by transports.
  async function xcomAutoIngestXtocPacketText(args) {
    try {
      return await ingestFromText(args)
    } catch (e) {
      return { ok: false, reason: e?.message ? String(e.message) : String(e) }
    }
  }

  try {
    globalThis.xcomAutoIngestXtocPacketText = xcomAutoIngestXtocPacketText
  } catch (_) {
    // ignore
  }
})()
