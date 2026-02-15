/**
 * Amateur Radio Toolkit - Main Application
 * Handles module loading and navigation
 */

// -----------------------------------------------------------------------------
// Licensing / Access gate (XTOC-compatible)
//
// Default behavior mirrors XTOC:
// - On localhost (dev): access gate OFF
// - On non-localhost (production): LICENSE gate ON (forced activation screen)
//
// Validation happens via a tiny server-side proxy hosted alongside the app:
// - https://mkme.org/xcom/license.php
// -----------------------------------------------------------------------------

const XCOM_APP_NAME = 'XCOM\u2122';
const XCOM_PUBLIC_PAGE_URL = 'https://mkme.org/xcom/';

const LS_LICENSE_OK = 'xcom.license.ok';
const LS_LICENSE_KEY = 'xcom.license.key';
const LS_LICENSE_CHECKED_AT = 'xcom.license.checkedAt';

const LS_SIDEBAR_WIDTH = 'xcom.sidebarWidth';
const XCOM_SIDEBAR_DEFAULT_W = 260;
const XCOM_SIDEBAR_MIN_W = 180;
const XCOM_SIDEBAR_MAX_W = XCOM_SIDEBAR_DEFAULT_W;

function xcomClampSidebarWidth(width) {
    const w = Number(width);
    if (!Number.isFinite(w)) return XCOM_SIDEBAR_DEFAULT_W;
    return Math.max(XCOM_SIDEBAR_MIN_W, Math.min(XCOM_SIDEBAR_MAX_W, w));
}

function xcomGetSidebarWidthFromShell(shell) {
    try {
        const raw = String(getComputedStyle(shell).getPropertyValue('--shellSidebarW') || '').trim();
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch (_) {
        // ignore
    }
    return XCOM_SIDEBAR_DEFAULT_W;
}

function xcomApplySidebarWidth(shell, nextWidth) {
    const width = xcomClampSidebarWidth(nextWidth);
    try {
        if (width === XCOM_SIDEBAR_DEFAULT_W) shell.style.removeProperty('--shellSidebarW');
        else shell.style.setProperty('--shellSidebarW', `${width}px`);
    } catch (_) {
        // ignore
    }
    return width;
}

// Forced Offline guards (installed via modules/shared/xtoc/settings.js)
try { globalThis.installForcedOfflineNetworkGuards?.(); } catch (_) { /* ignore */ }
try { globalThis.syncForcedOfflineToServiceWorker?.(); } catch (_) { /* ignore */ }

// -----------------------------------------------------------------------------
// Local backup / restore (data safety)
//
// Reality check:
// - If a user clears "Site data" / uninstalls the PWA, browsers delete localStorage + IndexedDB.
// - The only way to protect against that is an explicit export/import backup.
//
// This backup captures:
// - localStorage keys for XCOM + shared XTOC-style settings (xcom.* + xtoc.*)
// - XTOC packet archive stored in IndexedDB (xcom.xtoc.db)
// -----------------------------------------------------------------------------

const XCOM_BACKUP_V1 = 1;
// NOTE: localStorage is per-origin (not per-path). XCOM shares some XTOC-style settings keys.
// We snapshot both prefixes, but we only *clear* xcom.* on restore to avoid wiping XTOC installs
// that might live on the same origin.
const XCOM_BACKUP_LS_PREFIXES = ['xcom.', 'xtoc.'];
const XCOM_BACKUP_LS_CLEAR_PREFIXES = ['xcom.'];
// Keep XTOC license state out of XCOM backups by default.
const XCOM_BACKUP_LS_EXCLUDE_PREFIXES = ['xtoc.license.'];

const XCOM_XTOC_DB_NAME = 'xcom.xtoc.db';
const XCOM_XTOC_DB_VERSION = 1;
const XCOM_XTOC_STORE_PACKETS = 'packets';

function xcomIsRecord(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
}

function xcomBackupSnapshotLocalStorage() {
    const out = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (!XCOM_BACKUP_LS_PREFIXES.some((p) => k.startsWith(p))) continue;
            if (XCOM_BACKUP_LS_EXCLUDE_PREFIXES.some((p) => k.startsWith(p))) continue;
            const v = localStorage.getItem(k);
            if (v == null) continue;
            out[k] = v;
        }
    } catch (_) {
        // ignore
    }
    return out;
}

function xcomBackupClearLocalStorage() {
    try {
        // Iterate backwards because we're mutating as we go.
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (!XCOM_BACKUP_LS_CLEAR_PREFIXES.some((p) => k.startsWith(p))) continue;
            localStorage.removeItem(k);
        }
    } catch (_) {
        // ignore
    }
}

async function xcomOpenXtocPacketDb() {
    return await new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(XCOM_XTOC_DB_NAME, XCOM_XTOC_DB_VERSION);
            req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(XCOM_XTOC_STORE_PACKETS)) {
                    const store = db.createObjectStore(XCOM_XTOC_STORE_PACKETS, { keyPath: 'key' });
                    store.createIndex('receivedAt', 'receivedAt', { unique: false });
                    store.createIndex('storedAt', 'storedAt', { unique: false });
                    store.createIndex('templateId', 'templateId', { unique: false });
                    store.createIndex('mode', 'mode', { unique: false });
                    store.createIndex('source', 'source', { unique: false });
                    store.createIndex('hasGeo', 'hasGeo', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
        } catch (e) {
            reject(e);
        }
    });
}

async function xcomBackupDumpXtocPackets(opts = {}) {
    const maxRaw = Number(opts.maxPackets);
    const maxPackets = Number.isFinite(maxRaw) ? Math.max(0, Math.floor(maxRaw)) : 50000;

    try {
        const db = await xcomOpenXtocPacketDb();
        return await new Promise((resolve) => {
            const out = [];
            try {
                const tx = db.transaction([XCOM_XTOC_STORE_PACKETS], 'readonly');
                const store = tx.objectStore(XCOM_XTOC_STORE_PACKETS);
                const req = store.openCursor();

                req.onerror = () => resolve({ ok: false, reason: req.error?.message || 'Cursor failed', packets: [] });
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (!cursor) {
                        resolve({ ok: true, packets: out });
                        return;
                    }
                    out.push(cursor.value);
                    if (maxPackets > 0 && out.length >= maxPackets) {
                        resolve({ ok: true, packets: out, truncated: true, maxPackets });
                        return;
                    }
                    cursor.continue();
                };
            } catch (e) {
                resolve({ ok: false, reason: e?.message ? String(e.message) : String(e), packets: [] });
            }
        });
    } catch (e) {
        return { ok: false, reason: e?.message ? String(e.message) : String(e), packets: [] };
    }
}

async function xcomBackupReplaceXtocPackets(packets) {
    const list = Array.isArray(packets) ? packets : [];

    // Basic validation to avoid exploding IndexedDB with garbage input.
    const cleaned = list
        .map((p) => (p && typeof p === 'object' ? p : null))
        .filter((p) => typeof p?.key === 'string' && String(p.key || '').trim().length > 0);

    try {
        const db = await xcomOpenXtocPacketDb();
        return await new Promise((resolve) => {
            let put = 0;
            let skipped = cleaned.length ? (list.length - cleaned.length) : list.length;

            try {
                const tx = db.transaction([XCOM_XTOC_STORE_PACKETS], 'readwrite');
                const store = tx.objectStore(XCOM_XTOC_STORE_PACKETS);

                const clearReq = store.clear();
                clearReq.onerror = () => {
                    // If we can't clear, still attempt to write; worst case it's a merge.
                    for (const rec of cleaned) {
                        try { store.put(rec); put++; } catch (_) { skipped++; }
                    }
                };
                clearReq.onsuccess = () => {
                    for (const rec of cleaned) {
                        try { store.put(rec); put++; } catch (_) { skipped++; }
                    }
                };

                tx.oncomplete = () => resolve({ ok: true, put, skipped });
                tx.onerror = () => resolve({ ok: false, reason: tx.error?.message || 'Transaction failed', put, skipped });
                tx.onabort = () => resolve({ ok: false, reason: tx.error?.message || 'Transaction aborted', put, skipped });
            } catch (e) {
                resolve({ ok: false, reason: e?.message ? String(e.message) : String(e), put, skipped });
            }
        });
    } catch (e) {
        return { ok: false, reason: e?.message ? String(e.message) : String(e), put: 0, skipped: list.length };
    }
}

async function xcomExportBackupJson(opts = {}) {
    const dump = await xcomBackupDumpXtocPackets({ maxPackets: opts.maxPackets });
    const backup = {
        v: XCOM_BACKUP_V1,
        app: 'xcom',
        exportedAt: Date.now(),
        localStorage: xcomBackupSnapshotLocalStorage(),
        xtocPackets: dump.ok ? dump.packets : [],
        ...(dump.ok && dump.truncated ? { truncated: true, maxPackets: dump.maxPackets } : {}),
    };
    return JSON.stringify(backup, null, 2);
}

function xcomParseBackupJson(jsonText) {
    const obj = JSON.parse(String(jsonText || ''));
    if (!xcomIsRecord(obj)) throw new Error('Invalid backup file (not an object).');
    if (obj.v !== XCOM_BACKUP_V1 || obj.app !== 'xcom') throw new Error('Invalid backup file version/app.');
    if (!Number.isFinite(obj.exportedAt)) throw new Error('Invalid backup file (missing exportedAt).');
    if (!xcomIsRecord(obj.localStorage)) throw new Error('Invalid backup file (missing localStorage).');
    if (!Array.isArray(obj.xtocPackets)) throw new Error('Invalid backup file (missing xtocPackets array).');
    return obj;
}

async function xcomImportBackupObject(backup, opts = {}) {
    const replace = opts.replace !== false;

    if (!backup) throw new Error('Missing backup object');
    if (replace) xcomBackupClearLocalStorage();

    // Restore localStorage (only allowed prefixes)
    let lsSet = 0;
    for (const [k, v] of Object.entries(backup.localStorage || {})) {
        if (!XCOM_BACKUP_LS_PREFIXES.some((p) => String(k).startsWith(p))) continue;
        if (XCOM_BACKUP_LS_EXCLUDE_PREFIXES.some((p) => String(k).startsWith(p))) continue;
        try {
            localStorage.setItem(String(k), String(v));
            lsSet++;
        } catch (_) {
            // ignore
        }
    }

    // Restore IndexedDB packet archive
    const putRes = await xcomBackupReplaceXtocPackets(backup.xtocPackets || []);
    if (!putRes.ok) {
        return { ok: false, reason: putRes.reason || 'Packet restore failed', lsSet, packetsPut: putRes.put || 0 };
    }

    return { ok: true, lsSet, packetsPut: putRes.put || 0, packetsSkipped: putRes.skipped || 0 };
}

