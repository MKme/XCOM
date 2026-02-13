/**
 * XTOC Data Module (XCOM)
 * - Lists ALL stored XTOC packets (location + non-location)
 * - Uses IndexedDB packet store (modules/shared/xtoc/packetStore.js)
 */

class XtocDataModule {
  constructor() {
    this._packets = []
    this._selectedKey = ''
    this._refreshTimer = null
    this._packetsUpdatedHandler = null
    this.init()
  }

  init() {
    this.render()
    this.bindUi()
    void this.refresh()
    window.radioApp?.updateStatus?.('XTOC Data module loaded')
  }

  templateName(templateId) {
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

  escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  fmtWhen(ts) {
    const n = Number(ts)
    if (!Number.isFinite(n) || n <= 0) return '—'
    try {
      return new Date(n).toLocaleString()
    } catch (_) {
      return '—'
    }
  }

  withRosterLabels(text) {
    const s = String(text ?? '')
    if (!s) return s
    try {
      if (typeof globalThis.xcomWithRosterLabels === 'function') return globalThis.xcomWithRosterLabels(s)
    } catch (_) {
      // ignore
    }
    return s
  }

  // -----------------------------
  // XTOC -> XCOM import
  // -----------------------------

  setImportStatus(text) {
    const el = document.getElementById('xtocDataImportStatus')
    if (el) el.textContent = String(text || '').trim()
  }

  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      try {
        if (file && typeof file.text === 'function') {
          file.text().then(resolve, reject)
          return
        }
      } catch (_) {
        // ignore, fall back to FileReader
      }

      const r = new FileReader()
      r.onerror = () => reject(r.error ?? new Error('Failed to read file'))
      r.onload = () => resolve(String(r.result ?? ''))
      r.readAsText(file)
    })
  }

  parseXtocBackupJson(jsonText) {
    const obj = JSON.parse(String(jsonText || '')) || null
    if (!obj || typeof obj !== 'object') throw new Error('Invalid backup JSON (not an object).')
    if (obj.v !== 1 || obj.app !== 'xtoc') throw new Error('Not an XTOC backup file (expected v=1 app=xtoc).')
    if (!Array.isArray(obj.members) || !Array.isArray(obj.teamKeys) || !Array.isArray(obj.packets)) {
      throw new Error('Invalid XTOC backup file (missing arrays).')
    }
    return obj
  }

  notifyXtocPacketsUpdated() {
    try {
      globalThis.dispatchEvent(new Event('xcomXtocPacketsUpdated'))
    } catch (_) {
      // ignore
    }
  }

  makeXtocPacketStoreKey(wrapper) {
    const tpl = Number(wrapper?.templateId) || 0
    const mode = wrapper?.mode === 'S' ? 'S' : 'C'
    const id = String(wrapper?.id || '').trim()
    const kid = mode === 'S' ? Number(wrapper?.kid) : undefined

    if (mode === 'S' && Number.isFinite(kid)) return `X1:${tpl}:${mode}:${id}:${kid}`
    return `X1:${tpl}:${mode}:${id}`
  }

  keyStatusForWrapper(wrapper) {
    try {
      const mode = wrapper?.mode === 'S' ? 'S' : 'C'
      if (mode !== 'S') return {}

      const packetKid = Number(wrapper?.kid)
      if (!Number.isFinite(packetKid) || packetKid <= 0) return {}

      const activeKey = globalThis.getCommsActiveKey ? globalThis.getCommsActiveKey() : null
      const activeKid = activeKey ? Number(activeKey.kid) : NaN
      if (!Number.isFinite(activeKid) || activeKid <= 0) return {}

      if (packetKid === activeKid) return {}
      return { nonActiveKey: true, activeKidAtStore: activeKid }
    } catch (_) {
      return {}
    }
  }

  packetAtFromDecoded(wrapper, decodedObj) {
    try {
      const tpl = Number(wrapper?.templateId) || 0
      if (!decodedObj || typeof decodedObj !== 'object') return null
      const n = tpl === 8 ? Number(decodedObj?.updatedAt) : Number(decodedObj?.t)
      return Number.isFinite(n) && n > 0 ? n : null
    } catch (_) {
      return null
    }
  }

  circleToPolygon(centerLat, centerLon, radiusM, steps = 64) {
    const lat = Number(centerLat)
    const lon = Number(centerLon)
    const r = Math.max(0, Number(radiusM) || 0)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(r) || r <= 0) return null

    // Lightweight approximation suitable for local map overlays.
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

  buildImportedFeatures(args) {
    const key = String(args?.key || '')
    const wrapper = args?.wrapper
    const decodedObj = args?.decodedObj
    const summary = String(args?.summary || '').trim()
    const receivedAtRaw = Number(args?.receivedAt || 0)
    const receivedAt = (Number.isFinite(receivedAtRaw) && receivedAtRaw > 0) ? receivedAtRaw : Date.now()

    const t = Number(wrapper?.templateId)
    const mode = wrapper?.mode === 'S' ? 'S' : 'C'
    const packetId = String(wrapper?.id || '').trim()
    const kid = mode === 'S' ? Number(wrapper?.kid) : undefined
    const raw = String(wrapper?.raw || '').trim()

    const packetAt = this.packetAtFromDecoded(wrapper, decodedObj)

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
      ...this.keyStatusForWrapper(wrapper),
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
        const ring = this.circleToPolygon(shape.centerLat, shape.centerLon, shape.radiusM, 72)
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

  decodeTemplate(templateId, payloadB64Url) {
    switch (templateId) {
      case 1:
        return globalThis.decodeSitrepClear(payloadB64Url)
      case 2:
        return globalThis.decodeContactClear(payloadB64Url)
      case 3:
        return globalThis.decodeTaskClear(payloadB64Url)
      case 4:
        return globalThis.decodeCheckinLocClear(payloadB64Url)
      case 5:
        return globalThis.decodeResourceClear(payloadB64Url)
      case 6:
        return globalThis.decodeAssetClear(payloadB64Url)
      case 7:
        return globalThis.decodeZoneClear(payloadB64Url)
      case 8:
        return globalThis.decodeMissionClear(payloadB64Url)
      default:
        return { payloadB64Url }
    }
  }

  decodeParsedWrapper(parsed) {
    if (!parsed) throw new Error('No packet selected')

    if (parsed.mode === 'C') {
      return this.decodeTemplate(parsed.templateId, parsed.payload)
    }

    // SECURE: decrypt to get underlying template bytes, then decode.
    let key = null

    // 1) Prefer the ACTIVE key slot (XCOM Comms model)
    if (globalThis.getCommsActiveKey) {
      const activeKey = globalThis.getCommsActiveKey()
      if (activeKey && activeKey.kid === parsed.kid) key = { keyB64Url: activeKey.keyB64Url }
    }

    // 2) Fallback: search all stored team keys by KID
    if (!key && globalThis.getTeamKeysMap) {
      const map = globalThis.getTeamKeysMap()
      const kidStr = String(Number(parsed.kid))
      for (const team of Object.keys(map || {})) {
        const rec = map?.[team]?.[kidStr]
        if (rec && rec.keyB64Url) {
          key = { keyB64Url: rec.keyB64Url }
          break
        }
      }
    }

    if (!key) throw new Error(`No key found for KID ${parsed.kid}. Import the matching key bundle or backup.`)
    const aad = globalThis.makeSecureAad('X1', parsed.templateId, 'S', parsed.id, parsed.part, parsed.total, parsed.kid)
    const plainBytes = globalThis.decodeSecurePayload(parsed.payload, key.keyB64Url, aad)

    // Prefer XTOC canonical behavior if helper is present.
    try {
      if (typeof globalThis.decodeTemplatePlainBytes === 'function') {
        return globalThis.decodeTemplatePlainBytes(parsed.templateId, plainBytes)
      }
      throw new Error('decodeTemplatePlainBytes not loaded')
    } catch (_) {
      // Legacy fallback: treat bytes as UTF-8 encoded base64url string.
      const payloadB64Url = new TextDecoder().decode(plainBytes)
      return this.decodeTemplate(parsed.templateId, payloadB64Url)
    }
  }

  async importXtocBackupObject(backup) {
    const members = Array.isArray(backup?.members) ? backup.members : []
    const squads = Array.isArray(backup?.squads) ? backup.squads : []
    const teamKeys = Array.isArray(backup?.teamKeys) ? backup.teamKeys : []
    const packets = Array.isArray(backup?.packets) ? backup.packets : []

    // 0) Squads (optional metadata)
    try {
      if (squads.length && typeof globalThis.xcomUpsertSquads === 'function') {
        globalThis.xcomUpsertSquads(squads, { replace: false })
      }
    } catch (_) {
      // ignore
    }

    // 1) Roster (full member records)
    let rosterTotal = 0
    try {
      if (typeof globalThis.xcomUpsertRosterMembers === 'function') {
        const res = globalThis.xcomUpsertRosterMembers(members, { replace: false })
        if (res?.ok) rosterTotal = Number(res.total || 0) || 0
      }
    } catch (_) {
      rosterTotal = 0
    }

    // 2) Team keys
    let keysImported = 0
    let keysFailed = 0
    if (typeof globalThis.putTeamKey === 'function') {
      for (const k of teamKeys) {
        try {
          const teamId = String(k?.teamId || '').trim()
          const kid = Number(k?.kid)
          const keyB64Url = String(k?.keyB64Url || '').trim()
          if (!teamId || !Number.isFinite(kid) || !keyB64Url) {
            keysFailed++
            continue
          }
          globalThis.putTeamKey(teamId, kid, keyB64Url)
          keysImported++
        } catch (_) {
          keysFailed++
        }
      }
    }

    // If this device has no ACTIVE key yet, try to set one from the imported backup keys.
    // Prefer the backup's ACTIVE KID/teamId when present; otherwise pick the highest KID.
    try {
      const hasActiveKey = (typeof globalThis.getCommsActiveKey === 'function') ? !!globalThis.getCommsActiveKey() : false
      if (!hasActiveKey && keysImported > 0 && typeof globalThis.setCommsActiveKey === 'function') {
        const ls = backup?.localStorage && typeof backup.localStorage === 'object' ? backup.localStorage : null
        const preferredTeamId = ls && typeof ls['xtoc.teamId'] === 'string' ? String(ls['xtoc.teamId']).trim() : ''
        const preferredKidRaw = ls ? Number(ls['xtoc.activeKid']) : NaN
        const preferredKid = Number.isFinite(preferredKidRaw) && preferredKidRaw > 0 ? preferredKidRaw : NaN

        const candidates = []
        for (const k of teamKeys) {
          const teamId = String(k?.teamId || '').trim()
          const kid = Number(k?.kid)
          const keyB64Url = String(k?.keyB64Url || '').trim()
          const createdAt = Number(k?.createdAt || 0) || 0
          if (!teamId || !Number.isFinite(kid) || kid <= 0 || !keyB64Url) continue
          candidates.push({ teamId, kid, keyB64Url, createdAt })
        }

        let chosen = null
        if (preferredTeamId && Number.isFinite(preferredKid)) {
          chosen = candidates.find((c) => c.teamId === preferredTeamId && c.kid === preferredKid) || null
        }
        if (!chosen) {
          const pool = preferredTeamId ? candidates.filter((c) => c.teamId === preferredTeamId) : candidates
          pool.sort((a, b) => (b.kid - a.kid) || (b.createdAt - a.createdAt))
          chosen = pool[0] || null
        }

        if (chosen) {
          globalThis.setCommsActiveKey({ teamId: chosen.teamId, kid: chosen.kid, keyB64Url: chosen.keyB64Url })
        }
      }
    } catch (_) {
      // ignore
    }

    // 3) Packets: store ALL packets in IndexedDB, and add geo packets to the Imported overlay
    let packetsParsed = 0
    let packetsStored = 0
    let packetsStoreSkipped = 0
    let packetsNoGeo = 0
    let markersAdded = 0
    let markersDup = 0
    let zoneDecoded = 0
    let zoneDecodeFailed = 0

    const parse = globalThis.parsePacket
    const canStore = typeof globalThis.xcomPutXtocPackets === 'function'
    const canOverlay = typeof globalThis.addImportedPackets === 'function' || typeof globalThis.addImportedPacket === 'function'

    const toStore = []
    const toOverlay = []

    for (const rec of packets) {
      const raw = String(rec?.raw || '').trim()
      if (!raw) continue
      if (typeof parse !== 'function') continue
      const wrapper = parse(raw)
      if (!wrapper) continue
      packetsParsed++

      const key = this.makeXtocPacketStoreKey(wrapper)
      const receivedAt = Number(rec?.createdAt || 0) || Number(backup?.exportedAt || 0) || Date.now()
      const summaryFromBackup = String(rec?.summary || '').trim()
      let summary = summaryFromBackup
      if (!summary) {
        const modeLabel = wrapper?.mode === 'S' ? 'SECURE' : 'CLEAR'
        summary = `${this.templateName(wrapper?.templateId)} (${modeLabel}) ID ${String(wrapper?.id || '').trim()}`.trim()
      }

      let decodedObj = null
      let decodeError = ''
      let features = []
      let hasGeo = false

      // Zones require decode to get geometry.
      if (Number(wrapper?.templateId) === 7) {
        try {
          decodedObj = this.decodeParsedWrapper(wrapper)
          zoneDecoded++
          features = this.buildImportedFeatures({ key, wrapper, decodedObj, summary, receivedAt })
          hasGeo = Array.isArray(features) && features.length > 0

          // Improve summary if backup didn't include one.
          if (!summaryFromBackup) {
            try {
              const threat = Number(decodedObj?.threat)
              const threatLabel = ['SAFE', 'DANGER', 'UNKNOWN'][Math.max(0, Math.min(2, Math.floor(threat || 0)))] || 'UNKNOWN'
              const meaningCode = Number(decodedObj?.meaningCode)
              const label = decodedObj?.label ? String(decodedObj.label).trim() : ''
              const meaningText = Number.isFinite(meaningCode) ? ` meaning=${meaningCode}` : ''
              summary = `${wrapper?.mode === 'S' ? 'SECURE ' : ''}${threatLabel} ZONE${meaningText}${label ? ` \"${label}\"` : ''}`.trim()
            } catch (_) {
              // ignore
            }
          }
        } catch (e) {
          zoneDecodeFailed++
          decodeError = e?.message ? String(e.message) : String(e)
          features = []
          hasGeo = false
        }
      } else {
        // Location-bearing templates: use the lat/lon that XTOC already normalized into the backup record.
        const lat = Number(rec?.lat)
        const lon = Number(rec?.lon)
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          hasGeo = true
          const mode = wrapper?.mode === 'S' ? 'S' : 'C'
          const kid = mode === 'S' ? Number(wrapper?.kid) : undefined
          const baseProps = {
            source: 'imported',
            templateId: Number(wrapper?.templateId) || 0,
            mode,
            packetId: String(wrapper?.id || '').trim(),
            kid: Number.isFinite(kid) ? kid : undefined,
            summary,
            note: raw,
            receivedAt,
            ...this.keyStatusForWrapper(wrapper),
          }
          features = [
            {
              type: 'Feature',
              id: `imported:${key}:loc`,
              geometry: { type: 'Point', coordinates: [lon, lat] },
              properties: { ...baseProps, kind: 'loc' },
            },
          ]
        }
      }

      if (!hasGeo) packetsNoGeo++

      // Store packet (even without geo)
      toStore.push({
        key,
        templateId: Number(wrapper?.templateId) || 0,
        mode: wrapper?.mode === 'S' ? 'S' : 'C',
        id: String(wrapper?.id || '').trim(),
        ...(wrapper?.mode === 'S' && Number.isFinite(Number(wrapper?.kid)) ? { kid: Number(wrapper.kid) } : {}),
        ...this.keyStatusForWrapper(wrapper),
        part: Number(wrapper?.part) || 1,
        total: Number(wrapper?.total) || 1,
        raw,
        storedAt: Date.now(),
        receivedAt,
        source: 'xtocBackup',
        summary,
        ...(decodedObj ? { decoded: decodedObj } : {}),
        ...(decodeError ? { decodeError } : {}),
        hasGeo,
        features: Array.isArray(features) ? features : [],
      })

      // Map overlay (Imported) - batch to avoid N localStorage rewrites for large imports.
      if (hasGeo && canOverlay) {
        toOverlay.push({
          key,
          raw,
          templateId: wrapper.templateId,
          mode: wrapper.mode,
          packetId: wrapper.id,
          kid: wrapper.mode === 'S' ? wrapper.kid : undefined,
          summary,
          features,
        })
      }
    }

    if (canOverlay && toOverlay.length > 0) {
      try {
        if (typeof globalThis.addImportedPackets === 'function') {
          const addRes = globalThis.addImportedPackets(toOverlay)
          if (addRes?.ok) {
            markersAdded = Number(addRes.added || 0) || 0
            markersDup = Number(addRes.dup || 0) || 0
          }
        } else if (typeof globalThis.addImportedPacket === 'function') {
          for (const e of toOverlay) {
            try {
              const addRes = globalThis.addImportedPacket(e)
              if (addRes?.ok) {
                if (addRes.added) markersAdded++
                else markersDup++
              }
            } catch (_) {
              // ignore
            }
          }
        }
      } catch (_) {
        // ignore
      }
    }

    if (canStore && toStore.length > 0) {
      const putRes = await globalThis.xcomPutXtocPackets(toStore, { mergeSources: true })
      if (putRes?.ok) {
        packetsStored = Number(putRes.put || 0) || 0
        packetsStoreSkipped = Number(putRes.skipped || 0) || 0
        this.notifyXtocPacketsUpdated()
      } else {
        packetsStored = 0
        packetsStoreSkipped = toStore.length
      }
    }

    return {
      ok: true,
      rosterTotal,
      keysImported,
      keysFailed,
      packetsParsed,
      packetsStored,
      packetsStoreSkipped,
      packetsNoGeo,
      markersAdded,
      markersDup,
      zoneDecoded,
      zoneDecodeFailed,
    }
  }

  async importXtocBackup() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0]
      if (!file) return

      try {
        this.setImportStatus('Importing...')
        const text = await this.readFileAsText(file)
        const backup = this.parseXtocBackupJson(text)
        const res = await this.importXtocBackupObject(backup)

        try { this.updateRosterStatus() } catch (_) { /* ignore */ }
        try { void this.refresh({ keepSelection: true }) } catch (_) { /* ignore */ }

        const msg =
          `Imported XTOC backup: ` +
          `${res.rosterTotal ? `${res.rosterTotal} roster member(s), ` : ''}` +
          `${res.keysImported} key(s), ` +
          `${res.packetsStored || 0} packet(s), ` +
          `${res.markersAdded} marker(s)` +
          `${res.markersDup ? ` (${res.markersDup} already present)` : ''}.`

        this.setImportStatus(msg)
        alert(msg)
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e)
        this.setImportStatus(`Import failed: ${msg}`)
        alert(msg)
      } finally {
        try { input.value = '' } catch (_) { /* ignore */ }
      }
    }, { once: true })

    input.click()
  }

  // -----------------------------
  // Team roster import (XTOC-TEAM bundle)
  // -----------------------------

  parseTeamRosterBundle(text) {
    const t = String(text || '').trim()
    if (!t.startsWith('XTOC-TEAM.')) return null
    try {
      const json = atob(t.slice('XTOC-TEAM.'.length))
      const obj = JSON.parse(json)
      if (obj?.v !== 1) return null
      if (!Array.isArray(obj?.members)) return null
      return obj
    } catch (_) {
      return null
    }
  }

  importTeamRoster(opts = {}) {
    const quiet = !!opts.quiet
    const input = document.getElementById('xtocDataTeamBundle')
    const text = String(input?.value || '').trim()
    if (!text) {
      if (!quiet) alert('Paste an XTOC-TEAM bundle first.')
      return
    }

    const b = this.parseTeamRosterBundle(text)
    if (!b) {
      if (!quiet) alert('Invalid roster bundle. Expected: XTOC-TEAM.<base64(json)>')
      return
    }

    if (typeof globalThis.xcomUpsertRosterMembers !== 'function') {
      if (!quiet) alert('Roster helpers not loaded')
      return
    }

    const res = globalThis.xcomUpsertRosterMembers(b.members, { replace: false })
    if (!res?.ok) {
      if (!quiet) alert(res?.reason || 'Roster import failed')
      return
    }

    // Optional: squad metadata (if provided by XTOC).
    try {
      if (Array.isArray(b?.squads) && typeof globalThis.xcomUpsertSquads === 'function') {
        globalThis.xcomUpsertSquads(b.squads, { replace: false })
      }
    } catch (_) {
      // ignore
    }

    try { input.value = '' } catch (_) { /* ignore */ }
    this.updateRosterStatus()
    if (!quiet) alert(`Imported roster: ${res.total} member(s).`)
  }

  updateRosterStatus() {
    const el = document.getElementById('xtocDataRosterStatus')
    if (!el) return

    if (typeof globalThis.xcomGetTeamRoster !== 'function') {
      el.textContent = 'Roster: helpers not loaded'
      return
    }

    let roster = null
    try { roster = globalThis.xcomGetTeamRoster() } catch (_) { roster = null }
    const members = Array.isArray(roster?.members) ? roster.members : []
    const squads = Array.isArray(roster?.squads) ? roster.squads : []
    const updatedAt = Number(roster?.updatedAt || 0) || 0

    if (members.length === 0) {
      el.textContent = 'Roster: none loaded'
      return
    }

    let when = '—'
    if (updatedAt > 0) {
      try { when = new Date(updatedAt).toLocaleString() } catch (_) { when = '—' }
    }

    const squadText = squads.length ? `, ${squads.length} squad(s)` : ''
    el.textContent = `Roster: ${members.length} member(s)${squadText} loaded (${when})`
  }

  clearRoster() {
    const ok = confirm('Clear roster labels from this device?\n\nThis only removes friendly label mapping (no packets/keys).')
    if (!ok) return

    try {
      if (typeof globalThis.xcomClearTeamRoster === 'function') globalThis.xcomClearTeamRoster()
    } catch (_) {
      // ignore
    }
    this.updateRosterStatus()
  }

  async scanTeamQr() {
    if (!globalThis.QrScanner) {
      alert('QrScanner not loaded')
      return
    }

    const overlay = document.createElement('div')
    overlay.className = 'xtocDataQrOverlay'
    overlay.innerHTML = `
      <div class="xtocDataQrModal">
        <div class="xtocDataQrModalTitle">Scan Team QR</div>
        <video id="xtocDataTeamQrVideo"></video>
        <div class="xtocDataQrActions">
          <button id="xtocDataTeamQrStopBtn" type="button" class="xtocBtn danger">Stop</button>
        </div>
      </div>
    `
    const host = document.getElementById('xtoc-data') || document.body
    host.appendChild(overlay)
    const video = overlay.querySelector('#xtocDataTeamQrVideo')
    const stopBtn = overlay.querySelector('#xtocDataTeamQrStopBtn')

    let scanner = null
    const stop = () => {
      try { scanner && scanner.stop() } catch (_) { /* ignore */ }
      try { overlay.remove() } catch (_) { /* ignore */ }
    }

    try {
      globalThis.QrScanner.WORKER_PATH = 'assets/vendor/qr-scanner-worker.min.js'
      scanner = new globalThis.QrScanner(
        video,
        (result) => {
          const text = (result && result.data) ? result.data : String(result)
          const trimmed = String(text || '').trim()

          if (trimmed.startsWith('XTOC-TEAM.')) {
            document.getElementById('xtocDataTeamBundle').value = trimmed
            try {
              this.importTeamRoster()
            } finally {
              stop()
            }
            return
          }

          if (trimmed.startsWith('XTOC-KEY.')) {
            alert('That looks like a key bundle. Import it under XTOC Comm -> Key Bundle Import.')
            stop()
            return
          }

          if (trimmed.startsWith('X1.')) {
            alert('That looks like an XTOC packet wrapper. Import/decode it under XTOC Comm.')
            stop()
            return
          }

          alert('QR did not look like an XTOC-TEAM roster bundle.')
          stop()
        },
        { returnDetailedScanResult: true },
      )
      await scanner.start()
      stopBtn.addEventListener('click', stop)
    } catch (e) {
      console.error(e)
      stop()
      alert(`QR scan failed: ${e.message || e}`)
    }
  }

  render() {
    const root = document.getElementById('xtoc-data')
    root.innerHTML = `
      <div class="xModuleIntro">
        <div class="xModuleIntroTitle">What you can do here</div>
        <div class="xModuleIntroText">
          Browse and search <strong>all</strong> stored XTOC packets on this device (including non-location packets).
          This is local-first: data is stored in your browser's IndexedDB.
        </div>
      </div>

      <div class="xtocDataCard xtocDataCard--import">
        <div class="xtocDataTitleRow">
          <div class="xtocDataTitle">XTOC -&gt; XCOM Import</div>
        </div>
        <div class="xtocSmallMuted">
          Merges the full roster (prefers <span class="mono">label</span>), SECURE keys (KID), and all XTOC packets into this device.
          Does not wipe existing XCOM data.
        </div>

        <div class="xtocDataImportRow">
          <div class="xtocDataImportRowTitle">
            <div class="xtocDataImportLabel">XTOC Backup (.json)</div>
            <div class="xtocDataActions">
              <button id="xtocDataImportXtocBackupBtn" class="xtocBtn" type="button">Import Backup</button>
            </div>
          </div>
          <div class="xtocSmallMuted">
            Use XTOC Topbar Export (e.g. <span class="mono">xtoc-backup-*.json</span>). XCOM merges roster/keys/packets and ignores XTOC settings/missions/KML layers.
          </div>
          <div class="xtocSmallMuted" id="xtocDataImportStatus"></div>
        </div>

        <div class="xtocDataDivider"></div>

        <div class="xtocDataImportRow">
          <div class="xtocDataImportLabel">Team roster bundle</div>
          <textarea id="xtocDataTeamBundle" class="xtocInput xtocTextarea mono" rows="2" spellcheck="false" placeholder="XTOC-TEAM.&lt;base64(json)&gt;"></textarea>
          <div class="xtocDataActions">
            <button id="xtocDataImportTeamBtn" class="xtocBtn" type="button">Import Team</button>
            <button id="xtocDataScanTeamQrBtn" class="xtocBtn" type="button">Scan Team QR</button>
            <button id="xtocDataClearTeamBtn" class="xtocBtn danger" type="button">Clear</button>
            <button id="xtocDataClearRosterBtn" class="xtocBtn danger" type="button">Clear Roster</button>
          </div>
          <div class="xtocSmallMuted" id="xtocDataRosterStatus">Roster: none loaded</div>
        </div>
      </div>

      <div class="xtocDataShell">
        <div class="xtocDataCard">
          <div class="xtocDataTitleRow">
            <div class="xtocDataTitle">Packets</div>
            <div class="xtocDataActions">
              <button id="xtocDataRefreshBtn" class="xtocBtn" type="button">Refresh</button>
              <button id="xtocDataClearBtn" class="xtocBtn danger" type="button" title="Delete all stored packets from this device">Clear</button>
            </div>
          </div>

          <div class="xtocDataFilters">
            <input id="xtocDataQuery" class="xtocInput" type="text" spellcheck="false" placeholder="Search summary / raw…" />
            <label class="xtocInline">
              <input type="checkbox" id="xtocDataLast7" checked>
              Last 7 days
            </label>
            <label class="xtocInline">
              <input type="checkbox" id="xtocDataGeoOnly">
              Geo only
            </label>
            <select id="xtocDataSource" class="xtocInput" aria-label="Source filter">
              <option value="">All sources</option>
              <option value="xtocBackup">XTOC Backup</option>
              <option value="comms">Comms (import)</option>
              <option value="commsOut">Comms (generated)</option>
              <option value="mesh">Mesh</option>
              <option value="manet">MANET</option>
              <option value="unknown">Unknown</option>
            </select>
            <div class="xtocSmallMuted" id="xtocDataCounts"></div>
          </div>

          <div class="xtocDataTableWrap">
            <table class="xtocDataTable">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Template</th>
                  <th>Mode</th>
                  <th>ID</th>
                  <th>Src</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody id="xtocDataTbody"></tbody>
            </table>
          </div>
        </div>

        <div class="xtocDataCard">
          <div class="xtocDataTitleRow">
            <div class="xtocDataTitle">Details</div>
            <div class="xtocDataActions">
              <button id="xtocDataCopyRawBtn" class="xtocBtn" type="button" disabled>Copy raw</button>
              <button id="xtocDataCopySummaryBtn" class="xtocBtn" type="button" disabled>Copy summary</button>
              <button id="xtocDataImportToMapBtn" class="xtocBtn" type="button" disabled title="Adds this packet's marker/zone to the Map Imported overlay">Import to map</button>
            </div>
          </div>
          <div id="xtocDataDetails" class="xtocDataDetails">
            <div class="xtocSmallMuted">Select a packet to view details.</div>
          </div>
        </div>
      </div>
    `
  }

  bindUi() {
    // Avoid accumulating listeners across module reloads.
    try { if (globalThis.__xcomXtocDataCleanup) globalThis.__xcomXtocDataCleanup() } catch (_) { /* ignore */ }

    const queryEl = document.getElementById('xtocDataQuery')
    const last7El = document.getElementById('xtocDataLast7')
    const geoOnlyEl = document.getElementById('xtocDataGeoOnly')
    const sourceEl = document.getElementById('xtocDataSource')
    const refreshBtn = document.getElementById('xtocDataRefreshBtn')
    const clearBtn = document.getElementById('xtocDataClearBtn')
    const tbody = document.getElementById('xtocDataTbody')
    const copyRawBtn = document.getElementById('xtocDataCopyRawBtn')
    const copySummaryBtn = document.getElementById('xtocDataCopySummaryBtn')
    const importToMapBtn = document.getElementById('xtocDataImportToMapBtn')
    const importBackupBtn = document.getElementById('xtocDataImportXtocBackupBtn')
    const importTeamBtn = document.getElementById('xtocDataImportTeamBtn')
    const scanTeamQrBtn = document.getElementById('xtocDataScanTeamQrBtn')
    const clearTeamBtn = document.getElementById('xtocDataClearTeamBtn')
    const clearRosterBtn = document.getElementById('xtocDataClearRosterBtn')

    const schedule = () => {
      if (this._refreshTimer) clearTimeout(this._refreshTimer)
      this._refreshTimer = setTimeout(() => {
        this._refreshTimer = null
        void this.refresh()
      }, 120)
    }

    queryEl?.addEventListener('input', schedule)
    last7El?.addEventListener('change', () => void this.refresh())
    geoOnlyEl?.addEventListener('change', () => void this.refresh())
    sourceEl?.addEventListener('change', () => void this.refresh())
    refreshBtn?.addEventListener('click', () => void this.refresh())

    clearBtn?.addEventListener('click', async () => {
      const ok = confirm('Delete ALL stored XTOC packets from this device?\n\nThis cannot be undone.')
      if (!ok) return
      if (typeof globalThis.xcomClearXtocPackets !== 'function') {
        alert('Packet store helpers not loaded')
        return
      }
      const res = await globalThis.xcomClearXtocPackets()
      if (!res?.ok) {
        alert(res?.reason || 'Clear failed')
        return
      }
      this._selectedKey = ''
      this.renderDetails(null)
      void this.refresh()
      try { globalThis.dispatchEvent(new Event('xcomXtocPacketsUpdated')) } catch (_) { /* ignore */ }
    })

    importBackupBtn?.addEventListener('click', () => void this.importXtocBackup())
    importTeamBtn?.addEventListener('click', () => this.importTeamRoster())
    scanTeamQrBtn?.addEventListener('click', () => void this.scanTeamQr())
    clearTeamBtn?.addEventListener('click', () => {
      const ta = document.getElementById('xtocDataTeamBundle')
      if (ta) ta.value = ''
    })
    clearRosterBtn?.addEventListener('click', () => this.clearRoster())

    tbody?.addEventListener('click', (e) => {
      const tr = e?.target?.closest?.('tr[data-key]')
      const key = String(tr?.dataset?.key || '').trim()
      if (!key) return
      this._selectedKey = key
      const rec = this._packets.find((p) => String(p?.key || '') === key) || null
      this.renderDetails(rec)
      this.highlightSelectedRow()
    })

    copyRawBtn?.addEventListener('click', async () => {
      const rec = this._packets.find((p) => String(p?.key || '') === this._selectedKey) || null
      const text = String(rec?.raw || '').trim()
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        window.radioApp?.updateStatus?.('Copied raw wrapper')
      } catch (_) {
        alert('Clipboard copy failed (browser permissions).')
      }
    })

    copySummaryBtn?.addEventListener('click', async () => {
      const rec = this._packets.find((p) => String(p?.key || '') === this._selectedKey) || null
      const text = this.withRosterLabels(String(rec?.summary || '').trim())
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        window.radioApp?.updateStatus?.('Copied summary')
      } catch (_) {
        alert('Clipboard copy failed (browser permissions).')
      }
    })

    importToMapBtn?.addEventListener('click', () => {
      const rec = this._packets.find((p) => String(p?.key || '') === this._selectedKey) || null
      if (!rec) return
      const feats = Array.isArray(rec?.features) ? rec.features : []
      if (!feats.length) {
        alert('This packet has no location/zone features to import.')
        return
      }
      if (typeof globalThis.addImportedPacket !== 'function') {
        alert('Map import helpers not loaded (Imported overlay). Open Comms or Map once, then try again.')
        return
      }
      try {
        const res = globalThis.addImportedPacket({
          key: String(rec.key || ''),
          raw: String(rec.raw || ''),
          templateId: Number(rec.templateId) || 0,
          mode: rec.mode === 'S' ? 'S' : 'C',
          packetId: String(rec.id || ''),
          kid: rec.mode === 'S' ? rec.kid : undefined,
          summary: String(rec.summary || ''),
          features: feats,
        })
        if (!res?.ok) throw new Error(res?.reason || 'Import failed')
        try { globalThis.setTacticalMapImportedEnabled && globalThis.setTacticalMapImportedEnabled(true) } catch (_) { /* ignore */ }
        alert(res.added ? 'Imported to map overlay.' : 'Already present on map overlay.')
      } catch (e) {
        alert(e?.message || String(e))
      }
    })

    try {
      if (typeof this.updateRosterStatus === 'function') this.updateRosterStatus()
    } catch (_) {
      // ignore
    }

    // Live update when new packets are stored.
    this._packetsUpdatedHandler = () => {
      // If module is no longer mounted, skip.
      try { if (!document.getElementById('xtoc-data')) return } catch (_) { return }
      void this.refresh({ keepSelection: true })
    }
    try { globalThis.addEventListener('xcomXtocPacketsUpdated', this._packetsUpdatedHandler) } catch (_) { /* ignore */ }

    globalThis.__xcomXtocDataCleanup = () => {
      try { if (this._refreshTimer) clearTimeout(this._refreshTimer) } catch (_) { /* ignore */ }
      this._refreshTimer = null
      try {
        if (this._packetsUpdatedHandler) globalThis.removeEventListener('xcomXtocPacketsUpdated', this._packetsUpdatedHandler)
      } catch (_) {
        // ignore
      }
      this._packetsUpdatedHandler = null
    }
  }

  highlightSelectedRow() {
    const tbody = document.getElementById('xtocDataTbody')
    if (!tbody) return
    for (const tr of Array.from(tbody.querySelectorAll('tr[data-key]'))) {
      const key = String(tr?.dataset?.key || '')
      tr.classList.toggle('selected', key === this._selectedKey)
    }
  }

  renderCounts(total, shown) {
    const el = document.getElementById('xtocDataCounts')
    if (!el) return
    const s = Number(shown || 0) || 0
    if (total == null) {
      el.textContent = `Showing ${s} stored packet(s).`
      return
    }
    const t = Number(total || 0) || 0
    el.textContent = `Showing ${s} of ${t} stored packet(s).`
  }

  async ensurePacketStoreLoaded() {
    if (typeof globalThis.xcomListXtocPackets === 'function') return true

    // Best-effort: attempt to load the packet store script if the module loader is available.
    try {
      if (globalThis.radioApp && typeof globalThis.radioApp.loadScript === 'function') {
        await globalThis.radioApp.loadScript('modules/shared/xtoc/packetStore.js')
      }
    } catch (_) {
      // ignore
    }

    return typeof globalThis.xcomListXtocPackets === 'function'
  }

  renderTable(packets) {
    const tbody = document.getElementById('xtocDataTbody')
    if (!tbody) return

    let trustedMode = false
    try {
      trustedMode = !!(globalThis.getTacticalMapTrustedModeEnabled && globalThis.getTacticalMapTrustedModeEnabled())
    } catch (_) {
      trustedMode = false
    }

    if (!Array.isArray(packets) || packets.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="xtocSmallMuted">No packets found.</td></tr>`
      return
    }

    const rows = packets.map((p) => {
      const when = this.fmtWhen(p?.receivedAt || p?.storedAt)
      const tpl = this.templateName(p?.templateId)
      const mode = String(p?.mode || '').toUpperCase()
      const untrusted = trustedMode && mode !== 'S'
      const id = String(p?.id || '').trim()
      const src = String(p?.source || '').trim()
      const sum = this.withRosterLabels(String(p?.summary || '').trim())
      const kid = (mode === 'S' && Number.isFinite(Number(p?.kid))) ? ` KID ${String(p.kid)}` : ''
      const geo = p?.hasGeo ? `<span class="xtocTag">GEO</span>` : ''
      const keyWarn = p?.nonActiveKey === true ? `<span class="xtocTag xtocTag--warn" title="Received/stored with non-active key">KEY</span>` : ''
      return `
        <tr data-key="${this.escapeHtml(String(p?.key || ''))}" class="${untrusted ? 'xtocDataRow--untrusted' : ''}">
          <td class="mono">${this.escapeHtml(when)}</td>
          <td>${geo}${keyWarn}${this.escapeHtml(tpl)}</td>
          <td class="mono">${this.escapeHtml(mode)}</td>
          <td class="mono">${this.escapeHtml(id)}${this.escapeHtml(kid)}</td>
          <td class="mono">${this.escapeHtml(src)}</td>
          <td>${this.escapeHtml(sum)}</td>
        </tr>
      `
    }).join('')

    tbody.innerHTML = rows
    this.highlightSelectedRow()
  }

  renderDetails(packet) {
    const el = document.getElementById('xtocDataDetails')
    if (!el) return

    const copyRawBtn = document.getElementById('xtocDataCopyRawBtn')
    const copySummaryBtn = document.getElementById('xtocDataCopySummaryBtn')
    const importToMapBtn = document.getElementById('xtocDataImportToMapBtn')

    if (!packet) {
      el.innerHTML = `<div class="xtocSmallMuted">Select a packet to view details.</div>`
      if (copyRawBtn) copyRawBtn.disabled = true
      if (copySummaryBtn) copySummaryBtn.disabled = true
      if (importToMapBtn) importToMapBtn.disabled = true
      return
    }

    if (copyRawBtn) copyRawBtn.disabled = !String(packet?.raw || '').trim()
    if (copySummaryBtn) copySummaryBtn.disabled = !String(packet?.summary || '').trim()
    if (importToMapBtn) importToMapBtn.disabled = !(packet?.hasGeo && Array.isArray(packet?.features) && packet.features.length > 0)

    const tpl = this.templateName(packet?.templateId)
    const mode = String(packet?.mode || '').toUpperCase()
    const id = String(packet?.id || '').trim()
    const kid = (mode === 'S' && Number.isFinite(Number(packet?.kid))) ? `KID ${String(packet.kid)}` : ''
    const src = String(packet?.source || '').trim()
    const when = this.fmtWhen(packet?.receivedAt || packet?.storedAt)
    const summary = this.withRosterLabels(String(packet?.summary || '').trim())
    const raw = String(packet?.raw || '').trim()
    const decodeError = String(packet?.decodeError || '').trim()

    let decodedBlock = ''
    try {
      if (packet?.decoded != null) {
        decodedBlock = `<details class="xtocDetails"><summary>Decoded JSON</summary><pre class="xtocPre">${this.escapeHtml(JSON.stringify(packet.decoded, null, 2))}</pre></details>`
      }
    } catch (_) {
      decodedBlock = ''
    }

    const errHtml = decodeError ? `<div class="xtocWarn">Decode error: ${this.escapeHtml(decodeError)}</div>` : ''

    const nonActiveKey = packet?.nonActiveKey === true
    const activeKidAtStore = Number(packet?.activeKidAtStore)
    const keyWarnHtml = (mode === 'S' && nonActiveKey)
      ? `<div class="xtocWarn">Non-active key: packet KID ${this.escapeHtml(String(packet?.kid ?? ''))}${(Number.isFinite(activeKidAtStore) && activeKidAtStore > 0) ? ` while ACTIVE KID was ${this.escapeHtml(String(activeKidAtStore))}` : ''}. Team may need a key update.</div>`
      : ''

    el.innerHTML = `
      <div class="xtocKv">
        <div><span class="muted">When:</span> ${this.escapeHtml(when)}</div>
        <div><span class="muted">Template:</span> ${this.escapeHtml(tpl)}</div>
        <div><span class="muted">Mode:</span> ${this.escapeHtml(mode)}</div>
        <div><span class="muted">ID:</span> <span class="mono">${this.escapeHtml(id)}</span></div>
        ${kid ? `<div><span class="muted">Key:</span> <span class="mono">${this.escapeHtml(kid)}</span></div>` : ''}
        ${src ? `<div><span class="muted">Source:</span> <span class="mono">${this.escapeHtml(src)}</span></div>` : ''}
      </div>

      ${summary ? `<div class="xtocSummary">${this.escapeHtml(summary)}</div>` : ''}
      ${keyWarnHtml}
      ${errHtml}

      <details class="xtocDetails" open>
        <summary>Raw wrapper</summary>
        <pre class="xtocPre">${this.escapeHtml(raw)}</pre>
      </details>

      ${decodedBlock}
    `
  }

  async refresh(opts = {}) {
    const keepSelection = opts.keepSelection === true

    const countsEl = document.getElementById('xtocDataCounts')
    if (countsEl) countsEl.textContent = 'Loading…'

    const hasStore = await this.ensurePacketStoreLoaded()

    if (!hasStore) {
      this._packets = []
      this.renderTable([])
      this.renderCounts(null, 0)
      const details = document.getElementById('xtocDataDetails')
      if (details) {
        details.innerHTML = `
          <div class="xtocWarn">
            Packet store helpers not loaded for this module.
            <div class="xtocSmallMuted" style="margin-top:8px">
              This can happen after an update if the app cache is out of sync.
              Try <strong>Update</strong> (top bar) or <strong>Backup &rarr; Repair app cache</strong>.
            </div>
            <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap">
              <button id="xtocDataRetryBtn" class="xtocBtn" type="button">Retry</button>
              <button id="xtocDataRepairBtn" class="xtocBtn danger" type="button">Repair app cache</button>
            </div>
          </div>
        `

        const retryBtn = document.getElementById('xtocDataRetryBtn')
        if (retryBtn) retryBtn.addEventListener('click', () => void this.refresh({ keepSelection: true }), { once: true })

        const repairBtn = document.getElementById('xtocDataRepairBtn')
        if (repairBtn) {
          repairBtn.addEventListener(
            'click',
            () => {
              if (typeof globalThis.xcomRepairAppShell === 'function') {
                globalThis.xcomRepairAppShell()
              } else {
                alert('Repair function not available in this build')
              }
            },
            { once: true },
          )
        }
      }
      return
    }

    const query = String(document.getElementById('xtocDataQuery')?.value || '').trim()
    const last7 = !!document.getElementById('xtocDataLast7')?.checked
    const geoOnly = !!document.getElementById('xtocDataGeoOnly')?.checked
    const source = String(document.getElementById('xtocDataSource')?.value || '').trim()

    const sinceMs = last7 ? (Date.now() - (7 * 24 * 60 * 60 * 1000)) : null

    let listRes = null
    try {
      listRes = await globalThis.xcomListXtocPackets({
        limit: 2000,
        ...(sinceMs ? { sinceMs } : {}),
        ...(query ? { query } : {}),
        ...(source ? { source } : {}),
        ...(geoOnly ? { hasGeo: true } : {}),
      })
    } catch (e) {
      const msg = e?.message ? String(e.message) : String(e)
      const details = document.getElementById('xtocDataDetails')
      if (details) details.innerHTML = `<div class="xtocWarn">Failed to read packet store: ${this.escapeHtml(msg)}</div>`
      this._packets = []
      this.renderTable([])
      this.renderCounts(null, 0)
      return
    }

    let countRes = null
    try {
      if (typeof globalThis.xcomCountXtocPackets === 'function') {
        countRes = await globalThis.xcomCountXtocPackets()
      }
    } catch (_) {
      countRes = null
    }

    const packets = (listRes && listRes.ok && Array.isArray(listRes.packets)) ? listRes.packets : []
    const total = (countRes && countRes.ok) ? Number(countRes.count || 0) || 0 : null

    this._packets = packets
    this.renderTable(packets)
    this.renderCounts(total, packets.length)

    if (!keepSelection) {
      this._selectedKey = ''
      this.renderDetails(null)
      return
    }

    // Keep existing selection if still present.
    const found = this._packets.find((p) => String(p?.key || '') === this._selectedKey) || null
    if (found) this.renderDetails(found)
    else {
      this._selectedKey = ''
      this.renderDetails(null)
    }
  }
}
