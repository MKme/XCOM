/**
 * QSO Logbook Module
 * - Fast entry form with auto UTC date/time
 * - Stores QSOs in localStorage
 * - Export ADIF + CSV (for POTA and general log uploads)
 *
 * Data model (stored):
 * {
 *   id: number,
 *   tsStartUtc: string (ISO),
 *   myCall?: string,
 *   mySig?: string,
 *   mySigInfo?: string,
 *   call: string,
 *   rstSent?: string,
 *   rstRcvd?: string,
 *   band?: string,
 *   mode?: string,
 *   submode?: string,
 *   freqMHz?: number,
 *   txPowerW?: number,
 *   name?: string,
 *   qth?: string,
 *   grid?: string,
 *   potaRef?: string,
 *   notes?: string
 * }
 */

class LogbookModule {
  constructor() {
    this.storageKey = 'logbook.qsos.v1';
    this.prefsKey = 'logbook.prefs.v1';
    this.entryKey = 'logbook.entry.v1';

    // If the system clock is wrong (common offline), users can apply a correction.
    // We store this as an offset in milliseconds added to Date.now().
    this.startManuallyEdited = false;

    this.qsos = [];

    // MapLibre mini-map for the "Known operator" card
    this._knownMap = null;
    this._knownMapContainerId = null;
    this._knownMapPathSourceId = null;
    this._knownMapPathLayerId = null;
    this._knownMapPointSourceId = null;
    this._knownMapPointLayerId = null;

    // Offline geocoding for map coordinates (reused from Predict tab patterns)
    this.geocoder = window.offlineGeocoder || null;
    this.geocoderReady = false;
    this.geocodeCache = new Map();

    // Callsign DB (shared with Predict module, but loaded lazily here)
    this.callsignDb = {
      loaded: false,
      loading: false,
      lookup: new Map(),
      meta: null,
      loadError: null,
    };

    this.prefs = {
      myCall: '',
      mySig: 'POTA',
      mySigInfo: '', // e.g. CA-1234
      defaultGrid: '',
      defaultMode: 'SSB',
      defaultBand: '20m',
      utcOffsetMs: 0,
    };

    this.init();
  }

  init() {
    this.createModuleStructure();
    this.cacheEls();
    this.loadPrefs();
    this.loadEntry();
    this.loadQsos();
    this.bindEvents();

    // Start loading offline geocoder dataset in the background.
    this.ensureGeocoder();

    this.applyPrefsToForm();
    this.refreshUtcClock();
    this.renderTable();

    if (window.radioApp) window.radioApp.updateStatus('Logbook module loaded');
  }

