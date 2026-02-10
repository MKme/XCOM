// XCOM Callsign DB client
// Provides a small async API for exact callsign lookup + prefix suggestions using a Web Worker.
//
// Why:
// - `assets/data/callsigns.json` is ~100MB+ and parsing/indexing it on the main thread freezes the UI.
// - A worker keeps module navigation responsive (offline-first requirement).

(function () {
  'use strict'

  const WORKER_PATH = 'modules/shared/callsign-db.worker.js'
  const DATA_PATH = 'assets/data/callsigns.json'

  const STATE = {
    worker: null,
    nextId: 1,
    pending: new Map(),
    loaded: false,
    loading: null,
    meta: null,
    progressHandlers: new Set(),
  }

  function emitProgress(evt) {
    for (const cb of STATE.progressHandlers) {
      try {
        cb(evt)
      } catch {
        // ignore
      }
    }
  }

  function ensureWorker() {
    if (STATE.worker) return STATE.worker
    if (typeof Worker === 'undefined') return null

    const workerUrl = new URL(WORKER_PATH, window.location.href).toString()
    const w = new Worker(workerUrl, { type: 'classic' })

    w.addEventListener('message', (ev) => {
      const msg = ev && ev.data ? ev.data : null
      if (!msg) return

      if (msg.type === 'CALLSIGN_DB_PROGRESS') {
        emitProgress(msg)
        return
      }

      if (msg.type !== 'CALLSIGN_DB_RESPONSE') return

      const requestId = msg.requestId
      if (!requestId) return

      const pending = STATE.pending.get(requestId)
      if (!pending) return
      STATE.pending.delete(requestId)

      if (msg.ok) pending.resolve(msg.result)
      else pending.reject(new Error(msg.error || 'Worker request failed'))
    })

    w.addEventListener('error', () => {
      // Reject in-flight requests and allow a new worker to be created later.
      for (const [id, p] of STATE.pending.entries()) {
        STATE.pending.delete(id)
        try {
          p.reject(new Error('Callsign worker error'))
        } catch {
          // ignore
        }
      }
      try {
        w.terminate()
      } catch {
        // ignore
      }
      if (STATE.worker === w) STATE.worker = null
      STATE.loaded = false
      STATE.meta = null
      STATE.loading = null
    })

    STATE.worker = w
    return w
  }

  function callWorker(type, payload = {}) {
    const w = ensureWorker()
    if (!w) return Promise.reject(new Error('Web Worker not supported'))

    const requestId = STATE.nextId++
    return new Promise((resolve, reject) => {
      STATE.pending.set(requestId, { resolve, reject })
      try {
        w.postMessage({ type, requestId, ...payload })
      } catch (e) {
        STATE.pending.delete(requestId)
        reject(e)
      }
    })
  }

  async function load() {
    if (STATE.loaded) return STATE.meta
    if (STATE.loading) return STATE.loading

    const dataUrl = new URL(DATA_PATH, window.location.href).toString()

    STATE.loading = (async () => {
      const res = await callWorker('LOAD', { dataUrl })
      STATE.loaded = true
      STATE.meta = res && res.meta ? res.meta : null
      return STATE.meta
    })()
      .catch((e) => {
        STATE.loaded = false
        STATE.meta = null
        throw e
      })
      .finally(() => {
        STATE.loading = null
      })

    return STATE.loading
  }

  async function lookup(callsign) {
    await load()
    return await callWorker('LOOKUP', { callsign })
  }

  async function suggest(query, limit = 25) {
    await load()
    return await callWorker('SUGGEST', { query, limit })
  }

  function isLoaded() {
    return !!STATE.loaded
  }

  function getMeta() {
    return STATE.meta
  }

  function onProgress(cb) {
    if (typeof cb === 'function') STATE.progressHandlers.add(cb)
  }

  function offProgress(cb) {
    STATE.progressHandlers.delete(cb)
  }

  try {
    globalThis.xcomCallsignDb = {
      load,
      lookup,
      suggest,
      isLoaded,
      getMeta,
      onProgress,
      offProgress,
    }
  } catch {
    // ignore
  }
})()