function xcomDownloadTextFile(filename, text, mime = 'application/json') {
    const blob = new Blob([String(text ?? '')], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(filename || 'xcom-backup.json');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function xcomReadFileAsText(file) {
    return new Promise((resolve, reject) => {
        try {
            if (file && typeof file.text === 'function') {
                file.text().then(resolve, reject);
                return;
            }
        } catch (_) {
            // ignore, fall back to FileReader
        }

        const r = new FileReader();
        r.onerror = () => reject(r.error ?? new Error('Failed to read file'));
        r.onload = () => resolve(String(r.result ?? ''));
        r.readAsText(file);
    });
}

// Expose globals so modules + the license gate can use backup/restore.
try {
    globalThis.xcomExportBackupJson = xcomExportBackupJson;
    globalThis.xcomParseBackupJson = xcomParseBackupJson;
    globalThis.xcomImportBackupObject = xcomImportBackupObject;
    globalThis.xcomDownloadTextFile = xcomDownloadTextFile;
    globalThis.xcomReadFileAsText = xcomReadFileAsText;
} catch (_) { /* ignore */ }

// Cache repair helper:
// - Clears ONLY the XCOM app-shell caches (xcom.sw.*) and unregisters SW(s)
// - Leaves localStorage + IndexedDB intact (your data)
async function xcomRepairAppShell() {
    try {
        // Unregister SW(s) first so the next reload comes from the network.
        if ('serviceWorker' in navigator) {
            try {
                const regs = (navigator.serviceWorker.getRegistrations ? await navigator.serviceWorker.getRegistrations() : []) || [];
                await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
            } catch (_) {
                // Fallback: best-effort unregister current scope.
                try { (await navigator.serviceWorker.getRegistration())?.unregister?.(); } catch (_) { /* ignore */ }
            }
        }

        // Clear XCOM caches (do NOT touch xtoc.tiles.v1, which can be huge).
        if ('caches' in window) {
            try {
                const keys = await caches.keys();
                await Promise.all((keys || []).filter((k) => String(k || '').startsWith('xcom.sw.')).map((k) => caches.delete(k)));
            } catch (_) {
                // ignore
            }
        }
    } finally {
        // Reload no matter what; worst case behaves like a manual refresh.
        window.location.reload();
    }
}

try { globalThis.xcomRepairAppShell = xcomRepairAppShell; } catch (_) { /* ignore */ }

function looksLikeHtmlMessage(value) {
    const s = String(value || '').trim();
    if (!s) return false;
    return /<\s*(?:!doctype|html|head|meta|body|script|style)\b/i.test(s);
}

function normalizeLicenseErrorMessage(message, reason) {
    const raw = String(message || '').trim();
    const isInvalid = String(reason || '').toLowerCase() === 'invalid' || /license\s*invalid|invalid\s*license/i.test(raw);
    if (!raw || looksLikeHtmlMessage(raw) || isInvalid) {
        return 'License invalid. Contact support if this is an error.';
    }
    return raw;
}

function isLocalhost() {
    try {
        return (
            location.hostname === 'localhost' ||
            location.hostname === '127.0.0.1' ||
            location.hostname === '[::1]'
        );
    } catch (_) {
        return false;
    }
}

function getAccessMode() {
    // Overrides (for testing):
    // - URL: ?access=off|license
    // - localStorage: xcom.accessMode = off|license
    try {
        const q = new URLSearchParams(location.search || '');
        const qm = (q.get('access') || '').trim().toLowerCase();
        if (qm === 'off' || qm === 'license') return qm;
    } catch (_) {
        // ignore
    }

    try {
        const gm = (globalThis.XCOM_ACCESS_MODE || '').trim().toLowerCase();
        if (gm === 'off' || gm === 'license') return gm;
    } catch (_) {
        // ignore
    }

    try {
        const lm = (localStorage.getItem('xcom.accessMode') || '').trim().toLowerCase();
        if (lm === 'off' || lm === 'license') return lm;
    } catch (_) {
        // ignore
    }

    return isLocalhost() ? 'off' : 'license';
}

function getDefaultLicenseProxyUrl() {
    try {
        // Hosted next to the app. If you host XCOM at /xcom/, this resolves to /xcom/license.php
        return new URL('./license.php', window.location.href).toString();
    } catch (_) {
        return 'https://www.mkme.org/xcom/license.php';
    }
}

function getLicenseProxyUrl() {
    // Optional runtime override: window.XCOM_LICENSE_PROXY_URL = 'https://.../license.php'
    try {
        const v = (globalThis.XCOM_LICENSE_PROXY_URL || '').trim();
        if (v) return v;
    } catch (_) {
        // ignore
    }
    return getDefaultLicenseProxyUrl();
}

function getStoredLicenseKey() {
    try {
        return (localStorage.getItem(LS_LICENSE_KEY) || '').trim();
    } catch (_) {
        return '';
    }
}

function setStoredLicenseKey(key) {
    try {
        localStorage.setItem(LS_LICENSE_KEY, String(key || '').trim());
    } catch (_) {
        // ignore
    }
}

function setLicensedOk(ok) {
    try {
        localStorage.setItem(LS_LICENSE_OK, ok ? '1' : '0');
        localStorage.setItem(LS_LICENSE_CHECKED_AT, new Date().toISOString());
    } catch (_) {
        // ignore
    }
}

function clearStoredLicense() {
    try {
        localStorage.removeItem(LS_LICENSE_OK);
        localStorage.removeItem(LS_LICENSE_KEY);
        localStorage.removeItem(LS_LICENSE_CHECKED_AT);
    } catch (_) {
        // ignore
    }
}

function isLicensedCached() {
    try {
        return localStorage.getItem(LS_LICENSE_OK) === '1' && getStoredLicenseKey().length > 0;
    } catch (_) {
        return false;
    }
}

async function validateLicenseKeyOnceDetailed(licenseKey, opts = {}) {
    async function callProxyDetailedJson(licenseKey, action, opts = {}) {
        const key = String(licenseKey || '').trim();
        const proxyUrl = getLicenseProxyUrl();
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 20_000;
        const actionRaw = (action || 'validate') + '';
        const mode = actionRaw.trim().toLowerCase() === 'activate' ? 'activate' : 'validate';

        if (!key) {
            return { ok: false, reason: 'missing', message: 'Missing license key', proxyUrl };
        }

        let ctrl = null;
        let t = null;
        try {
            if (typeof AbortController !== 'undefined' && timeoutMs > 0) {
                ctrl = new AbortController();
                t = setTimeout(() => {
                    try { ctrl.abort(); } catch (_) { /* ignore */ }
                }, timeoutMs);
            }

            const res = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ license_key: key, action: mode }),
                signal: ctrl ? ctrl.signal : undefined,
            });

            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch (_) { json = null; }

            if (!res.ok) {
                const msg = (json && (json.message || json.error)) || text || `HTTP ${res.status}`;
                const reason = (json && json.reason) || (res.status === 401 ? 'invalid' : 'http');
                const safeMsg = normalizeLicenseErrorMessage(String(msg), String(reason));
                return { ok: false, reason: String(reason), message: safeMsg, status: res.status, proxyUrl };
            }

            if (!json || json.success !== true) {
                const msg = (json && (json.message || json.error)) || 'License invalid';
                const reason = (json && json.reason) || 'invalid';
                const safeMsg = normalizeLicenseErrorMessage(String(msg), String(reason));
                return { ok: false, reason: String(reason), message: safeMsg, status: res.status, proxyUrl };
            }

            return { ok: true, status: res.status, proxyUrl };
        } catch (e) {
            const name = e && e.name ? String(e.name) : '';
            const aborted = name === 'AbortError';
            return {
                ok: false,
                reason: aborted ? 'timeout' : 'network',
                message: aborted ? 'Timed out' : (e && e.message ? String(e.message) : String(e)),
                proxyUrl,
            };
        } finally {
            if (t) clearTimeout(t);
        }
    }

    async function callProxyDetailedForm(licenseKey, action, opts = {}) {
        const key = String(licenseKey || '').trim();
        const proxyUrl = getLicenseProxyUrl();
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 20_000;
        const actionRaw = (action || 'validate') + '';
        const mode = actionRaw.trim().toLowerCase() === 'activate' ? 'activate' : 'validate';

        if (!key) {
            return { ok: false, reason: 'missing', message: 'Missing license key', proxyUrl };
        }

        let ctrl = null;
        let t = null;
        try {
            if (typeof AbortController !== 'undefined' && timeoutMs > 0) {
                ctrl = new AbortController();
                t = setTimeout(() => {
                    try { ctrl.abort(); } catch (_) { /* ignore */ }
                }, timeoutMs);
            }

            const body = (typeof URLSearchParams !== 'undefined')
                ? new URLSearchParams({ license_key: key, action: mode }).toString()
                : (`license_key=${encodeURIComponent(key)}&action=${encodeURIComponent(mode)}`);
            const res = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                signal: ctrl ? ctrl.signal : undefined,
            });

            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch (_) { json = null; }

            if (!res.ok) {
                const msg = (json && (json.message || json.error)) || text || `HTTP ${res.status}`;
                const reason = (json && json.reason) || (res.status === 401 ? 'invalid' : 'http');
                const safeMsg = normalizeLicenseErrorMessage(String(msg), String(reason));
                return { ok: false, reason: String(reason), message: safeMsg, status: res.status, proxyUrl };
            }

            if (!json || json.success !== true) {
                const msg = (json && (json.message || json.error)) || 'License invalid';
                const reason = (json && json.reason) || 'invalid';
                const safeMsg = normalizeLicenseErrorMessage(String(msg), String(reason));
                return { ok: false, reason: String(reason), message: safeMsg, status: res.status, proxyUrl };
            }

            return { ok: true, status: res.status, proxyUrl };
        } catch (e) {
            const name = e && e.name ? String(e.name) : '';
            const aborted = name === 'AbortError';
            return {
                ok: false,
                reason: aborted ? 'timeout' : 'network',
                message: aborted ? 'Timed out' : (e && e.message ? String(e.message) : String(e)),
                proxyUrl,
            };
        } finally {
            if (t) clearTimeout(t);
        }
    }

    const key = String(licenseKey || '').trim();
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 20_000;
    const actionRaw = (opts.action || 'validate') + '';
    const action = actionRaw.trim().toLowerCase() === 'activate' ? 'activate' : 'validate';

    if (!key) {
        return { ok: false, reason: 'missing', message: 'Missing license key', proxyUrl: getLicenseProxyUrl() };
    }

    if (action === 'validate') {
        const r1 = await callProxyDetailedJson(key, 'validate', { timeoutMs });
        if (r1.ok) return r1;

        // Fallback: some hosts/WAFs choke on JSON POST bodies or strip them.
        if (r1.reason === 'missing_license_key' || r1.reason === 'network' || r1.reason === 'timeout') {
            const r2 = await callProxyDetailedForm(key, 'validate', { timeoutMs });
            if (r2.ok) return r2;
        }

        return r1;
    }

    // action === 'activate'
    const r1 = await callProxyDetailedJson(key, 'activate', { timeoutMs });
    if (r1.ok) return r1;

    // If the server tells us it didn't receive the key, retry activation using form encoding.
    if (r1.reason === 'missing_license_key') {
        const r2 = await callProxyDetailedForm(key, 'activate', { timeoutMs });
        if (r2.ok) return r2;
    }

    // If activation fails due to a network-level error, avoid double-consuming activations.
    // In this case we accept a successful *validate* result as sufficient to unlock the app.
    if (r1.reason === 'network' || r1.reason === 'timeout') {
        const v = await callProxyDetailedForm(key, 'validate', { timeoutMs });
        if (v.ok) return v;
    }

    return r1;
}

