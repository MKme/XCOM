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
    const key = String(licenseKey || '').trim();
    const proxyUrl = getLicenseProxyUrl();
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 20_000;
    const actionRaw = (opts.action || 'validate') + '';
    const action = actionRaw.trim().toLowerCase() === 'activate' ? 'activate' : 'validate';

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
            body: JSON.stringify({ license_key: key, action }),
            signal: ctrl ? ctrl.signal : undefined,
        });

        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }

        if (!res.ok) {
            const msg = (json && (json.message || json.error)) || text || `HTTP ${res.status}`;
            const reason = (json && json.reason) || (res.status === 401 ? 'invalid' : 'http');
            return { ok: false, reason, message: String(msg), status: res.status, proxyUrl };
        }

        if (!json || json.success !== true) {
            const msg = (json && (json.message || json.error)) || 'License invalid';
            const reason = (json && json.reason) || 'invalid';
            return { ok: false, reason, message: String(msg), status: res.status, proxyUrl };
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
            <p class="xLicenseSubtitle">
                Enter your WooCommerce license key once. After activation, ${XCOM_APP_NAME} works offline forever on this device.
            </p>

            <div class="xLicenseRow">
                <button class="xBtn" id="xLicenseActivateBtn" type="button">Enter / Activate License Key</button>
                <button class="xBtn xBtnSecondary" id="xLicenseClearBtn" type="button" title="Clears the cached license key on this device">Clear Key</button>
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
            'map': {
                name: 'Map',
                description: 'Tactical map + AO selection + offline raster tile caching (XTOC-style)',
                scripts: [
                    // Shared XTOC-style mapping helpers
                    'modules/shared/xtoc/settings.js',
                    'modules/shared/xtoc/offlineTiles.js',
                    'modules/shared/xtoc/ao.js',
                    'modules/shared/xtoc/maplibre.js',
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
                    'modules/shared/xtoc/keyBundle.js',
                    'modules/shared/xtoc/keyImport.js',
                    // Shared mesh transport (so Comms can Connect + Send without opening Mesh module)
                    'modules/shared/mesh/meshTransport.js',
                    // Module
                    'modules/comms/comms.js'
                ],
                styles: ['styles/modules/comms.css'],
                dependencies: [
                    'assets/vendor/maplibre-gl/maplibre-gl.js',
                    'assets/vendor/maplibre-gl/maplibre-gl.css'
                ]
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
            }
            // Additional modules will be added here
        };
        
        this.init();
    }
    
    init() {
        // Bind navigation events
        // Support both legacy header nav (#module-nav a) and the new XTOC-style sidebar (.xNav a).
        const navLinks = Array.from(document.querySelectorAll('#module-nav a, .xNav a'));
        navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const moduleId = link.getAttribute('data-module');

                // Keep the URL hash in sync so users can deep-link / bookmark modules.
                // This also makes it easier to restore the last-viewed module on reload.
                try {
                    if (moduleId) window.location.hash = moduleId;
                } catch (_) {
                    // ignore
                }
                this.loadModule(moduleId);
                
                // Update active navigation
                navLinks.forEach(navLink => {
                    navLink.classList.remove('active');
                });
                link.classList.add('active');
                this.closeMobileNav();
            });
        });

        this.setupMobileNav();
        this.setupTopbarIndicators();
        
        // Load module from URL hash if present, otherwise default to first in navigation.
        const hash = (window.location.hash || '').replace('#', '').trim();
        const savedModule = this.getSavedModule();
        const firstNav = navLinks[0] || null;
        const defaultModule = firstNav ? firstNav.getAttribute('data-module') : null;
        const mobileDefaultModule = (this.isMobileView() && this.modules['comms']) ? 'comms' : defaultModule;
        const initialModule =
            (hash && this.modules[hash]) ? hash :
            (savedModule && this.modules[savedModule]) ? savedModule :
            mobileDefaultModule;
        if (initialModule) {
            // Sync active nav state on initial load
            navLinks.forEach(navLink => {
                navLink.classList.toggle('active', navLink.getAttribute('data-module') === initialModule);
            });
            this.loadModule(initialModule);
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
            } else if (moduleId === 'map' && typeof MapModule === 'function') {
                window.mapModule = new MapModule();
            } else if (moduleId === 'comms' && typeof CommsModule === 'function') {
                window.commsModule = new CommsModule();
            } else if (moduleId === 'mesh' && typeof MeshModule === 'function') {
                window.meshModule = new MeshModule();
            }
            
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
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
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
    }

    setupUpdateButton() {
        if (!this.updateBtn) return;
        this.updateBtn.addEventListener('click', () => this.updateAppAndReload());
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
        const name = this.modules[moduleId]?.name || XCOM_APP_NAME;
        if (this.topbarTitle) this.topbarTitle.textContent = name;
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

    setupConnectivityStatus() {
        // Mirror XTOC: show both link status and a best-effort internet reachability probe.
        this._connectivityOnline = navigator.onLine;
        this._connectivityHasInternet = false;
        this.updateNetPill();

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

        const online = !!this._connectivityOnline;
        const hasInternet = !!this._connectivityHasInternet;
        const ok = online && hasInternet;

        this.netPill.title = ok
            ? 'Internet reachable'
            : online
                ? 'Network connected, but internet not reachable (LAN-only / captive portal?)'
                : 'No network connection';

        this.netPill.style.borderColor = ok ? 'rgba(46, 230, 166, 0.35)' : 'rgba(246, 201, 69, 0.35)';
        this.netValue.style.color = ok ? 'var(--accent)' : 'var(--warning)';
        this.netValue.textContent = ok ? 'ONLINE' : 'OFFLINE';
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
