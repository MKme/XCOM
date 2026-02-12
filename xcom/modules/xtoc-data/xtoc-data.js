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
    this._refreshScheduledKeepSelection = false
    this._refreshInFlight = false
    this._refreshQueued = false
    this._refreshQueuedKeepSelection = false
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

    const schedule = (opts = {}) => {
      const keepSelection = opts.keepSelection === true
      this._refreshScheduledKeepSelection = this._refreshScheduledKeepSelection || keepSelection

      if (this._refreshTimer) clearTimeout(this._refreshTimer)
      this._refreshTimer = setTimeout(() => {
        this._refreshTimer = null
        const ks = this._refreshScheduledKeepSelection
        this._refreshScheduledKeepSelection = false
        void this.refresh({ keepSelection: ks })
      }, keepSelection ? 240 : 120)
    }

    queryEl?.addEventListener('input', schedule)
    last7El?.addEventListener('change', () => schedule())
    geoOnlyEl?.addEventListener('change', () => schedule())
    sourceEl?.addEventListener('change', () => schedule())
    refreshBtn?.addEventListener('click', () => schedule())

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
      schedule()
      try { globalThis.dispatchEvent(new Event('xcomXtocPacketsUpdated')) } catch (_) { /* ignore */ }
    })

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

    // Live update when new packets are stored.
    this._packetsUpdatedHandler = () => {
      // If module is no longer mounted, skip.
      try { if (!document.getElementById('xtoc-data')) return } catch (_) { return }
      schedule({ keepSelection: true })
    }
    try { globalThis.addEventListener('xcomXtocPacketsUpdated', this._packetsUpdatedHandler) } catch (_) { /* ignore */ }

    globalThis.__xcomXtocDataCleanup = () => {
      try { if (this._refreshTimer) clearTimeout(this._refreshTimer) } catch (_) { /* ignore */ }
      this._refreshTimer = null
      this._refreshScheduledKeepSelection = false
      this._refreshInFlight = false
      this._refreshQueued = false
      this._refreshQueuedKeepSelection = false
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
    const t = Number(total || 0) || 0
    const s = Number(shown || 0) || 0
    el.textContent = `Showing ${s} of ${t} stored packet(s).`
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
      return `
        <tr data-key="${this.escapeHtml(String(p?.key || ''))}" class="${untrusted ? 'xtocDataRow--untrusted' : ''}">
          <td class="mono">${this.escapeHtml(when)}</td>
          <td>${geo} ${this.escapeHtml(tpl)}</td>
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

    if (this._refreshInFlight) {
      this._refreshQueued = true
      if (keepSelection) this._refreshQueuedKeepSelection = true
      return
    }
    this._refreshInFlight = true

    const scroller = keepSelection ? document.querySelector('main.xMain') : null
    const beforeScrollTop = scroller ? Number(scroller.scrollTop || 0) || 0 : 0

    const countsEl = document.getElementById('xtocDataCounts')
    if (countsEl) countsEl.textContent = 'Loading…'

    try {
      if (typeof globalThis.xcomListXtocPackets !== 'function' || typeof globalThis.xcomCountXtocPackets !== 'function') {
        this._packets = []
        this.renderTable([])
        this.renderCounts(0, 0)
        const details = document.getElementById('xtocDataDetails')
        if (details) details.innerHTML = `<div class="xtocWarn">Packet store helpers not loaded. Ensure <code>modules/shared/xtoc/packetStore.js</code> is loaded for this module.</div>`
        return
      }

      const query = String(document.getElementById('xtocDataQuery')?.value || '').trim()
      const last7 = !!document.getElementById('xtocDataLast7')?.checked
      const geoOnly = !!document.getElementById('xtocDataGeoOnly')?.checked
      const source = String(document.getElementById('xtocDataSource')?.value || '').trim()

      const sinceMs = last7 ? (Date.now() - (7 * 24 * 60 * 60 * 1000)) : null
      const listRes = await globalThis.xcomListXtocPackets({
        limit: 2000,
        ...(sinceMs ? { sinceMs } : {}),
        ...(query ? { query } : {}),
        ...(source ? { source } : {}),
        ...(geoOnly ? { hasGeo: true } : {}),
      })
      const countRes = await globalThis.xcomCountXtocPackets()

      const packets = (listRes && listRes.ok && Array.isArray(listRes.packets)) ? listRes.packets : []
      const total = (countRes && countRes.ok) ? Number(countRes.count || 0) || 0 : 0

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
    } finally {
      // On some mobile browsers, frequent DOM updates can snap the scroll container back to the top.
      // Preserve the user's scroll position during live updates (keepSelection=true).
      if (scroller && beforeScrollTop > 0) {
        const restore = beforeScrollTop
        const restoreScroll = () => {
          try {
            const after = Number(scroller.scrollTop || 0) || 0
            if (after <= 2) scroller.scrollTop = restore
          } catch (_) {
            // ignore
          }
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreScroll)
        else setTimeout(restoreScroll, 0)
      }

      this._refreshInFlight = false

      const queued = this._refreshQueued
      const queuedKeepSelection = this._refreshQueuedKeepSelection
      this._refreshQueued = false
      this._refreshQueuedKeepSelection = false
      if (queued) void this.refresh({ keepSelection: queuedKeepSelection })
    }
  }
}