async function validateLicenseKeyOnce(licenseKey, opts = {}) {
    const r = await validateLicenseKeyOnceDetailed(licenseKey, opts);
    if (!r.ok) throw new Error(r.message || 'License invalid');
}

async function ensureLicensed(promptLabel) {
    if (isLicensedCached()) return true;

    const existing = getStoredLicenseKey();
    const key = (existing || prompt(`${promptLabel}\n\nEnter your license key:`) || '').trim();
    if (!key) return false;

    const r = await validateLicenseKeyOnceDetailed(key, { action: 'activate' });
    if (r.ok) {
        setStoredLicenseKey(key);
        setLicensedOk(true);
        return true;
    }

    setLicensedOk(false);
    // Keep the cached key so the user can see it (and optionally clear it).
    if (!existing) setStoredLicenseKey(key);
    alert(`License validation failed: ${r.message}\n\nProxy: ${r.proxyUrl}`);
    return false;
}

async function revalidateStoredLicenseIfOnline() {
    // Used by the Update button: if we can reach the proxy, verify the cached key is still valid.
    if (getAccessMode() !== 'license') return { ok: true, checked: false };

    const key = getStoredLicenseKey();
    if (!key) return { ok: false, checked: false, reason: 'missing', message: 'Missing cached license key' };

    if (!navigator.onLine) return { ok: true, checked: false };

    const r = await validateLicenseKeyOnceDetailed(key, { timeoutMs: 6000, action: 'validate' });
    if (r.ok) {
        setLicensedOk(true);
        return { ok: true, checked: true };
    }

    // Only fail-closed on a clear invalid response; other errors mean "could not verify".
    if (r.reason === 'invalid' || r.status === 401) {
        setLicensedOk(false);
        return { ok: false, checked: true, reason: 'invalid', message: r.message };
    }

    return { ok: true, checked: true, warning: r.message, reason: r.reason };
}

function createLicenseGateElement() {
    const wrap = document.createElement('div');
    wrap.id = 'xLicenseGate';
    wrap.className = 'xLicenseGate';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');

    wrap.innerHTML = `
        <div class="xLicenseCard">
            <h1 class="xLicenseTitle">${XCOM_APP_NAME} — License Activation</h1>
            <div class="xPill xLicenseImportant">
                <div><strong>IMPORTANT:</strong> You MUST install the portable web app (PWA) after registration. After you activate your key, install it and launch it from the app icon. Do not rely on running ${XCOM_APP_NAME} from the server URL.</div>
                <div style="margin-top:8px;">
                    <strong>Install it:</strong>
                    <ul>
                        <li><strong>iPhone/iPad (Safari):</strong> Share &gt; Add to Home Screen</li>
                        <li><strong>Android (Chrome):</strong> Menu (3 dots) &gt; Install app (or Add to Home screen)</li>
                        <li><strong>Desktop (Chrome/Edge):</strong> Install icon in the address bar &gt; Install (or Menu &gt; Install)</li>
                    </ul>
                </div>
            </div>

            <p class="xLicenseSubtitle">
                Enter your WooCommerce license key once. After activation, ${XCOM_APP_NAME} works offline forever on this device.
            </p>

            <div class="xLicenseRow">
                <button class="xBtn" id="xLicenseActivateBtn" type="button">Enter / Activate License Key</button>
                <button class="xBtn xBtnSecondary" id="xLicenseClearBtn" type="button" title="Clears the cached license key on this device">Clear Key</button>
            </div>

            <div class="xLicenseRow" style="margin-top:10px;">
                <button class="xBtn xBtnSecondary" id="xLicenseRestoreBtn" type="button" title="Restore XCOM data from a backup JSON file on this device (no server required)">Restore Backup</button>
            </div>
 
            <p class="xLicenseCached" id="xLicenseCachedRow" style="display:none;">
                Cached key on this device: <code id="xLicenseCachedKey"></code>
            </p>

            <div class="xPill xLicenseMessage" id="xLicenseMessage" style="display:none;"></div>

            <div class="xLicenseNotes">
                <h2>Notes</h2>
                <ul>
                    <li>First activation requires internet access.</li>
                    <li>If you clear browser/site data, you’ll need to activate again.</li>
                    <li>This gate is meant to stop casual installs; it’s not DRM.</li>
                </ul>
                <div class="xLicenseLinks">
                    Get XCOM updates/downloads: <a href="${XCOM_PUBLIC_PAGE_URL}" target="_blank" rel="noreferrer">${XCOM_PUBLIC_PAGE_URL}</a>
                </div>
            </div>
        </div>
    `;

    return wrap;
}

function showLicenseGate(initialMessage = '') {
    const existing = document.getElementById('xLicenseGate');
    if (existing) return existing;

    document.body.classList.add('xGateOpen');
    const gate = createLicenseGateElement();
    document.body.appendChild(gate);

    const activateBtn = gate.querySelector('#xLicenseActivateBtn');
    const clearBtn = gate.querySelector('#xLicenseClearBtn');
    const restoreBtn = gate.querySelector('#xLicenseRestoreBtn');
    const cachedRow = gate.querySelector('#xLicenseCachedRow');
    const cachedKeyEl = gate.querySelector('#xLicenseCachedKey');
    const msgEl = gate.querySelector('#xLicenseMessage');

    const setMessage = (msg) => {
        const m = String(msg || '').trim();
        if (!msgEl) return;
        msgEl.style.display = m ? 'block' : 'none';
        msgEl.textContent = m;
    };

    const refreshCachedKey = () => {
        const key = getStoredLicenseKey();
        if (!cachedRow || !cachedKeyEl) return;
        if (key) {
            cachedRow.style.display = 'block';
            cachedKeyEl.textContent = key;
        } else {
            cachedRow.style.display = 'none';
            cachedKeyEl.textContent = '';
        }
    };

    refreshCachedKey();
    setMessage(initialMessage);

    if (activateBtn) activateBtn.focus();

    if (activateBtn) {
        activateBtn.addEventListener('click', async () => {
            try {
                activateBtn.disabled = true;
                activateBtn.textContent = 'Checking…';
                setMessage('');

                const ok = await ensureLicensed('License required');
                if (ok) {
                    try { gate.remove(); } catch (_) { /* ignore */ }
                    document.body.classList.remove('xGateOpen');
                    return;
                }
                setMessage('License not validated. Check the key and ensure you are online for first activation.');
                refreshCachedKey();
            } finally {
                activateBtn.disabled = false;
                activateBtn.textContent = 'Enter / Activate License Key';
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearStoredLicense();
            refreshCachedKey();
            setMessage('Cleared locally stored key. Click “Enter / Activate” to activate again.');
        });
    }

    if (restoreBtn) {
        restoreBtn.addEventListener('click', async () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';

            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                if (!file) return;

                try {
                    restoreBtn.disabled = true;
                    restoreBtn.textContent = 'Restoring…';
                    setMessage('Restoring from backup…');

                    const text = await xcomReadFileAsText(file);
                    const backup = xcomParseBackupJson(text);
                    const res = await xcomImportBackupObject(backup, { replace: true });
                    if (!res || res.ok !== true) {
                        throw new Error(res?.reason || 'Restore failed');
                    }

                    setMessage('Restore complete. Reloading…');
                    await new Promise((r) => setTimeout(r, 150));
                    window.location.reload();
                } catch (e) {
                    const msg = e?.message ? String(e.message) : String(e);
                    setMessage(`Restore failed: ${msg}`);
                } finally {
                    try { input.value = ''; } catch (_) { /* ignore */ }
                    restoreBtn.disabled = false;
                    restoreBtn.textContent = 'Restore Backup';
                }
            }, { once: true });

            input.click();
        });
    }

    return gate;
}

async function requireLicenseActivation(opts = {}) {
    const message = opts && opts.message ? String(opts.message) : '';

    if (getAccessMode() !== 'license') return true;
    if (isLicensedCached()) return true;

    showLicenseGate(message);

    // Wait until activation succeeds.
    while (!isLicensedCached()) {
        await new Promise((r) => setTimeout(r, 250));
    }

    // Gate is removed by the activate handler on success.
    return true;
}

