// XCOM Callsign DB Worker
// Loads the large offline callsign dataset and serves lookup/suggest requests without
// blocking the UI thread.
//
// This worker expects `assets/data/callsigns.json` to be present on the same origin.
// It intentionally does NOT try to load `callsigns.js` (which is `window.*`-scoped).

(function () {
  'use strict'

  const STATE = {
    loaded: false,
    loading: false,
    loadPromise: null,
    meta: null,
    records: null,
    lookup: null,
    prefixIndex: null,
  }

  function post(msg) {
    try {
      self.postMessage(msg)
    } catch {
      // ignore
    }
  }

  function sendProgress(phase, payload = {}) {
    post({ type: 'CALLSIGN_DB_PROGRESS', phase, ...payload })
  }

  function sendResponse(requestId, ok, payload = {}) {
    post({ type: 'CALLSIGN_DB_RESPONSE', requestId, ok, ...payload })
  }

  function defaultDataUrl() {
    try {
      // Worker is hosted under /modules/shared/, so ../../assets/... resolves correctly
      // even when XCOM is hosted from a subfolder.
      return new URL('../../assets/data/callsigns.json', self.location.href).toString()
    } catch {
      return '../../assets/data/callsigns.json'
    }
  }

  async function loadDb(opts = {}) {
    if (STATE.loaded) return { meta: STATE.meta, count: Array.isArray(STATE.records) ? STATE.records.length : 0 }
    if (STATE.loading && STATE.loadPromise) return STATE.loadPromise

    STATE.loading = true
    STATE.loadPromise = (async () => {
      const dataUrl = String(opts.dataUrl || defaultDataUrl()).trim() || defaultDataUrl()

      sendProgress('start', { dataUrl })

      let payload = null
      try {
        sendProgress('fetch')
        const res = await fetch(dataUrl, { cache: 'no-store' })
        if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'ERR'}`)
        sendProgress('parse')
        payload = await res.json()
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e)
        throw new Error(`Callsign DB load failed: ${msg}`)
      }

      const records = Array.isArray(payload && payload.records) ? payload.records : []
      const meta = payload && payload.meta ? payload.meta : null

      sendProgress('index', { total: records.length })

      const lookup = new Map()
      const prefixIndex = new Map()

      for (let i = 0; i < records.length; i++) {
        const rec = records[i]
        if (!rec || !rec.c) continue

        const cs = String(rec.c).toUpperCase()
        rec.c = cs

        lookup.set(cs, rec)

        const prefix = cs.substring(0, 3)
        let arr = prefixIndex.get(prefix)
        if (!arr) {
          arr = []
          prefixIndex.set(prefix, arr)
        }
        arr.push(i)

        if (i > 0 && i % 50000 === 0) {
          sendProgress('index', { done: i, total: records.length })
        }
      }

      STATE.meta = meta
      STATE.records = records
      STATE.lookup = lookup
      STATE.prefixIndex = prefixIndex
      STATE.loaded = true

      sendProgress('ready', { total: records.length, meta })

      return { meta, count: records.length }
    })()
      .finally(() => {
        STATE.loading = false
        STATE.loadPromise = null
      })

    return STATE.loadPromise
  }

  function ensureLoaded() {
    if (!STATE.loaded || !STATE.lookup || !STATE.prefixIndex || !STATE.records) {
      throw new Error('Callsign DB not loaded')
    }
  }

  function doLookup(callsign) {
    ensureLoaded()
    const cs = String(callsign || '').trim().toUpperCase()
    if (!cs) return null
    return STATE.lookup.get(cs) || null
  }

  function doSuggest(query, limit = 25) {
    ensureLoaded()
    const q = String(query || '').trim().toUpperCase()
    if (!q) return []

    const max = Math.max(1, Math.min(250, Number(limit) || 25))
    const prefix = q.substring(0, 3)
    const pool = STATE.prefixIndex.get(prefix) || []

    const out = []
    for (let i = 0; i < pool.length && out.length < max; i++) {
      const rec = STATE.records[pool[i]]
      if (rec && rec.c && String(rec.c).startsWith(q)) out.push(rec)
    }
    return out
  }

  self.addEventListener('message', (event) => {
    const data = event && event.data ? event.data : null
    if (!data) return

    const type = typeof data === 'string' ? data : data.type
    const requestId = (data && (data.requestId ?? data.id)) || null

    ;(async () => {
      if (type === 'LOAD') {
        const res = await loadDb({ dataUrl: data.dataUrl })
        sendResponse(requestId, true, { result: res })
        return
      }

      if (type === 'LOOKUP') {
        const rec = doLookup(data.callsign)
        sendResponse(requestId, true, { result: rec })
        return
      }

      if (type === 'SUGGEST') {
        const list = doSuggest(data.query, data.limit)
        sendResponse(requestId, true, { result: list })
        return
      }

      sendResponse(requestId, false, { error: `Unknown message type: ${String(type)}` })
    })().catch((e) => {
      const msg = e && e.message ? String(e.message) : String(e)
      sendResponse(requestId, false, { error: msg })
    })
  })
})()