  // -------------
  // UI
  // -------------
  createModuleStructure() {
    const moduleContainer = document.getElementById('logbook');
    if (!moduleContainer) return;

    moduleContainer.innerHTML = `
      <div class="logbook-container">
        <div class="logbook-header">
          <h2>QSO Logbook</h2>
          <div class="logbook-subtitle">
            Log QSOs fast, keep them on this device, and export ADIF/CSV when needed. Date/time defaults to <strong>UTC</strong>.
          </div>
        </div>

        <div class="xModuleIntro">
          <div class="xModuleIntroTitle">What you can do here</div>
          <div class="xModuleIntroText">
            Capture contacts quickly while you're operating, then export later for your main logging app or award uploads.
            <ul class="xModuleIntroList">
              <li>Fast entry with automatic UTC time stamping.</li>
              <li>Everything stays local on this device (offline-friendly).</li>
              <li>Export your log as ADIF or CSV when you're ready.</li>
            </ul>
          </div>
        </div>

        <div class="logbook-grid">
          <section class="logbook-panel">
            <h3>Quick Entry</h3>

            <div class="logbook-known" id="logbookKnown" aria-live="polite"></div>

            <div class="logbook-clock">
              <div><strong>UTC now:</strong> <span id="logbookUtcNow">—</span></div>
            </div>

            <form id="logbookForm" autocomplete="off">
              <div class="logbook-form-grid">
                <div class="field">
                  <label for="lbStart">Start (UTC)</label>
                  <input id="lbStart" type="datetime-local" step="1" required />
                  <div class="help">
                    By default this is stamped automatically when you click <strong>Save QSO</strong>. Edit it only if you need to back-date/override.
                  </div>
                </div>

                <div class="field">
                  <label for="lbCall">Callsign *</label>
                  <input id="lbCall" type="text" placeholder="K1ABC" required />
                </div>

                <div class="field">
                  <label for="lbMode">Mode</label>
                  <select id="lbMode">
                    <option>SSB</option>
                    <option>CW</option>
                    <option>FM</option>
                    <option>AM</option>
                    <option>FT8</option>
                    <option>FT4</option>
                    <option>JS8</option>
                    <option>PSK31</option>
                    <option>RTTY</option>
                    <option>DATA</option>
                  </select>
                </div>

                <div class="field">
                  <label for="lbBand">Band</label>
                  <select id="lbBand">
                    <option>160m</option>
                    <option>80m</option>
                    <option>60m</option>
                    <option>40m</option>
                    <option>30m</option>
                    <option>20m</option>
                    <option>17m</option>
                    <option>15m</option>
                    <option>12m</option>
                    <option>10m</option>
                    <option>6m</option>
                    <option>2m</option>
                    <option>70cm</option>
                  </select>
                </div>

                <div class="field">
                  <label for="lbFreq">Freq (MHz)</label>
                  <input id="lbFreq" type="number" inputmode="decimal" step="0.001" placeholder="14.074" />
                </div>

                <div class="field">
                  <label for="lbRstSent">RST S</label>
                  <input id="lbRstSent" type="text" placeholder="59" maxlength="3" />
                </div>

                <div class="field">
                  <label for="lbRstRcvd">RST R</label>
                  <input id="lbRstRcvd" type="text" placeholder="59" maxlength="3" />
                </div>

                <div class="field">
                  <label for="lbMyCall">My call</label>
                  <input id="lbMyCall" type="text" placeholder="VE3YLO" />
                </div>

                <div class="field">
                  <label for="lbTxPwr">Tx Pwr (W)</label>
                  <input id="lbTxPwr" type="number" step="1" inputmode="numeric" placeholder="5" />
                </div>

                <div class="field">
                  <label for="lbMySig">My SIG</label>
                  <input id="lbMySig" type="text" placeholder="POTA" />
                  <div class="help">
                    The award/program you are activating ("Signature"). Example: <code>POTA</code>, <code>SOTA</code>, <code>IOTA</code>.
                    Exported to ADIF as <code>MY_SIG</code>.
                  </div>
                </div>

                <div class="field">
                  <label for="lbMySigInfo">My SIG INFO</label>
                  <input id="lbMySigInfo" type="text" placeholder="CA-1234" />
                  <div class="help">
                    The reference for your activation. Example: for POTA use <code>CA-1234</code>.
                    Exported to ADIF as <code>MY_SIG_INFO</code>.
                  </div>
                </div>

                <div class="field">
                  <label for="lbPotaRef">POTA ref (optional)</label>
                  <input id="lbPotaRef" type="text" placeholder="CA-1234" />
                  <div class="help">
                    Optional explicit park reference for this QSO. If set, the export will include <code>SIG=POTA</code> and <code>SIG_INFO=&lt;ref&gt;</code>.
                    Leave blank if you only want to tag <em>your</em> activation via <code>MY_SIG/MY_SIG_INFO</code>.
                  </div>
                </div>

                <div class="field">
                  <label for="lbGrid">Grid</label>
                  <input id="lbGrid" type="text" placeholder="FN03" />
                </div>

                <div class="field field-wide">
                  <label for="lbNotes">Notes</label>
                  <input id="lbNotes" type="text" placeholder="Summit-to-summit, park info, etc." />
                </div>
              </div>

              <div class="logbook-actions">
                <button id="logbookSaveBtn" type="submit">Save QSO</button>
                <button id="logbookClearBtn" type="button" class="secondary">Clear</button>
              </div>

              <div class="logbook-hint">
                Tip: press <kbd>Enter</kbd> in the callsign box to save quickly.
              </div>
            </form>
          </section>

          <section class="logbook-panel">
            <div class="logbook-table-header">
              <h3>QSOs</h3>
              <div class="button-row">
                <button id="logbookExportAdifBtn" type="button">Export ADIF</button>
                <button id="logbookExportCsvBtn" type="button">Export CSV</button>
                <button id="logbookClearAllBtn" type="button" class="danger">Clear All</button>
              </div>
            </div>

            <div class="logbook-table-wrap">
              <table class="logbook-table" id="logbookTable">
                <thead>
                  <tr>
                    <th>UTC</th>
                    <th>Call</th>
                    <th>Mode</th>
                    <th>Band</th>
                    <th>Freq</th>
                    <th>RST</th>
                    <th>POTA</th>
                    <th>Notes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>

            <div class="logbook-small-muted" id="logbookCount">0 QSOs</div>
          </section>
        </div>

        <section class="logbook-panel">
          <h3>Defaults</h3>
          <div class="logbook-form-grid">
            <div class="field">
              <label for="lbPrefMyCall">Default My call</label>
              <input id="lbPrefMyCall" type="text" placeholder="VE3YLO" />
            </div>
            <div class="field">
              <label for="lbPrefMode">Default mode</label>
              <select id="lbPrefMode">
                <option>SSB</option>
                <option>CW</option>
                <option>FM</option>
                <option>AM</option>
                <option>FT8</option>
                <option>FT4</option>
                <option>JS8</option>
                <option>PSK31</option>
                <option>RTTY</option>
                <option>DATA</option>
              </select>
            </div>
            <div class="field">
              <label for="lbPrefBand">Default band</label>
              <select id="lbPrefBand">
                <option>160m</option>
                <option>80m</option>
                <option>60m</option>
                <option>40m</option>
                <option>30m</option>
                <option>20m</option>
                <option>17m</option>
                <option>15m</option>
                <option>12m</option>
                <option>10m</option>
                <option>6m</option>
                <option>2m</option>
                <option>70cm</option>
              </select>
            </div>
            <div class="field">
              <label for="lbPrefMySig">Default My SIG</label>
              <input id="lbPrefMySig" type="text" placeholder="POTA" />
            </div>
            <div class="field">
              <label for="lbPrefMySigInfo">Default My SIG INFO</label>
              <input id="lbPrefMySigInfo" type="text" placeholder="CA-1234" />
            </div>

            <div class="field">
              <label for="lbPrefGrid">Default Grid Square</label>
              <input id="lbPrefGrid" type="text" placeholder="FN03" />
            </div>
          </div>
          <div class="logbook-actions">
            <button id="logbookSavePrefsBtn" type="button">Save Defaults</button>
          </div>
        </section>

        <section class="logbook-panel">
          <h3>UTC / Clock (advanced)</h3>
          <div class="logbook-small-muted">
            Most users can ignore this. Use it only if your device clock is wrong while offline.
          </div>

          <div class="logbook-form-grid" style="margin-top:0.75rem;">
            <div class="field">
              <label for="lbUtcOffsetSec">UTC correction (sec)</label>
              <input id="lbUtcOffsetSec" type="number" step="1" inputmode="numeric" placeholder="0" />
              <div class="help">
                Add/subtract seconds from the system clock used by the Logbook.
              </div>
            </div>

            <div class="field">
              <label for="lbUtcManualNow">Set UTC now (manual)</label>
              <input id="lbUtcManualNow" type="datetime-local" step="1" />
              <div class="help">
                Enter the actual current UTC time (from GPS/radio/another device). Click “Set from manual UTC” to auto-compute the correction.
              </div>
            </div>

            <div class="field field-wide">
              <div class="button-row">
                <button id="logbookApplyUtcOffsetBtn" type="button" class="secondary">Apply offset</button>
                <button id="logbookSetUtcNowBtn" type="button" class="secondary">Set from manual UTC</button>
                <button id="logbookResetUtcBtn" type="button" class="secondary">Reset UTC correction</button>
              </div>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  cacheEls() {
    const root = document.getElementById('logbook');
    if (!root) return;

    this.utcNowEl = root.querySelector('#logbookUtcNow');

    this.knownEl = root.querySelector('#logbookKnown');

    this.utcOffsetSecEl = root.querySelector('#lbUtcOffsetSec');
    this.utcManualNowEl = root.querySelector('#lbUtcManualNow');
    this.applyUtcOffsetBtn = root.querySelector('#logbookApplyUtcOffsetBtn');
    this.setUtcNowBtn = root.querySelector('#logbookSetUtcNowBtn');
    this.resetUtcBtn = root.querySelector('#logbookResetUtcBtn');

    this.form = root.querySelector('#logbookForm');
    this.startEl = root.querySelector('#lbStart');
    this.callEl = root.querySelector('#lbCall');
    this.modeEl = root.querySelector('#lbMode');
    this.bandEl = root.querySelector('#lbBand');
    this.freqEl = root.querySelector('#lbFreq');
    this.rstSentEl = root.querySelector('#lbRstSent');
    this.rstRcvdEl = root.querySelector('#lbRstRcvd');
    this.myCallEl = root.querySelector('#lbMyCall');
    this.txPwrEl = root.querySelector('#lbTxPwr');
    this.mySigEl = root.querySelector('#lbMySig');
    this.mySigInfoEl = root.querySelector('#lbMySigInfo');
    this.potaRefEl = root.querySelector('#lbPotaRef');
    this.gridEl = root.querySelector('#lbGrid');
    this.notesEl = root.querySelector('#lbNotes');
    this.clearBtn = root.querySelector('#logbookClearBtn');

    this.tableBody = root.querySelector('#logbookTable tbody');
    this.countEl = root.querySelector('#logbookCount');

    this.exportAdifBtn = root.querySelector('#logbookExportAdifBtn');
    this.exportCsvBtn = root.querySelector('#logbookExportCsvBtn');
    this.clearAllBtn = root.querySelector('#logbookClearAllBtn');

    this.prefMyCallEl = root.querySelector('#lbPrefMyCall');
    this.prefModeEl = root.querySelector('#lbPrefMode');
    this.prefBandEl = root.querySelector('#lbPrefBand');
    this.prefMySigEl = root.querySelector('#lbPrefMySig');
    this.prefMySigInfoEl = root.querySelector('#lbPrefMySigInfo');
    this.prefGridEl = root.querySelector('#lbPrefGrid');
    this.savePrefsBtn = root.querySelector('#logbookSavePrefsBtn');
  }

  bindEvents() {
    if (!this.form) return;

    this.startEl.addEventListener('input', () => {
      // If the user touches the field, treat it as an override.
      this.startManuallyEdited = true;
    });

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveFromForm();
    });

    this.clearBtn.addEventListener('click', () => this.clearForm({ keepStart: false, clearPersisted: true }));

    // Rapid entry: Enter in callsign field triggers save (form submit)
    this.callEl.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        // let the form submit handler run
      }
    });

    this.exportAdifBtn.addEventListener('click', () => this.exportAdif());
    this.exportCsvBtn.addEventListener('click', () => this.exportCsv());
    this.clearAllBtn.addEventListener('click', () => this.clearAll());

    this.savePrefsBtn.addEventListener('click', () => this.savePrefsFromUi());

    this.applyUtcOffsetBtn.addEventListener('click', () => this.applyUtcOffsetFromUi());
    this.resetUtcBtn.addEventListener('click', () => this.resetUtcOffset());
    this.setUtcNowBtn.addEventListener('click', () => this.setUtcFromManualNow());
  }

  // -------------
  // Persistence
  // -------------
  loadQsos() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      this.qsos = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('Failed to load QSOs', e);
      this.qsos = [];
    }
  }

  saveQsos() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.qsos || []));
    } catch (e) {
      console.warn('Failed to save QSOs', e);
      alert('Failed to save QSOs (storage unavailable).');
    }
  }

  loadPrefs() {
    try {
      const raw = localStorage.getItem(this.prefsKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        this.prefs = { ...this.prefs, ...parsed };
        // Ensure number
        if (!Number.isFinite(this.prefs.utcOffsetMs)) this.prefs.utcOffsetMs = 0;
      }
    } catch (e) {
      console.warn('Failed to load Logbook prefs', e);
    }
  }

  savePrefs() {
    try {
      localStorage.setItem(this.prefsKey, JSON.stringify(this.prefs || {}));
    } catch (e) {
      console.warn('Failed to save Logbook prefs', e);
    }
  }

  loadEntry() {
    // Last-entered values for fast repeated logging (persist across sessions)
    this.entry = {
      band: '',
      mode: '',
      freqMHz: '',
      rstSent: '',
      rstRcvd: '',
      txPowerW: '',
      potaRef: '',
      grid: '',
      notes: '',
      myCall: '',
      mySig: '',
      mySigInfo: '',
    };
    try {
      const raw = localStorage.getItem(this.entryKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') {
        this.entry = { ...this.entry, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load Logbook entry cache', e);
    }
  }

  saveEntry() {
    try {
      localStorage.setItem(this.entryKey, JSON.stringify(this.entry || {}));
    } catch (e) {
      console.warn('Failed to save Logbook entry cache', e);
    }
  }

  // -------------
  // Helpers
  // -------------
  updateStatus(msg) {
    if (window.radioApp && typeof window.radioApp.updateStatus === 'function') {
      window.radioApp.updateStatus(msg);
      return;
    }
    const el = document.getElementById('statusText');
    if (el) el.textContent = msg;
  }

  // datetime-local expects local time, but we want it to show UTC values.
  // We therefore format a UTC timestamp into the local datetime-local string.
  toDatetimeLocalUtc(d) {
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  fromDatetimeLocalUtc(value) {
    // value looks like: 2026-01-23T16:35:10
    if (!value) return null;
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/.exec(value);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const da = parseInt(m[3], 10);
    const hh = parseInt(m[4], 10);
    const mm = parseInt(m[5], 10);
    const ss = parseInt(m[6] || '0', 10);
    return new Date(Date.UTC(y, mo, da, hh, mm, ss));
  }

  refreshUtcClock() {
    if (!this.utcNowEl) return;
    const tick = () => {
      const d = this.nowUtc();
      const pad = (n) => `${n}`.padStart(2, '0');
      const s = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
      this.utcNowEl.textContent = s;
    };
    tick();
    window.clearInterval(this._clockTimer);
    this._clockTimer = window.setInterval(tick, 1000);
  }

  sanitizeCallsign(raw) {
    return (raw || '').toString().trim().toUpperCase().replace(/\s+/g, '');
  }

  normalizeMode(raw) {
    const v = (raw || '').toString().trim().toUpperCase();
    if (!v) return '';
    // common digital modes are treated as mode=DATA, submode=FT8/JS8/etc for ADIF.
    const digital = ['FT8', 'FT4', 'JS8', 'PSK31', 'RTTY'];
    if (digital.includes(v)) return v;
    return v;
  }

  modeToAdif(mode) {
    const m = this.normalizeMode(mode);
    const digital = ['FT8', 'FT4', 'JS8', 'PSK31', 'RTTY'];
    if (digital.includes(m)) return { mode: 'DATA', submode: m };
    return { mode: m || 'SSB', submode: '' };
  }

  // -------------
  // Form
  // -------------
  applyPrefsToForm() {
    if (!this.startEl) return;
    // Defaults panel
    this.prefMyCallEl.value = this.prefs.myCall || '';
    this.prefMySigEl.value = this.prefs.mySig || '';
    this.prefMySigInfoEl.value = this.prefs.mySigInfo || '';
    this.prefGridEl.value = this.prefs.defaultGrid || '';
    this.prefModeEl.value = this.prefs.defaultMode || 'SSB';
    this.prefBandEl.value = this.prefs.defaultBand || '20m';

    // Entry form
    // Prefer cached last-entry values, otherwise fall back to defaults.
    this.myCallEl.value = (this.entry.myCall || this.prefs.myCall || '').toString().trim().toUpperCase();
    this.mySigEl.value = (this.entry.mySig || this.prefs.mySig || '').toString().trim().toUpperCase();
    this.mySigInfoEl.value = (this.entry.mySigInfo || this.prefs.mySigInfo || '').toString().trim().toUpperCase();

    this.modeEl.value = (this.entry.mode || this.prefs.defaultMode || 'SSB').toString();
    this.bandEl.value = (this.entry.band || this.prefs.defaultBand || '20m').toString();

    this.freqEl.value = (this.entry.freqMHz ?? '').toString();
    this.rstSentEl.value = (this.entry.rstSent ?? '').toString();
    this.rstRcvdEl.value = (this.entry.rstRcvd ?? '').toString();
    this.txPwrEl.value = (this.entry.txPowerW ?? '').toString();
    this.potaRefEl.value = (this.entry.potaRef ?? '').toString();
    this.gridEl.value = (this.entry.grid || this.prefs.defaultGrid || '').toString();
    this.notesEl.value = (this.entry.notes ?? '').toString();

    this.utcOffsetSecEl.value = `${Math.round((this.prefs.utcOffsetMs || 0) / 1000)}`;

    this.startEl.value = this.toDatetimeLocalUtc(this.nowUtc());
    this.startManuallyEdited = false;
  }

  clearForm({ keepStart = true, clearPersisted = false } = {}) {
    const start = keepStart ? this.startEl.value : this.toDatetimeLocalUtc(this.nowUtc());
    this.form.reset();

    if (clearPersisted) {
      this.entry = {
        band: '',
        mode: '',
        freqMHz: '',
        rstSent: '',
        rstRcvd: '',
        txPowerW: '',
        potaRef: '',
        grid: '',
        notes: '',
        myCall: '',
        mySig: '',
        mySigInfo: '',
      };
      try { localStorage.removeItem(this.entryKey); } catch (_) { /* ignore */ }
    }

    // Restore entry defaults (either cached or prefs)
    this.applyPrefsToForm();
    this.startEl.value = start;
    this.startManuallyEdited = false;
    this.callEl.value = '';
    this.callEl.focus();
  }

  clearAfterSave() {
    // Keep all last-entered values for rapid logging; only clear the callsign.
    this.callEl.value = '';
    this.callEl.focus();
    // Refresh Start display (though we stamp at save-time anyway)
    this.startEl.value = this.toDatetimeLocalUtc(this.nowUtc());
    this.startManuallyEdited = false;
  }

  savePrefsFromUi() {
    this.prefs.myCall = (this.prefMyCallEl.value || '').trim().toUpperCase();
    this.prefs.mySig = (this.prefMySigEl.value || '').trim().toUpperCase();
    this.prefs.mySigInfo = (this.prefMySigInfoEl.value || '').trim().toUpperCase();
    this.prefs.defaultGrid = (this.prefGridEl.value || '').trim().toUpperCase();
    this.prefs.defaultMode = (this.prefModeEl.value || 'SSB').toString();
    this.prefs.defaultBand = (this.prefBandEl.value || '20m').toString();
    this.savePrefs();
    this.applyPrefsToForm();
    this.updateStatus('Logbook defaults saved');
  }

  saveFromForm() {
    const call = this.sanitizeCallsign(this.callEl.value);
    if (!call) {
      alert('Callsign is required.');
      this.callEl.focus();
      return;
    }

    // Default: stamp the QSO with the current (corrected) UTC at the moment the user saves.
    // If the user has manually edited Start, we respect it.
    let start = null;
    if (this.startManuallyEdited) {
      start = this.fromDatetimeLocalUtc(this.startEl.value);
      if (!start) {
        alert('Start time (UTC) is required.');
        this.startEl.focus();
        return;
      }
    } else {
      start = this.nowUtc();
      this.startEl.value = this.toDatetimeLocalUtc(start);
    }

    const freq = this.freqEl.value ? parseFloat(this.freqEl.value) : null;
    const pwr = this.txPwrEl.value ? parseInt(this.txPwrEl.value, 10) : null;

    const qso = {
      id: Date.now(),
      tsStartUtc: start.toISOString(),
      myCall: (this.myCallEl.value || '').trim().toUpperCase(),
      mySig: (this.mySigEl.value || '').trim().toUpperCase(),
      mySigInfo: (this.mySigInfoEl.value || '').trim().toUpperCase(),
      call,
      mode: (this.modeEl.value || '').toString(),
      band: (this.bandEl.value || '').toString(),
      freqMHz: Number.isFinite(freq) ? freq : undefined,
      rstSent: (this.rstSentEl.value || '').trim().toUpperCase(),
      rstRcvd: (this.rstRcvdEl.value || '').trim().toUpperCase(),
      txPowerW: Number.isFinite(pwr) ? pwr : undefined,
      potaRef: (this.potaRefEl.value || '').trim().toUpperCase(),
      grid: (this.gridEl.value || '').trim().toUpperCase(),
      notes: (this.notesEl.value || '').trim(),
    };

    // Persist last-entered values so the operator mainly types the callsign.
    this.entry = {
      ...this.entry,
      band: (this.bandEl.value || '').toString(),
      mode: (this.modeEl.value || '').toString(),
      freqMHz: (this.freqEl.value || '').toString(),
      rstSent: (this.rstSentEl.value || '').trim().toUpperCase(),
      rstRcvd: (this.rstRcvdEl.value || '').trim().toUpperCase(),
      txPowerW: (this.txPwrEl.value || '').toString(),
      potaRef: (this.potaRefEl.value || '').trim().toUpperCase(),
      grid: (this.gridEl.value || '').trim().toUpperCase(),
      notes: (this.notesEl.value || '').toString(),
      myCall: (this.myCallEl.value || '').trim().toUpperCase(),
      mySig: (this.mySigEl.value || '').trim().toUpperCase(),
      mySigInfo: (this.mySigInfoEl.value || '').trim().toUpperCase(),
    };
    this.saveEntry();

    // Insert newest first
    this.qsos.unshift(qso);
    this.saveQsos();
    this.renderTable();

    // Populate callsign/user info prominently for the operator.
    // (We do this after saving so it never blocks logging.)
    this.populateKnownOperatorPanelForCall(call);

    this.updateStatus(`Saved QSO with ${call}`);
    this.clearAfterSave();
  }

  // -------------
  // Known operator panel (call sign DB integration)
  // -------------

  async ensureGeocoder() {
    if (this.geocoder && !this.geocoderReady) {
      try {
        await this.geocoder.load();
        this.geocoderReady = true;
      } catch (err) {
        console.warn('Offline geocoder failed to load', err);
        this.geocoderReady = false;
      }
    }
  }

  async geocodePlace(query) {
    const raw = (query || '').trim();
    if (!raw) return null;

    const cacheKey = raw.toLowerCase();
    if (this.geocodeCache.has(cacheKey)) return this.geocodeCache.get(cacheKey);

    await this.ensureGeocoder();
    if (!this.geocoderReady || !this.geocoder) return null;

    // Similar to Predict module: try the full query and individual components.
    const attemptQueries = [];
    const pushUnique = (q) => {
      const v = (q || '').trim();
      if (!v) return;
      const k = v.toLowerCase();
      if (!attemptQueries.some((aq) => aq.toLowerCase() === k)) attemptQueries.push(v);
    };

    pushUnique(raw);
    if (raw.includes(',')) {
      raw.split(',').map(p => p.trim()).filter(Boolean).forEach(pushUnique);
    }
    if (/\s+/.test(raw)) {
      raw.split(/\s+/).forEach(pushUnique);
    }

    for (const q of attemptQueries) {
      const key = q.toLowerCase();
      if (this.geocodeCache.has(key)) return this.geocodeCache.get(key);
      const offline = this.geocoder.first(q);
      if (offline) {
        const loc = {
          lat: offline.lat,
          lng: offline.lng,
          name: offline.display || offline.name
        };
        this.geocodeCache.set(key, loc);
        this.geocodeCache.set(cacheKey, loc);
        return loc;
      }
    }

    // Cache miss as null to avoid repeated work.
    this.geocodeCache.set(cacheKey, null);
    return null;
  }

  async geocodeCallsignRecord(record) {
    if (!record) return null;
    const city = (record.city || '').toString().trim();
    const st = (record.st || '').toString().trim();
    const co = (record.co || '').toString().trim();

    const queries = [];
    if (city || st || co) queries.push([city, st, co].filter(Boolean).join(', '));
    if (city && st) queries.push([city, st].join(', '));
    if (city && co) queries.push([city, co].join(', '));
    if (st && co) queries.push([st, co].join(', '));
    if (city) queries.push(city);

    const seen = new Set();
    const unique = queries.map(q => q.trim()).filter(Boolean).filter(q => {
      const k = q.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    for (const q of unique) {
      const loc = await this.geocodePlace(q);
      if (loc) return loc;
    }

    return null;
  }

  // Maidenhead grid square to approximate lat/lng (center of square)
  // (Copied from Predict module for consistency)
  parseGridSquare(raw) {
    if (!raw) return null;
    const grid = raw.trim().toUpperCase();
    const match = grid.match(/^([A-R]{2})(\d{2})([A-X]{2})?(\d{2})?$/);
    if (!match) return null;

    let lon = -180;
    let lat = -90;
    let lonSize = 20; // field width in degrees
    let latSize = 10; // field height in degrees

    // Field (AA..RR)
    const field = match[1];
    lon += (field.charCodeAt(0) - 65) * lonSize;
    lat += (field.charCodeAt(1) - 65) * latSize;

    // Square (00..99)
    const square = match[2];
    lonSize /= 10; // 2° cells
    latSize /= 10; // 1° cells
    lon += parseInt(square[0], 10) * lonSize;
    lat += parseInt(square[1], 10) * latSize;

    // Subsquare (AA..XX)
    const subsquare = match[3];
    if (subsquare) {
      lonSize /= 24; // 5' cells
      latSize /= 24; // 2.5' cells
      lon += (subsquare.charCodeAt(0) - 65) * lonSize;
      lat += (subsquare.charCodeAt(1) - 65) * latSize;
    }

    // Extended square (optional digits 00..99)
    const ext = match[4];
    if (ext) {
      lonSize /= 10;
      latSize /= 10;
      lon += parseInt(ext[0], 10) * lonSize;
      lat += parseInt(ext[1], 10) * latSize;
    }

    const centerLon = lon + lonSize / 2;
    const centerLat = lat + latSize / 2;

    if (centerLat < -90 || centerLat > 90 || centerLon < -180 || centerLon > 180) {
      return null;
    }

    return { lat: centerLat, lng: centerLon };
  }

  getOurStationLocation() {
    // Try to reuse whatever the operator has already set elsewhere in the app.
    // - Predict tab: window.callsignLookupModule.userLocation
    // - Repeater Map tab: window.repeaterMapModule.userLocation
    try {
      // 0) Logbook's own grid square (if filled) should count as "our location"
      const gridRaw = (this.gridEl && this.gridEl.value) ? this.gridEl.value : (this.entry && this.entry.grid);
      const parsedGrid = this.parseGridSquare(gridRaw);
      if (parsedGrid) {
        const label = (gridRaw || '').toString().trim().toUpperCase();
        return { lat: parsedGrid.lat, lng: parsedGrid.lng, name: label ? `${label} grid center` : 'Your station' };
      }

      const candidates = [
        window.callsignLookupModule && window.callsignLookupModule.userLocation,
        window.repeaterMapModule && window.repeaterMapModule.userLocation,
      ].filter(Boolean);

      for (const loc of candidates) {
        if (!loc) continue;
        const lat = typeof loc.lat === 'number' ? loc.lat : parseFloat(loc.lat);
        const lng = typeof loc.lng === 'number' ? loc.lng : parseFloat(loc.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return { lat, lng, name: (loc.name || 'Your station').toString() };
        }
      }
    } catch (_) {
      // ignore
    }
    return null;
  }

  destroyKnownMap() {
    try {
      if (this._knownMap) {
        this._knownMap.remove();
      }
    } catch (err) {
      console.warn('Failed to destroy known map', err);
    }
    this._knownMap = null;
    this._knownMapContainerId = null;
    this._knownMapPathSourceId = null;
    this._knownMapPathLayerId = null;
    this._knownMapPointSourceId = null;
    this._knownMapPointLayerId = null;
  }

  renderKnownOperatorMap({ targetLocation, targetLabel, ourLocation }) {
    // If MapLibre isn't available, just skip.
    if (!globalThis.maplibregl) return;
    if (!this.knownEl) return;

    // Re-create map each time since we're re-rendering innerHTML.
    this.destroyKnownMap();

    const mapEl = this.knownEl.querySelector('.logbook-known-map');
    if (!mapEl) return;

    // MapLibre requires a stable container with width/height already in layout.
    const mapId = `logbookKnownMap-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    mapEl.id = mapId;
    this._knownMapContainerId = mapId;

    const map = globalThis.createMapLibreMap
      ? globalThis.createMapLibreMap({
          container: mapEl,
          centerLon: targetLocation.lng,
          centerLat: targetLocation.lat,
          zoom: 4,
        })
      : new globalThis.maplibregl.Map({
          container: mapEl,
          style: globalThis.buildMapLibreStyle ? globalThis.buildMapLibreStyle() : 'https://tiles.openfreemap.org/styles/liberty',
          center: [targetLocation.lng, targetLocation.lat],
          zoom: 4,
          attributionControl: false,
        });

    // Small embedded map: keep it quiet.
    try {
      map.addControl(new globalThis.maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    } catch (_) {
      // ignore
    }

    this._knownMap = map;
    this._knownMapPathSourceId = `logbook-known-path-${Date.now()}`;
    this._knownMapPathLayerId = `logbook-known-path-line-${Date.now()}`;
    this._knownMapPointSourceId = `logbook-known-pts-${Date.now()}`;
    this._knownMapPointLayerId = `logbook-known-pts-layer-${Date.now()}`;

    const setData = () => {
      const lineSrc = map.getSource(this._knownMapPathSourceId);
      const ptSrc = map.getSource(this._knownMapPointSourceId);
      if (!lineSrc || !ptSrc) return;

      const pts = [];
      pts.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [targetLocation.lng, targetLocation.lat] },
        properties: { kind: 'target' },
      });
      if (ourLocation) {
        pts.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [ourLocation.lng, ourLocation.lat] },
          properties: { kind: 'user' },
        });
      }

      const lines = ourLocation
        ? [{
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [ourLocation.lng, ourLocation.lat],
                [targetLocation.lng, targetLocation.lat],
              ],
            },
            properties: {},
          }]
        : [];

      lineSrc.setData({ type: 'FeatureCollection', features: lines });
      ptSrc.setData({ type: 'FeatureCollection', features: pts });

      // Fit nicely inside the small map.
      const COUNTRY_SCALE_ZOOM = 4;
      const MAX_DETAIL_ZOOM = 5;

      if (!ourLocation) {
        map.easeTo({ center: [targetLocation.lng, targetLocation.lat], zoom: COUNTRY_SCALE_ZOOM });
      } else {
        const b = new globalThis.maplibregl.LngLatBounds();
        b.extend([targetLocation.lng, targetLocation.lat]);
        b.extend([ourLocation.lng, ourLocation.lat]);
        map.fitBounds(b, { padding: 12, maxZoom: MAX_DETAIL_ZOOM });
      }
    };

    map.on('load', () => {
      // Sources/layers
      map.addSource(this._knownMapPathSourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: this._knownMapPathLayerId,
        type: 'line',
        source: this._knownMapPathSourceId,
        paint: {
          'line-color': '#38bdf8',
          'line-width': 3,
          'line-opacity': 0.85,
        },
      });

      map.addSource(this._knownMapPointSourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: this._knownMapPointLayerId,
        type: 'circle',
        source: this._knownMapPointSourceId,
        paint: {
          'circle-radius': 6,
          'circle-color': ['match', ['get', 'kind'], 'user', '#ef4444', 'target', '#38bdf8', '#94a3b8'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });

      setData();
    });
  }

  async populateKnownOperatorPanelForCall(call) {
    if (!this.knownEl) return;
    const cs = this.sanitizeCallsign(call);
    if (!cs) {
      this.knownEl.innerHTML = '';
      this.destroyKnownMap();
      return;
    }

    // Show immediate feedback while we lookup.
    this.knownEl.innerHTML = `
      <div class="logbook-known-card pending">
        <div class="title">Saved</div>
        <div class="body">Looking up <code>${cs}</code> in local callsign database…</div>
      </div>
    `;

    try {
      const record = await this.lookupCallsignRecord(cs);
      if (!record) {
        this.knownEl.innerHTML = `
          <div class="logbook-known-card unknown">
            <div class="title">Saved</div>
            <div class="body">No local database match for <code>${cs}</code>.</div>
          </div>
        `;
        this.destroyKnownMap();
        return;
      }

      const esc = (s) => (s ?? '').toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      const name = record.n || '';
      const location = [record.city, record.st].filter(Boolean).join(', ');
      const country = record.co || '';
      const klass = record.cl || '';
      const expires = record.ex || '';

      const targetLoc = await this.geocodeCallsignRecord(record);
      const hasCoords = !!(targetLoc && Number.isFinite(targetLoc.lat) && Number.isFinite(targetLoc.lng));

      this.knownEl.innerHTML = `
        <div class="logbook-known-card found">
          <div class="title">Known operator</div>
          <div class="headline">
            <code>${esc(record.c || cs)}</code>
            ${name ? `<span class="name">${esc(name)}</span>` : ''}
          </div>
          <div class="details">
            ${location ? `<div><span class="label">QTH:</span> ${esc(location)}</div>` : ''}
            ${country ? `<div><span class="label">Country:</span> ${esc(country)}</div>` : ''}
            ${klass ? `<div><span class="label">Class:</span> ${esc(klass)}</div>` : ''}
            ${expires ? `<div><span class="label">Expires:</span> ${esc(expires)}</div>` : ''}
          </div>
          ${hasCoords ? `<div class="logbook-known-map-wrap"><div class="logbook-known-map" aria-label="Map of ${esc(record.c || cs)} location"></div></div>` : ''}
        </div>
      `;

      if (hasCoords) {
        const ourLoc = this.getOurStationLocation();
        this.renderKnownOperatorMap({
          targetLocation: { lat: targetLoc.lat, lng: targetLoc.lng, name: targetLoc.name || location || record.c || cs },
          targetLabel: `${record.c || cs}${name ? ' - ' + name : ''}`,
          ourLocation: ourLoc,
        });
      } else {
        this.destroyKnownMap();
      }

      // Optional: enrich the most recently saved QSO record in storage with name/qth.
      // This makes table export and later review more useful without changing the form.
      this.tryEnrichLatestQsoWithRecord(cs, record);
    } catch (err) {
      console.warn('Known operator lookup failed', err);
      this.knownEl.innerHTML = `
        <div class="logbook-known-card error">
          <div class="title">Saved</div>
          <div class="body">Saved QSO with <code>${cs}</code>, but lookup failed.</div>
        </div>
      `;
      this.destroyKnownMap();
    }
  }

  tryEnrichLatestQsoWithRecord(call, record) {
    try {
      const first = (this.qsos || [])[0];
      if (!first) return;
      if (this.sanitizeCallsign(first.call) !== this.sanitizeCallsign(call)) return;

      // Keep these optional so old data stays compatible.
      first.name = (record.n || '').toString().trim();
      first.qth = [record.city, record.st, record.co].filter(Boolean).join(', ');

      this.saveQsos();
    } catch (_) {
      // Ignore enrichment errors
    }
  }

  async lookupCallsignRecord(callsign) {
    const cs = this.sanitizeCallsign(callsign);
    if (!cs) return null;

    // Prefer shared worker-backed DB (keeps UI responsive).
    if (globalThis.xcomCallsignDb && typeof globalThis.xcomCallsignDb.lookup === 'function') {
      try {
        await globalThis.xcomCallsignDb.load();
        return await globalThis.xcomCallsignDb.lookup(cs);
      } catch (_) {
        return null;
      }
    }

    // Fallback: legacy in-module loader
    await this.ensureCallsignDbLoaded();
    if (!this.callsignDb.loaded) return null;
    return this.callsignDb.lookup.get(cs) || null;
  }

  async ensureCallsignDbLoaded() {
    if (this.callsignDb.loaded) return;
    if (this.callsignDb.loading) {
      // Wait for an in-flight load.
      await this.callsignDb.loading;
      return;
    }

    const loadPromise = (async () => {
      try {
        // Prefer shared worker-backed DB if present.
        if (globalThis.xcomCallsignDb && typeof globalThis.xcomCallsignDb.load === 'function') {
          await globalThis.xcomCallsignDb.load();
          this.callsignDb.lookup = new Map(); // unused in worker mode, keep shape intact
          this.callsignDb.meta = globalThis.xcomCallsignDb.getMeta ? globalThis.xcomCallsignDb.getMeta() : null;
          this.callsignDb.loaded = true;
          this.callsignDb.loadError = null;
          return;
        }

        // Strategy mirrors callsign-lookup module:
        // 1) already-loaded global
        // 2) fetch JSON (http/https)
        // 3) load JS payload (file:// safe)
        // 4) Electron preload disk read
        let payload = window.CALLSIGNS_DATA || null;

        if (!payload) payload = await this.tryFetchCallsignsJson();
        if (!payload) payload = await this.tryLoadCallsignsScriptPayload();
        if (!payload && window.offlineData && typeof window.offlineData.loadCallsigns === 'function') {
          const raw = window.offlineData.loadCallsigns();
          if (raw) payload = JSON.parse(raw);
        }

        if (!payload || !payload.records) {
          throw new Error('Callsign database not available');
        }

        const lookup = new Map();
        (payload.records || []).forEach((r) => {
          if (r && r.c) lookup.set(r.c, r);
        });

        this.callsignDb.lookup = lookup;
        this.callsignDb.meta = payload.meta || null;
        this.callsignDb.loaded = true;
        this.callsignDb.loadError = null;
      } catch (err) {
        this.callsignDb.loaded = false;
        this.callsignDb.loadError = err;
      }
    })();

    this.callsignDb.loading = loadPromise;
    await loadPromise;
    this.callsignDb.loading = false;
  }

  async tryFetchCallsignsJson() {
    try {
      const dataUrl = new URL('assets/data/callsigns.json', window.location.href).toString();
      const res = await fetch(dataUrl);
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  async tryLoadCallsignsScriptPayload() {
    try {
      await this.loadScriptOnce('assets/data/callsigns.js');
      return window.CALLSIGNS_DATA || null;
    } catch (_) {
      return null;
    }
  }

  loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.body.appendChild(script);
    });
  }

  // Returns a Date representing the app's idea of "now" in UTC,
  // applying any user-configured correction.
  nowUtc() {
    const offset = Number.isFinite(this.prefs.utcOffsetMs) ? this.prefs.utcOffsetMs : 0;
    return new Date(Date.now() + offset);
  }

  applyUtcOffsetFromUi() {
    const sec = parseInt((this.utcOffsetSecEl.value || '0').toString(), 10);
    const offsetMs = Number.isFinite(sec) ? sec * 1000 : 0;
    this.prefs.utcOffsetMs = offsetMs;
    this.savePrefs();
    this.refreshUtcClock();
    if (!this.startManuallyEdited) this.startEl.value = this.toDatetimeLocalUtc(this.nowUtc());
    this.updateStatus('UTC correction applied');
  }

  resetUtcOffset() {
    this.prefs.utcOffsetMs = 0;
    this.savePrefs();
    this.utcOffsetSecEl.value = '0';
    this.refreshUtcClock();
    if (!this.startManuallyEdited) this.startEl.value = this.toDatetimeLocalUtc(this.nowUtc());
    this.updateStatus('UTC correction reset');
  }

  setUtcFromManualNow() {
    const manual = this.fromDatetimeLocalUtc(this.utcManualNowEl.value);
    if (!manual) {
      alert('Please enter the current UTC time to calibrate from.');
      this.utcManualNowEl.focus();
      return;
    }

    // manual is the desired UTC "now"; Date.now() is the system-based "now".
    const offsetMs = manual.getTime() - Date.now();
    const sec = Math.round(offsetMs / 1000);

    this.prefs.utcOffsetMs = sec * 1000;
    this.utcOffsetSecEl.value = `${sec}`;
    this.savePrefs();
    this.refreshUtcClock();
    if (!this.startManuallyEdited) this.startEl.value = this.toDatetimeLocalUtc(this.nowUtc());
    this.updateStatus('UTC calibrated from manual entry');
  }

  // -------------
  // Table
  // -------------
  formatUtcShort(iso) {
    try {
      const d = new Date(iso);
      const pad = (n) => `${n}`.padStart(2, '0');
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    } catch (_) {
      return iso || '';
    }
  }

  renderTable() {
    if (!this.tableBody) return;
    const qsos = Array.isArray(this.qsos) ? this.qsos : [];
    this.countEl.textContent = `${qsos.length} QSO${qsos.length === 1 ? '' : 's'}`;

    if (qsos.length === 0) {
      this.tableBody.innerHTML = `<tr><td colspan="9" class="empty">No QSOs yet. Add your first QSO on the left.</td></tr>`;
      return;
    }

    const esc = (s) => (s ?? '').toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    this.tableBody.innerHTML = qsos.map(q => {
      const rst = `${q.rstSent || '—'}/${q.rstRcvd || '—'}`;
      return `
        <tr data-id="${q.id}">
          <td>${esc(this.formatUtcShort(q.tsStartUtc))}Z</td>
          <td><code>${esc(q.call)}</code></td>
          <td>${esc(q.mode || '')}</td>
          <td>${esc(q.band || '')}</td>
          <td>${Number.isFinite(q.freqMHz) ? esc(q.freqMHz.toFixed(3)) : ''}</td>
          <td>${esc(rst)}</td>
          <td>${esc(q.potaRef || q.mySigInfo || '')}</td>
          <td class="notes">${esc(q.notes || '')}</td>
          <td class="actions">
            <button type="button" class="small danger" data-action="delete">Delete</button>
          </td>
        </tr>
      `;
    }).join('');

    this.tableBody.querySelectorAll('button[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tr = e.target.closest('tr');
        const id = tr ? parseInt(tr.dataset.id, 10) : null;
        if (!id) return;
        this.deleteQso(id);
      });
    });
  }

  deleteQso(id) {
    const q = (this.qsos || []).find(x => x.id === id);
    if (!q) return;
    if (!confirm(`Delete QSO with ${q.call}?`)) return;
    this.qsos = (this.qsos || []).filter(x => x.id !== id);
    this.saveQsos();
    this.renderTable();
  }

  clearAll() {
    if (!confirm('Clear ALL QSOs from the logbook? This cannot be undone.')) return;
    this.qsos = [];
    this.saveQsos();
    this.renderTable();
    this.updateStatus('Logbook cleared');
  }

  // -------------
  // Export
  // -------------
  downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  exportCsv() {
    const qsos = Array.isArray(this.qsos) ? this.qsos.slice().reverse() : [];
    if (qsos.length === 0) {
      alert('No QSOs to export.');
      return;
    }

    const headers = [
      'qso_date', 'time_on', 'call', 'band', 'freq', 'mode', 'submode',
      'rst_sent', 'rst_rcvd', 'station_callsign', 'my_sig', 'my_sig_info',
      'sig', 'sig_info', 'gridsquare', 'tx_pwr', 'comment'
    ];

    const { lines } = this.buildAdifLines(qsos);
    // We’ll build CSV from the same normalized ADIF field map for consistency.
    const rows = lines.map(l => l.fields);

    const escCsv = (v) => {
      const s = (v ?? '').toString();
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const csv = [headers.join(',')]
      .concat(rows.map(r => headers.map(h => escCsv(r[h] ?? '')).join(',')))
      .join('\n');

    this.downloadText(`logbook-${this.todayUtcCompact()}-${qsos.length}qsos.csv`, csv, 'text/csv');
    this.updateStatus('CSV exported');
  }

  exportAdif() {
    const qsos = Array.isArray(this.qsos) ? this.qsos.slice().reverse() : [];
    if (qsos.length === 0) {
      alert('No QSOs to export.');
      return;
    }

    const { adif } = this.buildAdifLines(qsos);
    this.downloadText(`logbook-${this.todayUtcCompact()}-${qsos.length}qsos.adi`, adif, 'text/plain');
    this.updateStatus('ADIF exported');
  }

  todayUtcCompact() {
    const d = new Date();
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  }

  buildAdifLines(qsos) {
    const pad = (n) => `${n}`.padStart(2, '0');
    const adifEscape = (s) => (s ?? '').toString().replace(/\r?\n/g, ' ');
    const field = (name, value) => {
      const v = (value ?? '').toString();
      if (!v) return '';
      return `<${name}:${v.length}>${v}`;
    };

    const header = `Generated by VE3YLO Offline Communication Suite\n<ADIF_VER:5>3.1.4<PROGRAMID:6>VE3YLO<PROGRAMVERSION:6>1.0.0<EOR>\n`;

    const lines = qsos.map(q => {
      const d = new Date(q.tsStartUtc);
      const qso_date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
      const time_on = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

      const mt = this.modeToAdif(q.mode);
      const station_callsign = (q.myCall || '').toString().trim().toUpperCase();
      const my_sig = (q.mySig || '').toString().trim().toUpperCase();
      const my_sig_info = (q.mySigInfo || '').toString().trim().toUpperCase();
      const sig = (q.potaRef || '').toString().trim().toUpperCase() ? 'POTA' : '';
      const sig_info = (q.potaRef || '').toString().trim().toUpperCase();

      const fields = {
        qso_date,
        time_on,
        call: this.sanitizeCallsign(q.call),
        band: (q.band || '').toString(),
        freq: Number.isFinite(q.freqMHz) ? q.freqMHz.toString() : '',
        mode: mt.mode,
        submode: mt.submode,
        rst_sent: (q.rstSent || '').toString(),
        rst_rcvd: (q.rstRcvd || '').toString(),
        station_callsign,
        my_sig,
        my_sig_info,
        sig,
        sig_info,
        gridsquare: (q.grid || '').toString(),
        tx_pwr: Number.isFinite(q.txPowerW) ? q.txPowerW.toString() : '',
        comment: (q.notes || '').toString(),
      };

      // ADIF record
      const record = [
        field('QSO_DATE', fields.qso_date),
        field('TIME_ON', fields.time_on),
        field('CALL', fields.call),
        field('BAND', fields.band),
        field('FREQ', fields.freq),
        field('MODE', fields.mode),
        field('SUBMODE', fields.submode),
        field('RST_SENT', fields.rst_sent),
        field('RST_RCVD', fields.rst_rcvd),
        field('STATION_CALLSIGN', fields.station_callsign),
        field('MY_SIG', my_sig),
        field('MY_SIG_INFO', my_sig_info),
        field('SIG', sig),
        field('SIG_INFO', sig_info),
        field('GRIDSQUARE', fields.gridsquare),
        field('TX_PWR', fields.tx_pwr),
        field('COMMENT', adifEscape(fields.comment)),
      ].filter(Boolean).join('') + '<EOR>';

      return { fields, record };
    });

    const adif = header + lines.map(l => l.record).join('\n') + '\n';
    return { adif, lines };
  }
}

// The module will be initialized by app-main.js after loading