class RadioApp {
    constructor() {
        this.currentModule = null;
        this.moduleContainer = document.getElementById('module-container');
        this.statusText = document.getElementById('statusText');
        this.topbarTitle = document.getElementById('xTopbarTitle');
        this.mobileNavBtn = document.getElementById('xMobileNavBtn');
        this.navBackdrop = document.getElementById('xNavBackdrop');
        this.netPill = document.getElementById('xNetPill');
        this.netValue = document.getElementById('xNetValue');
        this.localTimeEl = document.getElementById('xLocalTime');
        this.utcTimeEl = document.getElementById('xUtcTime');

        this._clockTimer = null;
        this._internetProbeTimer = null;
        this._internetProbeAbort = null;
        this._internetProbeInFlight = false;
        this._connectivityOnline = navigator.onLine;
        this._connectivityHasInternet = false;
        this._connectivityLastOkAt = null;
        this._updatingApp = false;
        this.updateBtn = document.getElementById('xUpdateBtn');
        this.buildBadgeEl = document.getElementById('xBuildBadge');
         
        // Available modules
        this.modules = {
            'repeater-map': {
                name: 'Repeater Map',
                description: 'Find amateur radio repeaters on a map',
                scripts: [
                    'modules/shared/offline-geocoder.js',
                    // Shared XTOC-style mapping helpers (MapLibre + offline raster)
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/offlineTiles.js',
                    'modules/shared/xtoc/ao.js',
                    'modules/shared/xtoc/maplibre.js',
                    // Module
                    'modules/repeater-map/repeater-data.js',
                    'modules/repeater-map/repeater-data-legacy.js',
                    'modules/repeater-map/repeater-map.js'
                ],
                styles: ['styles/modules/repeater-map.css'],
                dependencies: [
                    'assets/vendor/maplibre-gl/maplibre-gl.js',
                    'assets/vendor/maplibre-gl/maplibre-gl.css'
                ]
            },
            'callsign-lookup': {
                name: 'Predict',
                description: 'Offline lookup for USA/Canada amateur callsigns',
                scripts: [
                    'modules/shared/offline-geocoder.js',
                    'modules/shared/callsign-db.js',
                    // Shared XTOC-style mapping helpers (MapLibre + offline raster)
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/offlineTiles.js',
                    'modules/shared/xtoc/ao.js',
                    'modules/shared/xtoc/maplibre.js',
                    // Module
                    'modules/callsign-lookup/callsign-lookup.js'
                ],
                styles: ['styles/modules/callsign-lookup.css'],
                dependencies: [
                    'assets/vendor/maplibre-gl/maplibre-gl.js',
                    'assets/vendor/maplibre-gl/maplibre-gl.css'
                ]
            },
            'ham-clock': {
                name: 'Ham Clock',
                description: 'World clock with day/night greyline and band predictions',
                experimental: true,
                scripts: [
                    'modules/shared/propagation-model.js',
                    'modules/shared/space-weather.js',
                    // Shared XTOC-style mapping helpers (MapLibre + offline raster)
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/offlineTiles.js',
                    'modules/shared/xtoc/ao.js',
                    'modules/shared/xtoc/maplibre.js',
                    'modules/ham-clock/ham-clock.js'
                ],
                styles: ['styles/modules/ham-clock.css'],
                dependencies: [
                    'assets/vendor/maplibre-gl/maplibre-gl.js',
                    'assets/vendor/maplibre-gl/maplibre-gl.css'
                ]
            },
            'shortwave': {
                name: 'Shortwave Broadcasts',
                description: 'Worldwide shortwave broadcasts by time or frequency',
                scripts: [
                    'modules/shortwave/shortwave-data.js',
                    'modules/shortwave/shortwave.js'
                ],
                styles: ['styles/modules/shortwave.css'],
                dependencies: []
            },
            'packet-radio': {
                name: 'Packet Stations',
                description: 'Packet Radio nodes, BBS list, and common frequencies',
                scripts: [
                    'modules/shared/offline-geocoder.js',
                    // Shared XTOC-style mapping helpers (MapLibre + offline raster)
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/offlineTiles.js',
                    'modules/shared/xtoc/ao.js',
                    'modules/shared/xtoc/maplibre.js',
                    // Module
                    'modules/packet-radio/packet-data.js',
                    'modules/packet-radio/packet-radio.js'
                ],
                styles: ['styles/modules/packet-radio.css'],
                dependencies: [
                    'assets/vendor/maplibre-gl/maplibre-gl.js',
                    'assets/vendor/maplibre-gl/maplibre-gl.css'
                ]
            },
            'logbook': {
                name: 'Logbook',
                description: 'QSO logbook with export (ADIF/CSV)',
                // Logbook now includes a small offline map in the "Known operator" card.
                scripts: [
                    'modules/shared/offline-geocoder.js',
                    'modules/shared/callsign-db.js',
                    // Shared XTOC-style mapping helpers (MapLibre + offline raster)
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/offlineTiles.js',
                    'modules/shared/xtoc/ao.js',
                    'modules/shared/xtoc/maplibre.js',
                    // Module
                    'modules/logbook/logbook.js'
                ],
                styles: ['styles/modules/logbook.css'],
                dependencies: [
                    'assets/vendor/maplibre-gl/maplibre-gl.js',
                    'assets/vendor/maplibre-gl/maplibre-gl.css'
                ]
            },
            'ascii-art': {
                name: 'ASCII Art',
                description: 'Make ASCII art for packet radio messages',
                scripts: ['modules/ascii-art/ascii-art.js'],
                styles: ['styles/modules/ascii-art.css'],
                dependencies: []
            },
            'help': {
                name: 'Help',
                description: 'Application help and documentation',
                scripts: ['modules/help/help.js'],
                styles: ['styles/modules/help.css'],
                dependencies: []
            },
            'backup': {
                name: 'Backup',
                description: 'Export/import local data (data safety)',
                scripts: ['modules/backup/backup.js'],
                styles: ['styles/modules/backup.css'],
                dependencies: []
            },
            'map': {
                name: 'Map',
                description: 'Tactical map + AO selection + offline raster tile caching (XTOC-style)',
                scripts: [
                    // Shared XTOC-style mapping helpers
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/offlineTiles.js',
                    'modules/shared/xtoc/ao.js',
                    'modules/shared/xtoc/maplibre.js',
                    'modules/shared/xtoc/teamRoster.js',
                    'modules/shared/xtoc/importedPackets.js',
                    // Module
                    'modules/map/map.js'
                ],
                styles: ['styles/modules/map.css'],
                dependencies: [
                    'assets/vendor/maplibre-gl/maplibre-gl.js',
                    'assets/vendor/maplibre-gl/maplibre-gl.css'
                ]
            },
            'comms': {
                name: 'XTOC Comm',
                description: 'XTOC-compatible packet creation (CLEAR/SECURE) with QR + chunking',
                scripts: [
                    // Shared XTOC logic
                    // Mapping helpers (used by Map module and future map pickers)
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/offlineTiles.js',
                    'modules/shared/xtoc/ao.js',
                    'modules/shared/xtoc/maplibre.js',
                    'modules/shared/xtoc/base64url.js',
                    'modules/shared/xtoc/packet.js',
                    'modules/shared/xtoc/chunking.js',
                    'modules/shared/xtoc/secure.js',
                    'modules/shared/xtoc/secureTemplates.js',
                    'modules/shared/xtoc/storage.js',
                    'modules/shared/xtoc/packetStore.js',
                    'modules/shared/xtoc/teamRoster.js',
                    'modules/shared/xtoc/importedPackets.js',
                    // Auto-ingest incoming Mesh/MANET packets into DB + Map overlay
                    'modules/shared/xtoc/autoIngest.js',
                    'modules/shared/xtoc/keyBundle.js',
                    'modules/shared/xtoc/keyImport.js',
                    // Shared mesh transport (so Comms can Connect + Send without opening Mesh module)
                    'modules/shared/mesh/meshTransport.js',
                    // Shared HaLow transport (so Comms can Connect + Send without opening HaLow module)
                    'modules/shared/halow/halowTransport.js',
                    // Module
                    'modules/comms/comms.js'
                ],
                styles: ['styles/modules/comms.css'],
                dependencies: [
                    'assets/vendor/maplibre-gl/maplibre-gl.js',
                    'assets/vendor/maplibre-gl/maplibre-gl.css'
                ]
            },
            'xtoc-data': {
                name: 'XTOC Data',
                description: 'Stored XTOC packets (list + search)',
                scripts: [
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/base64url.js',
                    'modules/shared/xtoc/packet.js',
                    'modules/shared/xtoc/secure.js',
                    'modules/shared/xtoc/secureTemplates.js',
                    'modules/shared/xtoc/storage.js',
                    'modules/shared/xtoc/packetStore.js',
                    'modules/shared/xtoc/teamRoster.js',
                    'modules/shared/xtoc/importedPackets.js',
                    'modules/xtoc-data/xtoc-data.js'
                ],
                styles: ['styles/modules/xtoc-data.css'],
                dependencies: []
            },
            'mesh': {
                name: 'Mesh',
                description: 'Meshtastic mesh interface (connect/config/test/traffic + map overlay)',
                scripts: [
                    // Shared XTOC-style mapping helpers (for Mesh Map overlay)
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/offlineTiles.js',
                    'modules/shared/xtoc/ao.js',
                    'modules/shared/xtoc/maplibre.js',
                    // XTOC packet helpers + secure decode (so Mesh RX can auto-map packets)
                    'modules/shared/xtoc/base64url.js',
                    'modules/shared/xtoc/packet.js',
                    'modules/shared/xtoc/chunking.js',
                    'modules/shared/xtoc/secure.js',
                    'modules/shared/xtoc/secureTemplates.js',
                    'modules/shared/xtoc/storage.js',
                    'modules/shared/xtoc/packetStore.js',
                    'modules/shared/xtoc/teamRoster.js',
                    'modules/shared/xtoc/importedPackets.js',
                    'modules/shared/xtoc/autoIngest.js',
                    // Shared mesh transport
                    'modules/shared/mesh/meshTransport.js',
                    // Module
                    'modules/mesh/mesh.js'
                ],
                styles: ['styles/modules/mesh.css'],
                dependencies: [
                    'assets/vendor/maplibre-gl/maplibre-gl.js',
                    'assets/vendor/maplibre-gl/maplibre-gl.css'
                ]
            },
            'halow': {
                name: 'MANET',
                description: 'MANET LAN bridge (HaLow/Open MANET) for XTOC master <-> XCOM clients with topology + traffic',
                scripts: [
                    // Shared XTOC helpers (so incoming packets can be auto-mapped even if Comms/Map aren't open)
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/base64url.js',
                    'modules/shared/xtoc/packet.js',
                    'modules/shared/xtoc/chunking.js',
                    'modules/shared/xtoc/secure.js',
                    'modules/shared/xtoc/secureTemplates.js',
                    'modules/shared/xtoc/storage.js',
                    'modules/shared/xtoc/packetStore.js',
                    'modules/shared/xtoc/importedPackets.js',
                    'modules/shared/xtoc/autoIngest.js',
                    // Shared HaLow transport
                    'modules/shared/halow/halowTransport.js',
                    // Module
                    'modules/halow/halow.js'
                ],
                styles: ['styles/modules/halow.css'],
                dependencies: []
            }
            // Additional modules will be added here
        };
        
        this.init();
    }
    
