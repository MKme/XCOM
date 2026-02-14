/**
 * Backup Module
 * Export/import XCOM™ local data so users can recover after clearing site data or reinstalling.
 */

class BackupModule {
  constructor() {
    this.init()
  }

  init() {
    this.createModuleStructure()
    this.bindEvents()
    try { window.radioApp.updateStatus('Backup module loaded') } catch (_) { /* ignore */ }
  }

  el(id) {
    return document.getElementById(id)
  }

  setStatus(msg) {
    const el = this.el('xBackupStatus')
    if (!el) return
    el.textContent = String(msg || '').trim()
  }

  ts() {
    // ISO without ":" / "." to keep filenames portable.
    try {
      return new Date().toISOString().replace(/[:.]/g, '')
    } catch (_) {
      return String(Date.now())
    }
  }

  createModuleStructure() {
    const moduleContainer = document.getElementById('backup')
    if (!moduleContainer) return

    moduleContainer.innerHTML = `
      <div class="backup-container">
        <div class="backup-card">
          <h2>Backup &amp; Restore</h2>
          <p class="backup-muted">
            XCOM stores your data locally on this device (localStorage + IndexedDB). If you <strong>clear site data</strong>
            or <strong>uninstall the PWA</strong>, browsers delete that storage.
          </p>
          <p class="backup-warn">
            Tip: export a backup before doing any “reset/repair” steps in your browser.
          </p>
        </div>

        <div class="backup-grid">
          <div class="backup-card">
            <h3>Export</h3>
            <p class="backup-muted">Downloads a JSON backup file containing your XCOM settings and stored XTOC packets.</p>
            <div class="backup-actions">
              <button class="xBtn" id="xBackupExportBtn" type="button">Download backup</button>
            </div>
          </div>

          <div class="backup-card">
            <h3>Import (Replace)</h3>
            <p class="backup-muted">
              Restores from a previously exported <code>xcom-backup-*.json</code> file.
              This <strong>replaces</strong> local XCOM data on this device.
            </p>
            <div class="backup-actions">
              <button class="xBtn xBtnSecondary" id="xBackupImportBtn" type="button">Import backup</button>
            </div>
          </div>

          <div class="backup-card">
            <h3>Repair (Keeps Data)</h3>
            <p class="backup-muted">
              Clears the app shell cache + service worker registrations but keeps your local data (logbook, roster, keys, packets).
              Use this if the app seems “stuck” on an old version.
            </p>
            <div class="backup-actions">
              <button class="xBtn xBtnSecondary" id="xBackupRepairBtn" type="button">Repair app cache</button>
            </div>
          </div>
        </div>

        <div class="backup-card">
          <div id="xBackupStatus" class="backup-status" aria-live="polite"></div>
        </div>
      </div>
    `
  }

  bindEvents() {
    const exportBtn = this.el('xBackupExportBtn')
    const importBtn = this.el('xBackupImportBtn')
    const repairBtn = this.el('xBackupRepairBtn')

    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        try {
          exportBtn.disabled = true
          this.setStatus('Exporting backup…')

          if (typeof globalThis.xcomExportBackupJson !== 'function' || typeof globalThis.xcomDownloadTextFile !== 'function') {
            throw new Error('Backup functions not available in this build')
          }

          const json = await globalThis.xcomExportBackupJson()
          globalThis.xcomDownloadTextFile(`xcom-backup-${this.ts()}.json`, json)
          this.setStatus('Backup downloaded. Store it somewhere safe.')
        } catch (e) {
          this.setStatus(`Export failed: ${e?.message ? String(e.message) : String(e)}`)
        } finally {
          exportBtn.disabled = false
        }
      })
    }

    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        const ok = confirm('Import will REPLACE local XCOM data on this device. Continue?')
        if (!ok) return

        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'

        input.addEventListener('change', async () => {
          const file = input.files && input.files[0]
          if (!file) return

          try {
            importBtn.disabled = true
            this.setStatus('Importing backup…')

            if (typeof globalThis.xcomReadFileAsText !== 'function' ||
                typeof globalThis.xcomParseBackupJson !== 'function' ||
                typeof globalThis.xcomImportBackupObject !== 'function') {
              throw new Error('Backup functions not available in this build')
            }

            const text = await globalThis.xcomReadFileAsText(file)
            const backup = globalThis.xcomParseBackupJson(text)
            const res = await globalThis.xcomImportBackupObject(backup, { replace: true })
            if (!res || res.ok !== true) {
              throw new Error(res?.reason || 'Import failed')
            }

            this.setStatus('Import complete. Reloading…')
            await new Promise((r) => setTimeout(r, 150))
            window.location.reload()
          } catch (e) {
            this.setStatus(`Import failed: ${e?.message ? String(e.message) : String(e)}`)
          } finally {
            try { input.value = '' } catch (_) { /* ignore */ }
            importBtn.disabled = false
          }
        }, { once: true })

        input.click()
      })
    }

    if (repairBtn) {
      repairBtn.addEventListener('click', async () => {
        const ok = confirm('Repair will clear the app cache/service worker and reload, but KEEP your local data. Continue?')
        if (!ok) return

        try {
          repairBtn.disabled = true
          this.setStatus('Repairing app cache…')

          if (typeof globalThis.xcomRepairAppShell !== 'function') {
            throw new Error('Repair function not available in this build')
          }

          await globalThis.xcomRepairAppShell()
        } catch (e) {
          this.setStatus(`Repair failed: ${e?.message ? String(e.message) : String(e)}`)
        } finally {
          repairBtn.disabled = false
        }
      })
    }
  }
}