    init() {
        // Bind navigation events
        // Support both legacy header nav (#module-nav a) and the new XTOC-style sidebar (.xNav a).
        // Only wire module nav items (so external links in the sidebar work normally).
        const navLinks = Array.from(document.querySelectorAll('#module-nav a[data-module], .xNav a[data-module]'));
        const getNavHash = (link) => {
            const href = String(link?.getAttribute?.('href') || '').trim();
            if (href.startsWith('#') && href.length > 1) return href.slice(1).trim();
            return String(link?.getAttribute?.('data-module') || '').trim();
        };
        const parseNavHash = (navHash) => {
            const raw = String(navHash || '').trim();
            if (!raw) return { moduleId: '', params: new URLSearchParams() };
            const i = raw.indexOf('?');
            if (i < 0) return { moduleId: raw, params: new URLSearchParams() };
            const moduleId = raw.slice(0, i).trim();
            const qs = raw.slice(i + 1);
            return { moduleId, params: new URLSearchParams(qs) };
        };
        const setActiveNav = (navHash) => {
            const h = String(navHash || '').trim();
            navLinks.forEach(navLink => {
                navLink.classList.remove('active');
            });
            const active = navLinks.find((l) => getNavHash(l) === h) || null;
            if (active) active.classList.add('active');

            const parentHash = String(active?.getAttribute?.('data-nav-parent') || '').trim();
            if (parentHash) {
                const parent = navLinks.find((l) => getNavHash(l) === parentHash) || null;
                if (parent) parent.classList.add('active');
            }
        };
        const applyNavParams = (moduleId, params) => {
            try {
                if (moduleId === 'xtoc-data') {
                    const tpl = Number(params?.get?.('tpl'));
                    if (Number.isFinite(tpl) && tpl > 0) {
                        try { window.xtocDataModule?.setTemplateFilter?.(tpl); } catch (_) { /* ignore */ }
                    } else {
                        try { window.xtocDataModule?.setTemplateFilter?.(null); } catch (_) { /* ignore */ }
                    }
                }
            } catch (_) {
                // ignore
            }
        };

        // ---------------------------------------------------------------------
        // Packet unread badges (template modules under Communication)
        // ---------------------------------------------------------------------

        const XCOM_PACKET_UNREAD_LS_PREFIX = 'xcom.packets.unread.v1.';
        const XCOM_PACKET_UNREAD_DWELL_MS = 1100;
        const XCOM_TEMPLATE_ID_TO_UNREAD_KEY = {
            1: 'sitrep',
            2: 'contacts',
            3: 'tasks',
            4: 'checkins',
            5: 'resources',
            6: 'assets',
             7: 'zones',
             8: 'missions',
             9: 'events',
             10: 'phaselines',
         };
        const XCOM_PACKET_UNREAD_KEYS = Object.values(XCOM_TEMPLATE_ID_TO_UNREAD_KEY);

        const xcomUnreadLsKey = (key) => `${XCOM_PACKET_UNREAD_LS_PREFIX}seenAt.${key}`;
        const xcomUnreadReadTs = (storageKey) => {
            try {
                const raw = localStorage.getItem(storageKey);
                if (!raw) return null;
                const n = Number(raw);
                return Number.isFinite(n) && n > 0 ? n : null;
            } catch (_) {
                return null;
            }
        };
        const xcomUnreadWriteTs = (storageKey, ts) => {
            try { localStorage.setItem(storageKey, String(Math.floor(Number(ts) || Date.now()))); } catch (_) { /* ignore */ }
        };
        const xcomUnreadLoadSeenAt = (nowTs) => {
            const now = Number.isFinite(Number(nowTs)) && Number(nowTs) > 0 ? Math.floor(Number(nowTs)) : Date.now();
            const out = {};
            for (const key of XCOM_PACKET_UNREAD_KEYS) {
                const k = String(key || '').trim();
                if (!k) continue;
                const sk = xcomUnreadLsKey(k);
                const v = xcomUnreadReadTs(sk);
                if (v == null) {
                    xcomUnreadWriteTs(sk, now);
                    out[k] = now;
                } else {
                    out[k] = v;
                }
            }
            return out;
        };
        const xcomUnreadDefaultCounts = () => {
            const out = {};
            for (const key of XCOM_PACKET_UNREAD_KEYS) out[key] = 0;
            return out;
        };

        let xcomUnreadSeenAt = xcomUnreadLoadSeenAt(Date.now());
        let xcomUnreadDbPromise = null;
        const xcomUnreadOpenDb = () => {
            if (!xcomUnreadDbPromise) xcomUnreadDbPromise = xcomOpenXtocPacketDb();
            return xcomUnreadDbPromise;
        };

        const xcomUnreadComputeUnseenCounts = async () => {
            const counts = xcomUnreadDefaultCounts();

            let minSeenAt = Infinity;
            for (const key of XCOM_PACKET_UNREAD_KEYS) {
                minSeenAt = Math.min(minSeenAt, Number(xcomUnreadSeenAt[key]) || 0);
            }
            if (!Number.isFinite(minSeenAt) || minSeenAt <= 0) minSeenAt = 0;

            try {
                const db = await xcomUnreadOpenDb();
                return await new Promise((resolve) => {
                    try {
                        const tx = db.transaction([XCOM_XTOC_STORE_PACKETS], 'readonly');
                        const store = tx.objectStore(XCOM_XTOC_STORE_PACKETS);
                        const idx = store.index('receivedAt');
                        const req = idx.openCursor(null, 'prev');

                        req.onerror = () => resolve(counts);
                        req.onsuccess = () => {
                            const cursor = req.result;
                            if (!cursor) {
                                resolve(counts);
                                return;
                            }

                            const rec = cursor.value || null;
                            const receivedAt = Number(rec?.receivedAt || rec?.storedAt || 0) || 0;
                            if (receivedAt <= minSeenAt) {
                                resolve(counts);
                                return;
                            }

                            const tpl = Number(rec?.templateId || 0) || 0;
                            const key = XCOM_TEMPLATE_ID_TO_UNREAD_KEY[tpl] || null;
                            if (key) {
                                const seenAt = Number(xcomUnreadSeenAt[key]) || 0;
                                if (receivedAt > seenAt) counts[key] += 1;
                            }

                            cursor.continue();
                        };
                    } catch (_) {
                        resolve(counts);
                    }
                });
            } catch (_) {
                return counts;
            }
        };

        const xcomFormatBadgeText = (n) => (n > 99 ? '99+' : String(n));
        const xcomSetBadgeEl = (el, count, ariaLabel) => {
            try {
                if (!el) return;
                const n = Number(count) || 0;
                if (n <= 0) {
                    el.textContent = '';
                    el.style.display = 'none';
                    el.setAttribute('aria-hidden', 'true');
                    el.removeAttribute('aria-label');
                    return;
                }
                el.textContent = xcomFormatBadgeText(n);
                el.style.display = 'inline-flex';
                el.removeAttribute('aria-hidden');
                if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
                else el.setAttribute('aria-label', `${n} new packets`);
            } catch (_) {
                // ignore
            }
        };
        const xcomUnreadSumCounts = (counts) => {
            let sum = 0;
            for (const key of XCOM_PACKET_UNREAD_KEYS) sum += (Number(counts?.[key]) || 0);
            return sum;
        };

        let xcomUnreadRefreshSeq = 0;
        const xcomRefreshUnreadBadges = async () => {
            const seq = ++xcomUnreadRefreshSeq;
            const counts = await xcomUnreadComputeUnseenCounts();
            if (seq !== xcomUnreadRefreshSeq) return;

            const sum = xcomUnreadSumCounts(counts);

            try {
                document.querySelectorAll('[data-unread-key]').forEach((el) => {
                    const key = String(el?.getAttribute?.('data-unread-key') || '').trim();
                    if (!key) return;
                    xcomSetBadgeEl(el, counts[key] || 0, `${Number(counts[key] || 0) || 0} new packets`);
                });
            } catch (_) {
                // ignore
            }

            try {
                document.querySelectorAll('[data-unread-sum]').forEach((el) => {
                    const scope = String(el?.getAttribute?.('data-unread-sum') || '').trim();
                    if (!scope) return;
                    if (scope === 'comms') xcomSetBadgeEl(el, sum, `${sum} new packets`);
                });
            } catch (_) {
                // ignore
            }
        };

        const xcomUnreadMarkSeen = (key, ts) => {
            const k = String(key || '').trim();
            if (!k) return;
            const t = Math.floor(Number.isFinite(Number(ts)) && Number(ts) > 0 ? Number(ts) : Date.now());
            xcomUnreadWriteTs(xcomUnreadLsKey(k), t);
            xcomUnreadSeenAt[k] = t;
            void xcomRefreshUnreadBadges();
        };

        let xcomUnreadActiveTemplateKey = null;
        let xcomUnreadDwellDone = false;
        let xcomUnreadDwellTimer = null;
        const xcomSetActiveTemplateView = (navHash) => {
            try { if (xcomUnreadDwellTimer) clearTimeout(xcomUnreadDwellTimer); } catch (_) { /* ignore */ }
            xcomUnreadDwellTimer = null;
            xcomUnreadActiveTemplateKey = null;
            xcomUnreadDwellDone = false;

            const { moduleId, params } = parseNavHash(navHash);
            if (moduleId !== 'xtoc-data') return;

            const tpl = Number(params?.get?.('tpl'));
            const key = XCOM_TEMPLATE_ID_TO_UNREAD_KEY[tpl] || null;
            if (!key) return;

            xcomUnreadActiveTemplateKey = key;
            xcomUnreadDwellTimer = setTimeout(() => {
                xcomUnreadDwellTimer = null;
                xcomUnreadDwellDone = true;
                xcomUnreadMarkSeen(key);
            }, XCOM_PACKET_UNREAD_DWELL_MS);
        };

        // Refresh badges on packet changes. If the user is already viewing a template
        // module after the dwell time, auto-clear (markSeen) like XTOC.
        const xcomOnPacketsUpdated = () => {
            if (xcomUnreadActiveTemplateKey && xcomUnreadDwellDone) {
                xcomUnreadMarkSeen(xcomUnreadActiveTemplateKey);
                return;
            }
            void xcomRefreshUnreadBadges();
        };
        try { globalThis.addEventListener('xcomXtocPacketsUpdated', xcomOnPacketsUpdated); } catch (_) { /* ignore */ }
        try {
            window.addEventListener('storage', (e) => {
                const k = String(e?.key || '');
                if (!k || !k.startsWith(XCOM_PACKET_UNREAD_LS_PREFIX)) return;
                xcomUnreadSeenAt = xcomUnreadLoadSeenAt(Date.now());
                void xcomRefreshUnreadBadges();
            });
        } catch (_) {
            // ignore
        }

        // Initial badge paint
        void xcomRefreshUnreadBadges();
        navLinks.forEach(link => {
            link.addEventListener('click', async (e) => {
                e.preventDefault();
                const navHash = getNavHash(link);
                const { moduleId, params } = parseNavHash(navHash);

                // Keep the URL hash in sync so users can deep-link / bookmark modules.
                // This also makes it easier to restore the last-viewed module on reload.
                try {
                    if (navHash) window.location.hash = navHash;
                } catch (_) {
                    // ignore
                }

                await this.loadModule(moduleId);
                applyNavParams(moduleId, params);
                xcomSetActiveTemplateView(navHash);
                
                // Update active navigation
                setActiveNav(navHash);
                this.closeMobileNav();
            });
        });

        this.setupSidebarResizer();
        this.setupMobileNav();
        this.setupTopbarIndicators();
        
        // Load module from URL hash if present, otherwise default to first in navigation.
        const hash = (window.location.hash || '').replace('#', '').trim();
        const savedModule = this.getSavedModule();
        const firstNav = navLinks[0] || null;
        const defaultNavHash = firstNav ? getNavHash(firstNav) : null;
        const mobileDefaultNavHash = (this.isMobileView() && this.modules['comms']) ? 'comms' : defaultNavHash;
        const { moduleId: hashModuleId } = parseNavHash(hash);
        const initialNavHash =
            (hash && hashModuleId && this.modules[hashModuleId]) ? hash :
            (savedModule && this.modules[savedModule]) ? savedModule :
            mobileDefaultNavHash;
        if (initialNavHash) {
            setActiveNav(initialNavHash);
            const { moduleId, params } = parseNavHash(initialNavHash);
            void this.loadModule(moduleId).then(() => {
                applyNavParams(moduleId, params);
                xcomSetActiveTemplateView(initialNavHash);
            });
        }
    }
    
    async loadModule(moduleId) {
        if (!this.modules[moduleId]) {
            this.updateStatus(`Error: Module "${moduleId}" not found`);
            return;
        }

        this.setTopbarTitleForModule(moduleId);
        this.updateStatus(`Loading ${this.modules[moduleId].name} module...`);
        this.moduleContainer.innerHTML = '<div class="loading-indicator">Loading...</div>';
        
        try {
            // Load module dependencies
            await this.loadDependencies(moduleId);
            
            // Load module styles
            this.loadStyles(moduleId);
            
            // Create module container
            const moduleElement = document.createElement('div');
            moduleElement.id = moduleId;
            moduleElement.className = 'module';
            this.moduleContainer.innerHTML = '';
            this.moduleContainer.appendChild(moduleElement);
            
            // Load module scripts
            await this.loadScripts(moduleId);
            
            // Initialize the module
            // We need to manually trigger the module initialization since the DOMContentLoaded
            // event has already fired by the time the module scripts are loaded
            if (moduleId === 'repeater-map' && typeof RepeaterMap === 'function') {
                window.repeaterMapModule = new RepeaterMap();
            } else if (moduleId === 'callsign-lookup' && typeof CallsignLookupModule === 'function') {
                window.callsignLookupModule = new CallsignLookupModule();
            } else if (moduleId === 'ham-clock' && typeof HamClockModule === 'function') {
                window.hamClockModule = new HamClockModule();
            } else if (moduleId === 'shortwave' && typeof ShortwaveModule === 'function') {
                window.shortwaveModule = new ShortwaveModule();
            } else if (moduleId === 'packet-radio' && typeof PacketRadioModule === 'function') {
                window.packetRadioModule = new PacketRadioModule();
            } else if (moduleId === 'logbook' && typeof LogbookModule === 'function') {
                window.logbookModule = new LogbookModule();
            } else if (moduleId === 'ascii-art' && typeof AsciiArtModule === 'function') {
                window.asciiArtModule = new AsciiArtModule();
            } else if (moduleId === 'help' && typeof HelpModule === 'function') {
                window.helpModule = new HelpModule();
            } else if (moduleId === 'backup' && typeof BackupModule === 'function') {
                window.backupModule = new BackupModule();
            } else if (moduleId === 'map' && typeof MapModule === 'function') {
                window.mapModule = new MapModule();
            } else if (moduleId === 'comms' && typeof CommsModule === 'function') {
                window.commsModule = new CommsModule();
            } else if (moduleId === 'xtoc-data' && typeof XtocDataModule === 'function') {
                window.xtocDataModule = new XtocDataModule();
            } else if (moduleId === 'mesh' && typeof MeshModule === 'function') {
                window.meshModule = new MeshModule();
            } else if (moduleId === 'halow' && typeof HaLowModule === 'function') {
                window.halowModule = new HaLowModule();
            }

            // Add UI affordances shared across modules (ex: hide/show the "What you can do here" intro).
            try { this.decorateModuleIntros(moduleId); } catch (_) { /* ignore */ }
            
            this.currentModule = moduleId;
            this.saveCurrentModule(moduleId);
            this.updateStatus(`${this.modules[moduleId].name} module loaded`);
        } catch (error) {
            console.error('Error loading module:', error);
            this.updateStatus(`Error loading module: ${error.message}`);
            this.moduleContainer.innerHTML = `<div class="error-message">Failed to load module: ${error.message}</div>`;
        }
    }
    
    async loadDependencies(moduleId) {
        const dependencies = this.modules[moduleId].dependencies || [];
        
        for (const dependency of dependencies) {
            if (dependency.endsWith('.js')) {
                // Load JS deps.
                await this.loadScript(dependency);
            } else if (dependency.endsWith('.css')) {
                this.loadStyle(dependency);
            }
        }
    }
    
    loadStyles(moduleId) {
        const styles = this.modules[moduleId].styles || [];
        
        // Remove any previously loaded module styles
        document.querySelectorAll('link[data-module-style]').forEach(link => {
            link.remove();
        });
        
        // Load new module styles
        styles.forEach(style => {
            this.loadStyle(style, true);
        });
    }
    
    loadStyle(href, isModuleStyle = false) {
        // Check if style is already loaded
        if (document.querySelector(`link[href="${href}"]`)) {
            return;
        }
        
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        if (isModuleStyle) {
            link.setAttribute('data-module-style', 'true');
        }
        document.head.appendChild(link);
    }
    
    async loadScripts(moduleId) {
        const scripts = this.modules[moduleId].scripts || [];
        
        for (const script of scripts) {
            await this.loadScript(script);
        }
    }
    
    loadScript(src) {
        return new Promise((resolve, reject) => {
            // Check if script is already loaded.
            // Note: we append a cache-busting query string later ("?v=...").
            // Some modules share scripts (e.g., offline-geocoder.js). If we only
            // check for an exact match, we may inject the same script multiple
            // times with different query strings, which can cause "Identifier has
            // already been declared" errors.
            const isAlreadyLoaded = Array.from(document.querySelectorAll('script[src]')).some(s => {
                const existingSrc = s.getAttribute('src') || '';
                return existingSrc === src || existingSrc.startsWith(src + '?');
            });
            if (isAlreadyLoaded) {
                resolve();
                return;
            }
            
            const script = document.createElement('script');
            const cacheBust = src.includes('?') ? `${src}&v=offline` : `${src}?v=offline`;
            script.src = cacheBust;

            // Fail fast so offline / no-route scenarios don't leave the UI stuck on a black screen.
            const timeoutMs = 12_000;
            const t = setTimeout(() => {
                try { script.remove(); } catch (_) { /* ignore */ }
                reject(new Error(`Timed out loading script: ${src}`));
            }, timeoutMs);

            script.onload = () => {
                clearTimeout(t);
                resolve();
            };
            script.onerror = () => {
                clearTimeout(t);
                reject(new Error(`Failed to load script: ${src}`));
            };
            document.body.appendChild(script);
        });
    }
    
    updateStatus(message) {
        this.statusText.textContent = message;
        console.log(message);
    }

    setupTopbarIndicators() {
        this.setupClocks();
        this.setupConnectivityStatus();
        this.setupUpdateButton();
        this.setupBuildBadge();
    }

    setupUpdateButton() {
        if (!this.updateBtn) return;
        this.updateBtn.addEventListener('click', () => this.updateAppAndReload());
    }

    setupBuildBadge() {
        if (!this.buildBadgeEl) return;

        const el = this.buildBadgeEl;

        const getBuildLabel = () => {
            // Preferred: injected at build/package time (XTOC-style).
            try {
                const v = String(globalThis.XCOM_BUILD_LABEL || '').trim();
                if (v) return v;
            } catch (_) { /* ignore */ }

            // Fallback: whatever is already in the DOM (kept up to date by make-release.js).
            try {
                return String(el.textContent || '').trim();
            } catch (_) {
                return '';
            }
        };

        const getSwBuildShort = (v) => {
            const s = String(v || '').trim();
            if (!s) return 'unknown';
            if (s === '…' || s === 'off' || s === 'unknown') return s;
            return s.length > 12 ? s.slice(0, 8) : s;
        };

        const render = (swBuildVersion) => {
            const label = getBuildLabel();
            if (label) {
                const semver = label.match(/(\d+\.\d+\.\d+)/)?.[1] || '';
                const text = semver ? `v${semver}` : label;

                const titleParts = [];
                if (semver) {
                    titleParts.push(`App version: ${semver}`);
                    const normalized = label === semver || label === `v${semver}` ? '' : label;
                    if (normalized) titleParts.push(`Build label: ${normalized}`);
                } else {
                    titleParts.push(`Build label: ${label}`);
                }
                if (swBuildVersion && swBuildVersion !== '…' && swBuildVersion !== 'off' && swBuildVersion !== 'unknown') {
                    titleParts.push(`SW build: ${swBuildVersion}`);
                }
                const title = titleParts.join(' — ');

                try { el.textContent = text; } catch (_) { /* ignore */ }
                try { el.title = title; } catch (_) { /* ignore */ }
                try { el.setAttribute('aria-label', title); } catch (_) { /* ignore */ }
                return;
            }

            const title = `Service worker build: ${String(swBuildVersion || 'unknown')}`;
            const short = getSwBuildShort(swBuildVersion);
            try { el.textContent = `SW ${short}`; } catch (_) { /* ignore */ }
            try { el.title = title; } catch (_) { /* ignore */ }
            try { el.setAttribute('aria-label', title); } catch (_) { /* ignore */ }
        };

        const withTimeout = async (p, ms) => {
            let t = null;
            try {
                return await Promise.race([
                    p,
                    new Promise((resolve) => {
                        t = setTimeout(() => resolve(null), ms);
                    }),
                ]);
            } finally {
                if (t) clearTimeout(t);
            }
        };

        const requestSwBuildVersion = async (sw, timeoutMs = 1500) => {
            return await new Promise((resolve) => {
                const requestId = Math.random().toString(36).slice(2);

                const cleanup = () => {
                    clearTimeout(t);
                    try { navigator.serviceWorker.removeEventListener('message', onMessage); } catch (_) { /* ignore */ }
                };

                const onMessage = (e) => {
                    const d = e && e.data;
                    if (!d || d.type !== 'SW_BUILD_VERSION' || typeof d.version !== 'string') return;
                    const id = d.requestId ?? d.id;
                    if (id && id !== requestId) return;
                    cleanup();
                    resolve(d.version);
                };

                const t = setTimeout(() => {
                    cleanup();
                    resolve(null);
                }, timeoutMs);

                // Fallback path: listen for a global SW message response (works even without MessageChannel support).
                try { navigator.serviceWorker.addEventListener('message', onMessage); } catch (_) { /* ignore */ }

                // Preferred: MessageChannel reply (avoids interference from other SW messages).
                if (typeof MessageChannel !== 'undefined') {
                    try {
                        const ch = new MessageChannel();
                        ch.port1.onmessage = (e) => onMessage(e);
                        try { ch.port1.start?.(); } catch (_) { /* ignore */ }
                        sw.postMessage({ type: 'GET_SW_BUILD_VERSION', requestId }, [ch.port2]);
                        return;
                    } catch (_) {
                        // Fall through to non-MessageChannel path.
                    }
                }

                try {
                    sw.postMessage({ type: 'GET_SW_BUILD_VERSION', requestId });
                } catch (_) {
                    cleanup();
                    resolve(null);
                }
            });
        };

        const inferSwBuildVersionFromCaches = async () => {
            try {
                if (!('caches' in window)) return null;
                const keys = await caches.keys();

                const versions = new Set();
                for (const k of keys || []) {
                    if (typeof k !== 'string') continue;
                    if (!k.startsWith('xcom.sw.')) continue;
                    const i = k.lastIndexOf('.');
                    const v = i > 0 ? k.slice(0, i) : k;
                    if (v) versions.add(v);
                }

                const all = Array.from(versions);
                if (!all.length) return null;

                // Prefer the highest numeric "xcom.sw.vN" if present.
                let best = null;
                let bestNum = null;
                for (const v of all) {
                    const m = v.match(/^xcom\\.sw\\.v(\\d+)$/);
                    if (!m) continue;
                    const n = Number(m[1]);
                    if (!Number.isFinite(n)) continue;
                    if (bestNum === null || n > bestNum) {
                        bestNum = n;
                        best = v;
                    }
                }
                if (best) return best;

                all.sort();
                return all[all.length - 1] || null;
            } catch (_) {
                return null;
            }
        };

        const refresh = async () => {
            if (!('serviceWorker' in navigator)) {
                render('off');
                return;
            }

            render('…');

            const reg =
                (await withTimeout(navigator.serviceWorker.getRegistration(), 1500)) ||
                (await withTimeout(navigator.serviceWorker.ready, 2000));
            const sw = navigator.serviceWorker.controller || reg?.active || reg?.waiting || reg?.installing || null;
            if (!sw) {
                render('off');
                return;
            }

            const v = await requestSwBuildVersion(sw);
            if (v) {
                render(v);
                return;
            }

            // Backward-compat: if the active SW is older and doesn't support the message, infer from Cache Storage.
            const inferred = await inferSwBuildVersionFromCaches();
            render(inferred || 'unknown');
        };

        void refresh();

        const onController = () => void refresh();
        try {
            navigator.serviceWorker.addEventListener('controllerchange', onController);
        } catch (_) { /* ignore */ }
    }
 
    async updateAppAndReload() {
        // Mirror XTOC: a single click should ensure SW is registered, trigger an update check, then reload.
        if (this._updatingApp) return;
        this._updatingApp = true;

        const setBtnState = (label, disabled) => {
            if (!this.updateBtn) return;
            try { this.updateBtn.textContent = label; } catch (_) { /* ignore */ }
            try { this.updateBtn.disabled = !!disabled; } catch (_) { /* ignore */ }
        };

        setBtnState('Updating…', true);

        try {
            // Keep dev predictable: do NOT register a service worker on localhost.
            if (isLocalhost()) {
                window.location.reload();
                return;
            }

            // If we're online and can reach the proxy, ensure the cached license is still valid before updating.
            const licenseCheck = await revalidateStoredLicenseIfOnline();
            if (!licenseCheck.ok) {
                // Force re-activation.
                await requireLicenseActivation({ message: 'License not validated. Please re-activate to update.' });
            }

            if (!('serviceWorker' in navigator)) {
                window.location.reload();
                return;
            }

            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const withTimeout = async (p, ms) => {
                let t = null;
                try {
                    return await Promise.race([
                        p,
                        new Promise((resolve) => {
                            t = setTimeout(() => resolve(null), ms);
                        }),
                    ]);
                } finally {
                    if (t) clearTimeout(t);
                }
            };

            // 1) Get existing registration if possible
            let reg = await navigator.serviceWorker.getRegistration();

            // 2) If not ready yet (common early load), wait briefly for ready
            if (!reg) {
                const readyReg = await withTimeout(navigator.serviceWorker.ready, 2000);
                if (readyReg) reg = readyReg;
            }

            // 3) Last resort: register explicitly (safe even if auto-register is present)
            if (!reg) {
                try {
                    reg = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
                } catch (_) {
                    // ignore; we'll still reload below
                }
            }

            // 4) Trigger update check, yield a tick, then reload
            try { await reg && reg.update ? reg.update() : null; } catch (_) { /* ignore */ }
            await sleep(100);
        } finally {
            // Always reload; worst case behaves like manual refresh
            window.location.reload();
        }
    }

    isMobileView() {
        try {
            return window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
        } catch (_) {
            return window.innerWidth <= 900;
        }
    }

    setupSidebarResizer() {
        const shell = document.querySelector('.appShell');
        const handle = document.getElementById('xSidebarResizer');
        if (!shell || !handle) return;

        // Restore saved width (desktop only)
        try {
            const raw = localStorage.getItem(LS_SIDEBAR_WIDTH);
            if (raw) {
                const parsed = Number.parseFloat(String(raw));
                if (Number.isFinite(parsed)) {
                    const width = xcomApplySidebarWidth(shell, parsed);
                    if (width === XCOM_SIDEBAR_DEFAULT_W) localStorage.removeItem(LS_SIDEBAR_WIDTH);
                }
            }
        } catch (_) {
            // ignore
        }

        handle.addEventListener('pointerdown', (e) => {
            if (this.isMobileView()) return;
            if (e.button !== 0) return;

            e.preventDefault();
            try { handle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }

            document.body.classList.add('xSidebarResizing');
            const startX = e.clientX;
            const startW = xcomGetSidebarWidthFromShell(shell);
            let lastW = startW;

            const onMove = (ev) => {
                lastW = xcomApplySidebarWidth(shell, startW + (ev.clientX - startX));
            };

            const onEnd = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onEnd);
                window.removeEventListener('pointercancel', onEnd);
                document.body.classList.remove('xSidebarResizing');
                try {
                    if (lastW === XCOM_SIDEBAR_DEFAULT_W) localStorage.removeItem(LS_SIDEBAR_WIDTH);
                    else localStorage.setItem(LS_SIDEBAR_WIDTH, String(lastW));
                } catch (_) {
                    // ignore
                }
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onEnd);
            window.addEventListener('pointercancel', onEnd);
        });
    }

    setupMobileNav() {
        if (!this.mobileNavBtn || !this.navBackdrop) return;

        this.mobileNavBtn.addEventListener('click', () => {
            const isOpen = document.body.classList.contains('xNavOpen');
            this.setMobileNavOpen(!isOpen);
        });

        this.navBackdrop.addEventListener('click', () => this.closeMobileNav());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeMobileNav();
        });

        window.addEventListener('resize', () => {
            if (!this.isMobileView()) this.closeMobileNav();
        });
    }

    setMobileNavOpen(isOpen) {
        document.body.classList.toggle('xNavOpen', !!isOpen);
        try {
            this.mobileNavBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        } catch (_) {
            // ignore
        }
    }

    closeMobileNav() {
        this.setMobileNavOpen(false);
    }

    setTopbarTitleForModule(moduleId) {
        const module = this.modules[moduleId] || null;
        const name = module?.name || XCOM_APP_NAME;
        const displayName = module?.experimental ? `${name} (Experimental)` : name;
        if (this.topbarTitle) this.topbarTitle.textContent = displayName;
        try {
            document.title = name === XCOM_APP_NAME ? name : `${XCOM_APP_NAME} — ${name}`;
        } catch (_) {
            // ignore
        }
    }

    getSavedModule() {
        try {
            const v = localStorage.getItem('xcom:lastModule');
            return (v || '').trim() || null;
        } catch (_) {
            return null;
        }
    }

    saveCurrentModule(moduleId) {
        try {
            if (!moduleId) return;
            localStorage.setItem('xcom:lastModule', moduleId);
        } catch (_) {
            // ignore
        }
    }

    // ---------------------------------------------------------------------
    // Module intro ("What you can do here") hide (XTOC-style)
    // ---------------------------------------------------------------------

    getModuleIntroHiddenKey(moduleId) {
        const id = String(moduleId || '').trim();
        return id ? `xcom.intro.hidden.${id}` : 'xcom.intro.hidden.unknown';
    }

    isModuleIntroHidden(moduleId) {
        try {
            return localStorage.getItem(this.getModuleIntroHiddenKey(moduleId)) === '1';
        } catch (_) {
            return false;
        }
    }

    setModuleIntroHidden(moduleId, hidden) {
        try {
            localStorage.setItem(this.getModuleIntroHiddenKey(moduleId), hidden ? '1' : '0');
        } catch (_) {
            // ignore
        }
    }

    removeModuleIntros(root) {
        const intros = Array.from(root.querySelectorAll('.xModuleIntro'));
        for (const intro of intros) {
            try {
                intro.remove();
            } catch (_) {
                try { intro.style.display = 'none'; } catch (_) { /* ignore */ }
            }
        }
    }

    decorateModuleIntros(moduleId) {
        const root = document.getElementById(moduleId);
        if (!root) return;

        const intros = Array.from(root.querySelectorAll('.xModuleIntro'));
        if (intros.length === 0) return;

        // If the user already hid this card, don't show it again.
        if (this.isModuleIntroHidden(moduleId)) {
            this.removeModuleIntros(root);
            return;
        }

        // Ensure each intro has a Hide button (mirrors XTOC).
        for (const intro of intros) {
            if (intro.querySelector('.xModuleIntroHideBtn')) continue;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'xModuleIntroHideBtn';
            btn.setAttribute('data-module-intro-hide', String(moduleId || ''));
            btn.title = 'Hide this help card';
            btn.setAttribute('aria-label', 'Hide this help card');
            btn.textContent = 'Hide';
            intro.insertBefore(btn, intro.firstChild);
        }

        // Bind once per module root (module DOM is replaced on navigation).
        if (root.getAttribute('data-intro-hide-bound') === '1') return;
        root.setAttribute('data-intro-hide-bound', '1');

        root.addEventListener('click', (e) => {
            const t = e?.target;
            const btn = t && typeof t.closest === 'function' ? t.closest('.xModuleIntroHideBtn') : null;
            if (!btn) return;

            e.preventDefault();
            e.stopPropagation();

            this.setModuleIntroHidden(moduleId, true);
            this.removeModuleIntros(root);
        });
    }

    setupClocks() {
        // Update once immediately, then every second.
        this.updateClocks();
        if (this._clockTimer) clearInterval(this._clockTimer);
        this._clockTimer = setInterval(() => this.updateClocks(), 1000);
    }

    updateClocks() {
        const now = new Date();
        if (this.localTimeEl) this.localTimeEl.textContent = this.formatTimeHHMMSS(now);
        if (this.utcTimeEl) this.utcTimeEl.textContent = this.formatTimeUtcHHMMSS(now);
    }

    formatTimeHHMMSS(d) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    formatTimeUtcHHMMSS(d) {
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        const ss = String(d.getUTCSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    isForcedOfflineEnabled() {
        try {
            const fn = globalThis.getForcedOfflineEnabled;
            if (typeof fn === 'function') return !!fn();
        } catch (_) { /* ignore */ }

        try {
            return (localStorage.getItem('xtoc.forcedOffline') || '') === '1';
        } catch (_) {
            return false;
        }
    }

    toggleForcedOffline() {
        let next = false;

        try {
            const fn = globalThis.toggleForcedOfflineEnabled;
            if (typeof fn === 'function') {
                next = !!fn();
            } else {
                next = !this.isForcedOfflineEnabled();
                try {
                    if (next) localStorage.setItem('xtoc.forcedOffline', '1');
                    else localStorage.removeItem('xtoc.forcedOffline');
                } catch (_) { /* ignore */ }
            }
        } catch (_) {
            // ignore
        }

        try { globalThis.syncForcedOfflineToServiceWorker?.(); } catch (_) { /* ignore */ }

        if (next) {
            this._connectivityHasInternet = false;
            this.stopInternetProbe();
        } else {
            this.startInternetProbe();
        }

        this.updateNetPill();
    }

    setupConnectivityStatus() {
        // Mirror XTOC: show both link status and a best-effort internet reachability probe.
        this._connectivityOnline = navigator.onLine;
        this._connectivityHasInternet = false;
        this.updateNetPill();

        if (this.netPill) {
            this.netPill.addEventListener('click', () => this.toggleForcedOffline());
        }

        const onOnline = () => {
            this._connectivityOnline = true;
            this.startInternetProbe();
            this.updateNetPill();
        };
        const onOffline = () => {
            this._connectivityOnline = false;
            this._connectivityHasInternet = false;
            this.stopInternetProbe();
            this.updateNetPill();
        };

        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);

        this.startInternetProbe();
    }

    startInternetProbe() {
        if (!this.netPill || !this.netValue) return;
        if (!navigator.onLine) return;
        if (this.isForcedOfflineEnabled()) return;
        if (this._internetProbeTimer) return;

        const run = () => this.runInternetProbe();
        run();
        this._internetProbeTimer = setInterval(run, 15000);
    }

    stopInternetProbe() {
        if (this._internetProbeTimer) {
            clearInterval(this._internetProbeTimer);
            this._internetProbeTimer = null;
        }
        if (this._internetProbeAbort) {
            try { this._internetProbeAbort.abort(); } catch (_) { /* ignore */ }
            this._internetProbeAbort = null;
        }
        this._internetProbeInFlight = false;
    }

    async runInternetProbe() {
        if (!navigator.onLine) return;
        if (this.isForcedOfflineEnabled()) return;
        if (this._internetProbeInFlight) return;

        this._internetProbeInFlight = true;
        const ctrl = new AbortController();
        this._internetProbeAbort = ctrl;
        const timeoutMs = 4000;
        const probeUrl = 'https://www.google.com/generate_204';
        const t = setTimeout(() => ctrl.abort(), timeoutMs);

        try {
            const res = await fetch(probeUrl, {
                method: 'GET',
                mode: 'no-cors',
                cache: 'no-store',
                signal: ctrl.signal,
            });

            // With `no-cors`, we may get an opaque response; if fetch resolves, we treat that as reachable.
            const ok = !!res;
            this._connectivityHasInternet = ok;
            if (ok) this._connectivityLastOkAt = Date.now();
        } catch {
            this._connectivityHasInternet = false;
        } finally {
            clearTimeout(t);
            if (this._internetProbeAbort === ctrl) this._internetProbeAbort = null;
            this._internetProbeInFlight = false;
            this.updateNetPill();
        }
    }

    updateNetPill() {
        if (!this.netPill || !this.netValue) return;

        const forcedOffline = this.isForcedOfflineEnabled();
        const online = forcedOffline ? false : !!this._connectivityOnline;
        const hasInternet = forcedOffline ? false : !!this._connectivityHasInternet;
        const ok = online && hasInternet;

        // Expose a tiny global hint so shared helpers (MapLibre style builder) can
        // avoid long hangs on remote resources when offline / LAN-only.
        let prevOk;
        try { prevOk = globalThis.XCOM_HAS_INTERNET; } catch (_) { /* ignore */ }
        try {
            globalThis.XCOM_ONLINE = online;
            globalThis.XCOM_HAS_INTERNET = ok;
        } catch (_) {
            // ignore
        }

        // Notify modules when reachability changes. Some map modules start with an offline
        // fallback style (until the probe runs) and need to re-apply their base style to
        // upgrade back to the chosen online vector basemap.
        try {
            if (prevOk !== ok) {
                globalThis.dispatchEvent(new CustomEvent('xcomConnectivityUpdated', {
                    detail: { online, hasInternet, ok, prevOk, forcedOffline }
                }));
            }
        } catch (_) {
            // ignore
        }

        this.netPill.title = forcedOffline
            ? 'Forced Offline enabled: external network calls are disabled (cache-only). Click to re-enable.'
            : ok
                ? 'Internet reachable. Click to force offline.'
                : online
                    ? 'Network connected, but internet not reachable (LAN-only / captive portal?). Click to force offline.'
                    : 'No network connection. Click to force offline.';

        this.netPill.style.borderColor = forcedOffline ? 'rgba(246, 201, 69, 0.55)' : ok ? 'rgba(46, 230, 166, 0.35)' : 'rgba(246, 201, 69, 0.35)';
        this.netValue.style.color = forcedOffline ? 'var(--warning)' : ok ? 'var(--accent)' : 'var(--warning)';
        this.netValue.textContent = forcedOffline ? 'FORCED OFFLINE' : ok ? 'ONLINE' : 'OFFLINE';

        try { this.netPill.setAttribute('aria-pressed', forcedOffline ? 'true' : 'false'); } catch (_) { /* ignore */ }
        try { this.netPill.setAttribute('aria-label', forcedOffline ? 'Forced Offline: click to disable' : 'Network status: click to force offline'); } catch (_) { /* ignore */ }
    }
}

// Initialize the application when the page loads
document.addEventListener('DOMContentLoaded', () => {
    (async () => {
        // App-wide access gate (forced activation screen)
        await requireLicenseActivation();
        window.radioApp = new RadioApp();
    })();
});
