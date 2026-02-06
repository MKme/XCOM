class HamClockModule {
    constructor() {
        this.map = null;
        this.overlay = null;
        this.overlayCanvas = null;
        this.overlayCtx = null;

        this.spaceWx = {
            sfi: null,
            ssn: null,
            a: null,
            kp: null,
            updated: null
        };

        this.de = { lat: null, lon: null, name: 'DE' };
        this.dx = { lat: null, lon: null, name: 'DX' };
        this.pathLayer = null;
        this.mapClickMode = null;

        // MapLibre state
        this._overlayCanvas = null;
        this._overlayCtx = null;
        this._pathSourceId = null;
        this._pathLineLayerId = null;
        this._pathPointSourceId = null;
        this._pathPointLayerId = null;

        this.settings = {
            showTerminator: true,
            showGreyline: true,
            showGrid: true,
            showTimeLabels: true,
            showSubsolar: true,
            greylineWidthDeg: 6, // +- degrees from terminator
            nightOpacity: 0.42,
            shadingPx: 14,
            updateMs: 10_000,

            // Propagation model inputs
            sfi: 120,
            mode: 'Digital',
            powerW: 8,
            pathDistanceKm: 3000,

            // Display / clock styling
            accentOrange: '#f59e0b',
            accentGreen: '#22c55e'
        };

        this.timers = [];
        this.createLayout();
        this.initMap();
        this.bindEvents();
        this.refreshAll(true);
    }

    createLayout() {
        const container = document.getElementById('ham-clock');
        container.innerHTML = `
            <div class="ham-clock">
                <section class="hc-dash">
                    <div class="hc-top-left">
                        <div class="hc-panel hc-panel-clock">
                            <div class="hc-brand">VE3YLO HAM RADIO CLOCK</div>
                            <div class="hc-big-time" id="hcUtcTime">--:--:--</div>
                            <div class="hc-big-date" id="hcUtcDate">----</div>
                            <div class="hc-small-muted" id="hcUptime">Up --</div>
                        </div>
                    </div>

                    <div class="hc-top-mid">
                        <div class="hc-panel hc-panel-spacewx">
                            <div class="hc-spacewx-header">
                                <div class="hc-panel-title">NOAA SpaceWx</div>
                                <div style="display:flex; gap:8px; align-items: baseline;">
                                    <span class="hc-small-muted" id="hcWxMiniStatus">--</span>
                                    <button id="hcFetchSpaceWx" class="hc-spacewx-fetch" type="button">Fetch</button>
                                </div>
                            </div>
                            <div class="hc-spacewx-grid">
                                <div class="hc-spacewx-row"><span class="k">R</span><span class="v" id="hcHudR">0</span></div>
                                <div class="hc-spacewx-row"><span class="k">S</span><span class="v" id="hcHudS">0</span></div>
                                <div class="hc-spacewx-row"><span class="k">G</span><span class="v" id="hcHudG">0</span></div>
                            </div>
                            <div class="hc-spacewx-kv">
                                <div class="hc-spacewx-kv-row"><span>SFI</span><strong id="hcHudSfi">--</strong></div>
                                <div class="hc-spacewx-kv-row"><span>SSN</span><strong id="hcHudSsn">--</strong></div>
                                <div class="hc-spacewx-kv-row"><span>A</span><strong id="hcHudA">--</strong></div>
                                <div class="hc-spacewx-kv-row"><span>Kp</span><strong id="hcHudKp">--</strong></div>
                            </div>
                            <div class="hc-hud-actions">
                                <span class="hc-small-muted" id="hcOnlineState">--</span>
                            </div>
                            <div class="hc-small-muted" id="hcWxUpdated">Updated: --</div>
                        </div>
                    </div>

                    <div class="hc-top-right">
                        <div class="hc-panel hc-panel-bands">
                            <div class="hc-panel-title">Bands (predicted)</div>
                            <div class="hc-band-strip" id="hcBandStrip"></div>
                            <div class="hc-controls compact">
                                <label class="hc-row">SFI <input type="number" id="hcSfi" min="50" max="300" step="1" value="120"></label>
                                <label class="hc-row">Mode
                                    <select id="hcMode">
                                        <option value="SSB">SSB/CW</option>
                                        <option value="Digital" selected>Digital</option>
                                    </select>
                                </label>
                                <label class="hc-row">Pwr <input type="number" id="hcPower" min="1" max="1500" step="5" value="8"></label>
                            </div>
                        </div>
                    </div>

                    <div class="hc-left-col">
                        <div class="hc-panel hc-panel-de">
                            <div class="hc-panel-title">DE</div>
                            <div class="hc-left-time" id="hcDeTime">--:--</div>
                            <div class="hc-left-sub" id="hcDeLoc">Set DE location</div>
                            <div class="hc-controls compact">
                                <input type="text" id="hcDeInput" placeholder="DE: lat,lng (e.g., 43.7,-79.4)" />
                                <div style="display:flex; gap:6px;">
                                    <button id="hcDeSetBtn" type="button">Set DE</button>
                                    <button id="hcDePickBtn" type="button">Pick</button>
                                </div>
                            </div>
                        </div>

                        <div class="hc-panel hc-panel-dx">
                            <div class="hc-panel-title">DX</div>
                            <div class="hc-left-time" id="hcDxTime">--:--</div>
                            <div class="hc-left-sub" id="hcDxLoc">Set DX location</div>
                            <div class="hc-controls compact">
                                <input type="text" id="hcDxInput" placeholder="DX: lat,lng (e.g., 51.5,-0.1)" />
                                <div style="display:flex; gap:6px;">
                                    <button id="hcDxSetBtn" type="button">Set DX</button>
                                    <button id="hcDxPickBtn" type="button">Pick</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="hc-map-wrap">
                        <div class="hc-map-panel">
                            <div class="hc-map" id="hcMap"></div>
                            <div class="hc-map-legend" id="hcLegend">
                                <span class="legend-chip day">Day</span>
                                <span class="legend-chip grey">Greyline</span>
                                <span class="legend-chip night">Night</span>
                            </div>
                        </div>
                    </div>

                    <div class="hc-bottom-right">
                        <div class="hc-panel">
                            <div class="hc-panel-title">Prediction details</div>
                            <div class="hc-bands" id="hcBands">--</div>
                            <details>
                                <summary>Display options</summary>
                                <div class="hc-controls" style="margin-top:8px;">
                                    <label><input type="checkbox" id="hcShowTerminator" checked> Terminator</label>
                                    <label><input type="checkbox" id="hcShowGreyline" checked> Greyline band</label>
                                    <label><input type="checkbox" id="hcShowGrid" checked> Grid</label>
                                    <label><input type="checkbox" id="hcShowTime" checked> Time overlay</label>
                                    <label><input type="checkbox" id="hcShowSubsolar" checked> Subsolar marker</label>
                                    <label class="hc-row">Update (sec)
                                        <input type="number" id="hcUpdateSec" min="2" max="120" step="1" value="10">
                                    </label>
                                </div>
                            </details>
                            <details>
                                <summary>Space weather details</summary>
                                <div class="hc-spacewx" id="hcSpaceWxCard">Use “Fetch” to load SFI/Kp/A-index (requires internet). Offline: enter SFI above.</div>
                            </details>
                        </div>
                    </div>
                </section>
            </div>
        `;

        this.utcTimeEl = container.querySelector('#hcUtcTime');
        this.utcDateEl = container.querySelector('#hcUtcDate');
        this.mapEl = container.querySelector('#hcMap');
        this.spaceWxCard = container.querySelector('#hcSpaceWxCard');
        this.onlineStateEl = container.querySelector('#hcOnlineState');
        this.bandsEl = container.querySelector('#hcBands');

        this.hud = {
            sfi: container.querySelector('#hcHudSfi'),
            ssn: container.querySelector('#hcHudSsn'),
            a: container.querySelector('#hcHudA'),
            kp: container.querySelector('#hcHudKp'),
            r: container.querySelector('#hcHudR'),
            s: container.querySelector('#hcHudS'),
            g: container.querySelector('#hcHudG'),
            wxUpdated: container.querySelector('#hcWxUpdated'),
            wxMiniStatus: container.querySelector('#hcWxMiniStatus'),
            bandStrip: container.querySelector('#hcBandStrip')
        };

        this.ui = {
            showTerminator: container.querySelector('#hcShowTerminator'),
            showGreyline: container.querySelector('#hcShowGreyline'),
            showGrid: container.querySelector('#hcShowGrid'),
            showTimeLabels: container.querySelector('#hcShowTime'),
            showSubsolar: container.querySelector('#hcShowSubsolar'),
            updateSec: container.querySelector('#hcUpdateSec'),

            fetchSpaceWx: container.querySelector('#hcFetchSpaceWx'),
            sfi: container.querySelector('#hcSfi'),
            mode: container.querySelector('#hcMode'),
            power: container.querySelector('#hcPower'),
            distance: container.querySelector('#hcDistance'),

            deInput: container.querySelector('#hcDeInput'),
            deSetBtn: container.querySelector('#hcDeSetBtn'),
            dePickBtn: container.querySelector('#hcDePickBtn'),
            dxInput: container.querySelector('#hcDxInput'),
            dxSetBtn: container.querySelector('#hcDxSetBtn'),
            dxPickBtn: container.querySelector('#hcDxPickBtn')
        };

        this.deTimeEl = container.querySelector('#hcDeTime');
        this.dxTimeEl = container.querySelector('#hcDxTime');
        this.deLocEl = container.querySelector('#hcDeLoc');
        this.dxLocEl = container.querySelector('#hcDxLoc');
        this.uptimeEl = container.querySelector('#hcUptime');
    }

    bindEvents() {
        const bindBool = (el, key) => {
            if (!el) return;
            el.addEventListener('change', () => {
                this.settings[key] = !!el.checked;
                this.drawOverlay();
            });
        };
        bindBool(this.ui.showTerminator, 'showTerminator');
        bindBool(this.ui.showGreyline, 'showGreyline');
        bindBool(this.ui.showGrid, 'showGrid');
        bindBool(this.ui.showTimeLabels, 'showTimeLabels');
        bindBool(this.ui.showSubsolar, 'showSubsolar');

        if (this.ui.updateSec) {
            this.ui.updateSec.addEventListener('change', () => {
                const sec = Math.max(2, Math.min(120, parseInt(this.ui.updateSec.value, 10) || 10));
                this.ui.updateSec.value = sec;
                this.settings.updateMs = sec * 1000;
                this.restartTimers();
            });
        }

        const bindNum = (el, key, min, max) => {
            if (!el) return;
            el.addEventListener('change', () => {
                const v = parseInt(el.value, 10);
                const fixed = Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : this.settings[key];
                el.value = fixed;
                this.settings[key] = fixed;
                this.refreshPrediction();
            });
        };
        bindNum(this.ui.sfi, 'sfi', 50, 300);
        bindNum(this.ui.power, 'powerW', 1, 1500);
        bindNum(this.ui.distance, 'pathDistanceKm', 50, 20000);

        if (this.ui.mode) {
            this.ui.mode.addEventListener('change', () => {
                this.settings.mode = this.ui.mode.value;
                this.refreshPrediction();
            });
        }

        if (this.ui.fetchSpaceWx) {
            this.ui.fetchSpaceWx.addEventListener('click', (e) => {
                try {
                    e.preventDefault();
                    e.stopPropagation();
                } catch (_) {
                    // ignore
                }
                this.fetchSpaceWeather();
            });
        }

        if (this.ui.deSetBtn && this.ui.deInput) {
            this.ui.deSetBtn.addEventListener('click', () => this.setEndpointFromInput('de'));
            this.ui.deInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.setEndpointFromInput('de');
            });
        }

        if (this.ui.dxSetBtn && this.ui.dxInput) {
            this.ui.dxSetBtn.addEventListener('click', () => this.setEndpointFromInput('dx'));
            this.ui.dxInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.setEndpointFromInput('dx');
            });
        }

        if (this.ui.dePickBtn) {
            this.ui.dePickBtn.addEventListener('click', () => {
                this.mapClickMode = 'de';
                if (this.deLocEl) this.deLocEl.textContent = 'Click on the map to set DE…';
                this.updateMapCursor(true);
            });
        }

        if (this.ui.dxPickBtn) {
            this.ui.dxPickBtn.addEventListener('click', () => {
                this.mapClickMode = 'dx';
                if (this.dxLocEl) this.dxLocEl.textContent = 'Click on the map to set DX…';
                this.updateMapCursor(true);
            });
        }
    }

    initMap() {
        if (!this.mapEl || !globalThis.maplibregl) return;

        const c = globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 20, lon: 0 };
        const z = globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 2;

        this.map = globalThis.createMapLibreMap
            ? globalThis.createMapLibreMap({
                container: this.mapEl,
                centerLon: c.lon,
                centerLat: c.lat,
                zoom: z,
            })
            : new globalThis.maplibregl.Map({
                container: this.mapEl,
                style: globalThis.buildMapLibreStyle ? globalThis.buildMapLibreStyle() : 'https://tiles.openfreemap.org/styles/liberty',
                center: [c.lon, c.lat],
                zoom: z,
                attributionControl: false,
            });

        try {
            this.map.addControl(new globalThis.maplibregl.NavigationControl(), 'top-right');
        } catch (_) {
            // ignore
        }

        // Persist view
        const saveView = () => {
            try {
                const center = this.map.getCenter();
                const zoom = this.map.getZoom();
                globalThis.setMapDefaultCoords && globalThis.setMapDefaultCoords({ lat: center.lat, lon: center.lng });
                globalThis.setMapDefaultZoom && globalThis.setMapDefaultZoom(Number(zoom));
            } catch (_) {
                // ignore
            }
        };
        this.map.on('moveend', saveView);
        this.map.on('zoomend', saveView);

        // Click to set DE/DX if pick mode active
        this.map.on('click', (e) => {
            if (!this.mapClickMode) return;
            const { lat, lng } = e.lngLat;
            if (this.mapClickMode === 'de') {
                this.de = { lat, lon: lng, name: 'DE' };
                if (this.ui.deInput) this.ui.deInput.value = `${lat.toFixed(4)},${lng.toFixed(4)}`;
                if (this.deLocEl) this.deLocEl.textContent = `${lat.toFixed(1)} ${lng.toFixed(1)}`;
            } else if (this.mapClickMode === 'dx') {
                this.dx = { lat, lon: lng, name: 'DX' };
                if (this.ui.dxInput) this.ui.dxInput.value = `${lat.toFixed(4)},${lng.toFixed(4)}`;
                if (this.dxLocEl) this.dxLocEl.textContent = `${lat.toFixed(1)} ${lng.toFixed(1)}`;
            }

            this.mapClickMode = null;
            this.updateMapCursor(false);
            this.updatePathDistanceFromEndpoints();
            this.drawPath();
            this.refreshPrediction();
        });

        // Setup overlay canvas (MapLibre does not have Leaflet panes)
        this._overlayCanvas = document.createElement('canvas');
        this._overlayCanvas.className = 'hc-overlay-canvas';
        this._overlayCanvas.style.position = 'absolute';
        this._overlayCanvas.style.top = '0';
        this._overlayCanvas.style.left = '0';
        this._overlayCanvas.style.pointerEvents = 'none';
        this._overlayCtx = this._overlayCanvas.getContext('2d');
        this.mapEl.appendChild(this._overlayCanvas);

        // Path sources/layers
        this._pathSourceId = `hc-path-${Date.now()}`;
        this._pathLineLayerId = `hc-path-line-${Date.now()}`;
        this._pathPointSourceId = `hc-path-pts-${Date.now()}`;
        this._pathPointLayerId = `hc-path-pts-layer-${Date.now()}`;

        this.map.on('load', () => {
            // Sources
            this.map.addSource(this._pathSourceId, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            this.map.addLayer({
                id: this._pathLineLayerId,
                type: 'line',
                source: this._pathSourceId,
                paint: {
                    'line-color': '#facc15',
                    'line-width': 2,
                    'line-opacity': 0.85,
                }
            });

            this.map.addSource(this._pathPointSourceId, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            this.map.addLayer({
                id: this._pathPointLayerId,
                type: 'circle',
                source: this._pathPointSourceId,
                paint: {
                    'circle-radius': 6,
                    'circle-color': ['match', ['get', 'kind'], 'de', '#fb923c', 'dx', '#22c55e', '#94a3b8'],
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff',
                }
            });

            // initial sizing / redraw hooks
            this.resizeCanvasToMap();
            this.drawOverlay();
            this.drawPath();
        });

        const redraw = () => {
            this.resizeCanvasToMap();
            this.drawOverlay();
        };
        this.map.on('move', redraw);
        this.map.on('zoom', redraw);
        this.map.on('resize', redraw);
    }

    updateMapCursor(active) {
        if (!this.mapEl) return;
        if (active) this.mapEl.classList.add('map-pick-mode');
        else this.mapEl.classList.remove('map-pick-mode');
    }

    resizeCanvasToMap() {
        if (!this.map || !this._overlayCanvas) return;
        const c = this.map.getCanvas();
        if (!c) return;
        const w = c.clientWidth || c.width;
        const h = c.clientHeight || c.height;
        this._overlayCanvas.width = Math.max(1, Math.floor(w));
        this._overlayCanvas.height = Math.max(1, Math.floor(h));
        this._overlayCanvas.style.width = `${w}px`;
        this._overlayCanvas.style.height = `${h}px`;
    }

    refreshAll(force = false) {
        this.updateUtc();
        this.refreshPrediction();
        this.drawOverlay();
        if (force) this.restartTimers();
        this.updateOnlineStatus();
        this.drawPath();
    }

    restartTimers() {
        this.timers.forEach((t) => clearInterval(t));
        this.timers = [];
        this.timers.push(setInterval(() => this.updateUtc(), 1000));
        this.timers.push(setInterval(() => this.drawOverlay(), this.settings.updateMs));
        this.timers.push(setInterval(() => this.refreshPrediction(), this.settings.updateMs));
        this.timers.push(setInterval(() => this.updateOnlineStatus(), 5000));
    }

    updateOnlineStatus() {
        if (!this.onlineStateEl) return;
        const online = navigator.onLine;
        this.onlineStateEl.textContent = online ? 'Online' : 'Offline';
    }

    updateUtc() {
        const now = new Date();
        const iso = now.toISOString();
        const time = iso.slice(11, 19);
        const date = iso.slice(0, 10);
        if (this.utcTimeEl) this.utcTimeEl.textContent = `${time}`;
        if (this.utcDateEl) this.utcDateEl.textContent = date;

        // DE/DX local times (approx using longitude)
        const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
        if (this.de?.lon != null && this.deTimeEl) this.deTimeEl.textContent = this.formatLocalTime(utcHour, this.de.lon);
        if (this.dx?.lon != null && this.dxTimeEl) this.dxTimeEl.textContent = this.formatLocalTime(utcHour, this.dx.lon);

        if (this.uptimeEl) {
            const ms = (performance?.now ? performance.now() : 0);
            const sec = Math.floor(ms / 1000);
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            this.uptimeEl.textContent = `Up ${h}h ${m}m ${s}s`;
        }
    }

    formatLocalTime(utcHour, lon) {
        const local = (utcHour + lon / 15 + 24) % 24;
        const hh = Math.floor(local);
        const mm = Math.floor((local - hh) * 60);
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }

    setEndpointFromInput(which) {
        const el = which === 'de' ? this.ui.deInput : this.ui.dxInput;
        const raw = (el?.value || '').trim();
        const parsed = this.parseLatLngInput(raw);
        if (!parsed) {
            if (which === 'de' && this.deLocEl) this.deLocEl.textContent = 'Enter DE as lat,lng';
            if (which === 'dx' && this.dxLocEl) this.dxLocEl.textContent = 'Enter DX as lat,lng';
            return;
        }
        if (which === 'de') {
            this.de = { lat: parsed.lat, lon: parsed.lng, name: 'DE' };
            if (this.deLocEl) this.deLocEl.textContent = `${parsed.lat.toFixed(1)} ${parsed.lng.toFixed(1)}`;
        } else {
            this.dx = { lat: parsed.lat, lon: parsed.lng, name: 'DX' };
            if (this.dxLocEl) this.dxLocEl.textContent = `${parsed.lat.toFixed(1)} ${parsed.lng.toFixed(1)}`;
        }
        this.updatePathDistanceFromEndpoints();
        this.drawPath();
        this.refreshPrediction();
    }

    parseLatLngInput(raw) {
        const match = String(raw || '').match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
        if (!match) return null;
        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
        return { lat, lng };
    }

    updatePathDistanceFromEndpoints() {
        if (this.de?.lat == null || this.dx?.lat == null) return;
        const km = this.calculateDistanceKm(this.de.lat, this.de.lon, this.dx.lat, this.dx.lon);
        this.settings.pathDistanceKm = km;
        if (this.ui.distance) this.ui.distance.value = Math.round(km);
    }

    drawPath() {
        if (!this.map || !this._pathSourceId || !this._pathPointSourceId) return;
        if (this.de?.lat == null || this.dx?.lat == null) {
            // clear
            try {
                const ls = this.map.getSource(this._pathSourceId);
                const ps = this.map.getSource(this._pathPointSourceId);
                if (ls) ls.setData({ type: 'FeatureCollection', features: [] });
                if (ps) ps.setData({ type: 'FeatureCollection', features: [] });
            } catch (_) { /* ignore */ }
            return;
        }

        const line = {
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [
                    [this.de.lon, this.de.lat],
                    [this.dx.lon, this.dx.lat]
                ]
            },
            properties: {}
        };
        const pts = [
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [this.de.lon, this.de.lat] },
                properties: { kind: 'de' }
            },
            {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [this.dx.lon, this.dx.lat] },
                properties: { kind: 'dx' }
            }
        ];

        try {
            const ls = this.map.getSource(this._pathSourceId);
            const ps = this.map.getSource(this._pathPointSourceId);
            if (ls) ls.setData({ type: 'FeatureCollection', features: [line] });
            if (ps) ps.setData({ type: 'FeatureCollection', features: pts });
        } catch (_) {
            // ignore
        }

        try {
            const b = new globalThis.maplibregl.LngLatBounds();
            b.extend([this.de.lon, this.de.lat]);
            b.extend([this.dx.lon, this.dx.lat]);
            this.map.fitBounds(b, { padding: 18, maxZoom: 5 });
        } catch (_) {
            // ignore
        }
    }

    refreshPrediction() {
        if (!this.bandsEl || !window.PropagationModel) {
            this.bandsEl.innerHTML = '<div class="hc-muted">Propagation model unavailable.</div>';
            return;
        }

        const utcDate = new Date();
        const prediction = window.PropagationModel.predictPropagation({
            distanceKm: this.settings.pathDistanceKm,
            utcDate,
            sfi: this.settings.sfi,
            mode: this.settings.mode,
            powerW: this.settings.powerW
        });

        this.updateBandStrip(prediction);
        this.updateHudSfi(this.settings.sfi);

        this.bandsEl.innerHTML = `
            <div class="hc-band-meta">
                <div><strong>UTC:</strong> ${utcDate.toISOString().replace('T', ' ').slice(0, 16)}</div>
                <div><strong>Distance:</strong> ${this.settings.pathDistanceKm.toFixed(0)} km</div>
                <div><strong>SFI:</strong> ${this.settings.sfi}</div>
            </div>
            <div class="hc-band-list">
                ${prediction.bands.map((b) => {
                    const pct = Math.round(b.score * 100);
                    return `
                        <div class="hc-band">
                            <div class="hc-band-top">
                                <span class="hc-band-name">${b.name}</span>
                                <span class="hc-band-score">${pct}%</span>
                            </div>
                            <div class="hc-band-bar"><div class="hc-band-fill" style="width:${pct}%;"></div></div>
                            <div class="hc-band-detail">${b.detail}</div>
                        </div>
                    `;
                }).join('')}
            </div>
            <div class="hc-muted"><strong>Method:</strong> ${prediction.method}</div>
        `;
    }

    updateBandStrip(prediction) {
        if (!this.hud?.bandStrip || !prediction?.bands) return;
        const bands = prediction.bands;
        const colorFor = (score) => {
            const s = Math.max(0, Math.min(1, score));
            if (s >= 0.75) return '#22c55e';
            if (s >= 0.55) return '#84cc16';
            if (s >= 0.35) return '#f59e0b';
            return '#ef4444';
        };
        this.hud.bandStrip.innerHTML = bands.map((b) => {
            const pct = Math.round(b.score * 100);
            const color = colorFor(b.score);
            const short = b.name.split(' ')[0];
            return `
                <div class="hc-band-chip" title="${b.name} — ${pct}%\n${b.detail}">
                    <div class="hc-band-chip-top">
                        <span class="n">${short}</span>
                        <span class="p" style="color:${color};">${pct}%</span>
                    </div>
                    <div class="hc-band-chip-bar"><div class="hc-band-chip-fill" style="width:${pct}%; background:${color};"></div></div>
                </div>
            `;
        }).join('');
    }

    updateHudSfi(sfi) {
        if (this.hud?.sfi) this.hud.sfi.textContent = Number.isFinite(sfi) ? String(sfi) : '--';
    }

    async fetchSpaceWeather() {
        if (!this.spaceWxCard) return;
        if (this.hud?.wxMiniStatus) this.hud.wxMiniStatus.textContent = 'Fetching…';

        if (!navigator.onLine) {
            this.spaceWxCard.textContent = 'Offline: cannot fetch space weather. Enter SFI manually.';
            if (this.hud?.wxMiniStatus) this.hud.wxMiniStatus.textContent = 'Offline';
            return;
        }

        if (!window.SpaceWeather) {
            this.spaceWxCard.textContent = 'SpaceWeather helper unavailable.';
            if (this.hud?.wxMiniStatus) this.hud.wxMiniStatus.textContent = 'Unavailable';
            return;
        }

        this.spaceWxCard.textContent = 'Fetching...';
        if (this.ui.fetchSpaceWx) {
            this.ui.fetchSpaceWx.disabled = true;
            this.ui.fetchSpaceWx.textContent = '…';
        }

        // Also enforce a hard timeout at the caller level so the UI never
        // sits in "Fetching" forever if the environment hangs.
        const timeoutMs = 15_000;
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Space weather fetch timed out')), timeoutMs)
        );

        try {
            // Fetch the two sources independently so a CORS failure on NOAA scales
            // does not break the entire SpaceWx update.
            const wm7dRes = await Promise.race([
                window.SpaceWeather.fetchWm7dSolar(),
                timeoutPromise
            ]);

            let noaaRes = null;
            try {
                noaaRes = await window.SpaceWeather.fetchNoaaScales();
            } catch (err) {
                console.warn('NOAA scales fetch failed (continuing with fallback):', err);
            }

            const data = wm7dRes.data;
            if (!data) {
                this.spaceWxCard.textContent = 'Could not parse space weather.';
                if (this.hud?.wxMiniStatus) this.hud.wxMiniStatus.textContent = 'Parse error';
                return;
            }

            if (data.sfi && this.ui.sfi) {
                const cleaned = Math.round(data.sfi);
                this.ui.sfi.value = cleaned;
                this.settings.sfi = cleaned;
                this.refreshPrediction();
            }

            if (this.hud?.sfi) this.hud.sfi.textContent = Number.isFinite(data.sfi) ? String(Math.round(data.sfi)) : '--';
            if (this.hud?.ssn) this.hud.ssn.textContent = Number.isFinite(data.sunspot) ? String(Math.round(data.sunspot)) : '--';
            if (this.hud?.a) this.hud.a.textContent = Number.isFinite(data.aIndex) ? String(Math.round(data.aIndex)) : '--';
            if (this.hud?.kp) this.hud.kp.textContent = Number.isFinite(data.kIndex) ? String(data.kIndex.toFixed(1)) : '--';
            if (this.hud?.wxUpdated) this.hud.wxUpdated.textContent = `Updated: ${data.date || '—'}`;
            if (this.hud?.wxMiniStatus) this.hud.wxMiniStatus.textContent = 'OK';

            // Populate the HamClock-style R/S/G boxes.
            // We do not currently scrape X-ray flux (R) or proton flux (S) from
            // wm7d, so we only derive G from Kp (standard NOAA scale mapping).
            // Populate the HamClock-style R/S/G boxes.
            // Prefer NOAA official scales feed when available.
            const parsedScales = noaaRes ? window.SpaceWeather.parseNoaaScales(noaaRes.data) : null;
            if (parsedScales) {
                if (this.hud?.r) this.hud.r.textContent = String(parsedScales.R?.level ?? 0);
                if (this.hud?.s) this.hud.s.textContent = String(parsedScales.S?.level ?? 0);
                if (this.hud?.g) this.hud.g.textContent = String(parsedScales.G?.level ?? 0);
            } else {
                const scales = this.estimateNoaaScales({
                    kp: Number.isFinite(data.kIndex) ? data.kIndex : null,
                    a: Number.isFinite(data.aIndex) ? data.aIndex : null
                });
                if (this.hud?.r) this.hud.r.textContent = String(scales.r);
                if (this.hud?.s) this.hud.s.textContent = String(scales.s);
                if (this.hud?.g) this.hud.g.textContent = String(scales.g);
            }

            // Ensure we don't get a mismatch between the HUD and any other display
            // elements (e.g., if layout changes later).
            // (No-op currently; all values are HUD-driven.)

            // store
            this.spaceWx = {
                sfi: data.sfi ?? null,
                ssn: data.sunspot ?? null,
                a: data.aIndex ?? null,
                kp: data.kIndex ?? null,
                updated: data.date || null
            };

            this.spaceWxCard.innerHTML = `
                <div><strong>Sources:</strong> ${wm7dRes.sourceUrl}${noaaRes?.sourceUrl ? ` + ${noaaRes.sourceUrl}` : ''}</div>
                ${data.date ? `<div><strong>Updated:</strong> ${data.date}</div>` : ''}
                ${Number.isFinite(data.sfi) ? `<div><strong>SFI:</strong> ${data.sfi}</div>` : ''}
                ${Number.isFinite(data.sunspot) ? `<div><strong>Sunspots:</strong> ${data.sunspot}</div>` : ''}
                ${Number.isFinite(data.aIndex) ? `<div><strong>A-index:</strong> ${data.aIndex}</div>` : ''}
                ${Number.isFinite(data.kIndex) ? `<div><strong>Kp:</strong> ${data.kIndex}</div>` : ''}
            `;
        } catch (err) {
            console.error('Space weather fetch failed:', err);
            const msg = (err && err.name === 'AbortError')
                ? 'Fetch timed out'
                : (err && err.message ? err.message : 'Fetch failed');
            this.spaceWxCard.textContent = `${msg}. Enter SFI manually.`;
            if (this.hud?.wxMiniStatus) this.hud.wxMiniStatus.textContent = msg;
            if (this.hud?.wxUpdated) this.hud.wxUpdated.textContent = `Updated: — (${msg})`;
        } finally {
            if (this.ui.fetchSpaceWx) {
                this.ui.fetchSpaceWx.disabled = false;
                this.ui.fetchSpaceWx.textContent = 'Fetch';
            }
        }
    }

    estimateNoaaScales({ kp, a }) {
        // NOAA geomagnetic storms: G1..G5 roughly Kp 5..9.
        // We'll map Kp < 5 => G0.
        let g = 0;
        if (Number.isFinite(kp)) {
            const k = Math.max(0, Math.min(9, kp));
            if (k >= 5) {
                g = Math.min(5, Math.floor(k) - 4);
            }
        }

        // R and S need X-ray and proton flux, which we don't currently have.
        // Keep them at 0 for now (still "populated" instead of stale).
        // If we later add NOAA SWPC feeds, this method is the single place to
        // update the mapping.
        const r = 0;
        const s = 0;

        // Minor heuristic: if A-index is extremely high, bump G to at least 1.
        if (Number.isFinite(a) && a >= 30) g = Math.max(g, 1);
        if (Number.isFinite(a) && a >= 50) g = Math.max(g, 2);
        if (Number.isFinite(a) && a >= 100) g = Math.max(g, 3);

        return { r, s, g };
    }

    // --- Terminator math (approximate) ---

    // Returns subsolar latitude/longitude (degrees) for a given UTC date.
    // Approximation good enough for visualization (not for astro navigation).
    getSubsolarPoint(date) {
        const d = date instanceof Date ? date : new Date(date);
        const rad = Math.PI / 180;

        // Julian day
        const JD = d.getTime() / 86400000 + 2440587.5;
        const n = JD - 2451545.0;

        // Mean longitude of the sun
        let L = (280.46 + 0.9856474 * n) % 360;
        if (L < 0) L += 360;

        // Mean anomaly
        let g = (357.528 + 0.9856003 * n) % 360;
        if (g < 0) g += 360;

        // Ecliptic longitude
        const lambda = L + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad);

        // Obliquity
        const eps = 23.439 - 0.0000004 * n;

        // Declination
        const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad)) / rad;

        // Equation of time (approx)
        const y = Math.tan((eps / 2) * rad);
        const y2 = y * y;
        const E = 4 * (y2 * Math.sin(2 * L * rad)
            - 2 * 0.0167 * Math.sin(g * rad)
            + 4 * 0.0167 * y2 * Math.sin(g * rad) * Math.cos(2 * L * rad)
            - 0.5 * y2 * y2 * Math.sin(4 * L * rad)
            - 1.25 * 0.0167 * 0.0167 * Math.sin(2 * g * rad));

        // Subsolar longitude: - (UTC minutes - 720 + E) * 0.25
        const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
        let lon = - (minutes - 720 + E) * 0.25;
        // Normalize to [-180, 180]
        lon = ((lon + 540) % 360) - 180;

        return { lat: decl, lon };
    }

    // For a longitude (deg), compute latitude (deg) of the terminator.
    // Uses subsolar point with the great-circle condition: sun at horizon.
    terminatorLatAtLon(lonDeg, subsolar) {
        // Condition: cos(c) = 0 where c is angular distance to subsolar point.
        // 0 = sin(phi)*sin(dec) + cos(phi)*cos(dec)*cos(dlon)
        // => tan(phi) = -cos(dec)*cos(dlon) / sin(dec)
        const rad = Math.PI / 180;
        const dec = subsolar.lat * rad;
        const dlon = (lonDeg - subsolar.lon) * rad;
        const sinDec = Math.sin(dec);
        const cosDec = Math.cos(dec);

        // Avoid divide-by-zero near equinox; clamp.
        const denom = Math.max(1e-6, Math.abs(sinDec)) * (sinDec < 0 ? -1 : 1);
        const tanPhi = -(cosDec * Math.cos(dlon)) / denom;
        const phi = Math.atan(tanPhi);
        return phi / rad;
    }

    // --- Drawing ---

    drawOverlay() {
        if (!this.map || !this._overlayCanvas || !this._overlayCtx) return;

        this.resizeCanvasToMap();
        const ctx = this._overlayCtx;
        const w = this._overlayCanvas.width;
        const h = this._overlayCanvas.height;
        ctx.clearRect(0, 0, w, h);

        const now = new Date();
        const subsolar = this.getSubsolarPoint(now);

        // Build terminator polyline points at 1° lon resolution
        const lons = [];
        for (let lon = -180; lon <= 180; lon += 1) lons.push(lon);
        const points = lons.map((lon) => ({
            lon,
            lat: this.terminatorLatAtLon(lon, subsolar)
        }));

        // Convert to screen points
        const toPt = (lat, lon) => {
            const p = this.map.project([lon, lat]);
            return { x: p.x, y: p.y };
        };

        // Smooth shading: sample in screen space.
        // We walk a coarse pixel grid and classify each sample by solar altitude.
        // Then we draw filled squares with alpha that produces a smoother edge.

        const px = Math.max(8, Math.min(24, this.settings.shadingPx || 14));
        if (this.settings.showTerminator || this.settings.showGreyline) {
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';

            for (let y = 0; y <= h; y += px) {
                for (let x = 0; x <= w; x += px) {
                    const ll = this.map.unproject([x, y]);
                    if (!ll) continue;

                    // compute solar altitude approximation (degrees)
                    const altDeg = this.solarAltitudeDegAt(ll.lat, ll.lng, subsolar);

                    // Night shading: stronger the more negative the altitude.
                    if (this.settings.showTerminator) {
                        // 0..1 where 0 at alt >= 0, 1 at alt <= -12 (astronomical-ish)
                        const nightT = Math.max(0, Math.min(1, (-altDeg) / 12));
                        if (nightT > 0.01) {
                            const a = this.settings.nightOpacity * nightT;
                            ctx.fillStyle = `rgba(15, 23, 42, ${a})`;
                            ctx.fillRect(x, y, px, px);
                        }
                    }

                    // Greyline band: within +/- greylineWidthDeg.
                    if (this.settings.showGreyline) {
                        const width = Math.max(1, Math.min(12, this.settings.greylineWidthDeg || 6));
                        const t = 1 - Math.min(1, Math.abs(altDeg) / width);
                        if (t > 0.01) {
                            ctx.fillStyle = `rgba(180, 180, 180, ${0.22 * t})`;
                            ctx.fillRect(x, y, px, px);
                        }
                    }
                }
            }
            ctx.restore();

            // Optional blur to soften remaining pixel boundaries.
            // Using a tiny offscreen canvas keeps this safe.
            try {
                const blurPx = Math.max(0, Math.min(10, Math.round(px / 4)));
                if (blurPx >= 2) {
                    const off = document.createElement('canvas');
                    off.width = w;
                    off.height = h;
                    const octx = off.getContext('2d');
                    octx.drawImage(this.overlayCanvas, 0, 0);
                    ctx.clearRect(0, 0, w, h);
                    ctx.save();
                    ctx.filter = `blur(${blurPx}px)`;
                    ctx.drawImage(off, 0, 0);
                    ctx.restore();
                }
            } catch (_) {
                // ignore blur failures
            }
        }

        // Terminator line
        if (this.settings.showTerminator) {
            ctx.save();
            ctx.strokeStyle = 'rgba(226,232,240,0.8)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            points.forEach((pt, idx) => {
                const p = toPt(pt.lat, pt.lon);
                if (idx === 0) ctx.moveTo(p.x, p.y);
                else ctx.lineTo(p.x, p.y);
            });
            ctx.stroke();
            ctx.restore();
        }

        // Grid + time labels: draw every 30° lon with approximate local solar time
        if (this.settings.showGrid || this.settings.showTimeLabels) {
            ctx.save();
            ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
            ctx.fillStyle = 'rgba(226,232,240,0.85)';
            ctx.strokeStyle = 'rgba(148,163,184,0.35)';
            ctx.lineWidth = 1;

            const bounds = this.map.getBounds();
            const lonStart = Math.floor(bounds.getWest() / 30) * 30;
            const lonEnd = Math.ceil(bounds.getEast() / 30) * 30;
            const latStart = Math.floor(bounds.getSouth() / 30) * 30;
            const latEnd = Math.ceil(bounds.getNorth() / 30) * 30;

            if (this.settings.showGrid) {
                // Meridians
                for (let lon = lonStart; lon <= lonEnd; lon += 30) {
                    const pTop = toPt(latEnd, lon);
                    const pBot = toPt(latStart, lon);
                    ctx.beginPath();
                    ctx.moveTo(pTop.x, pTop.y);
                    ctx.lineTo(pBot.x, pBot.y);
                    ctx.stroke();
                }

                // Parallels
                for (let lat = latStart; lat <= latEnd; lat += 30) {
                    const pL = toPt(lat, lonStart);
                    const pR = toPt(lat, lonEnd);
                    ctx.beginPath();
                    ctx.moveTo(pL.x, pL.y);
                    ctx.lineTo(pR.x, pR.y);
                    ctx.stroke();
                }
            }

            if (this.settings.showTimeLabels) {
                const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
                for (let lon = lonStart; lon <= lonEnd; lon += 30) {
                    const local = (utcHour + lon / 15 + 24) % 24;
                    const hh = Math.floor(local);
                    const mm = Math.floor((local - hh) * 60);
                    const label = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
                    const p = toPt(0, lon);
                    ctx.fillText(label, p.x + 4, p.y - 4);
                }
            }
            ctx.restore();
        }

        // Subsolar marker
        if (this.settings.showSubsolar) {
            ctx.save();
            const p = toPt(subsolar.lat, subsolar.lon);
            ctx.fillStyle = 'rgba(250, 204, 21, 0.95)';
            ctx.strokeStyle = 'rgba(0,0,0,0.55)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = 'rgba(250, 204, 21, 0.95)';
            ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
            ctx.fillText('☉', p.x + 8, p.y + 4);
            ctx.restore();
        }
    }

    calculateDistanceKm(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    // Sun is below horizon if angular distance from subsolar point is > 90°.
    isNightAt(latDeg, lonDeg, subsolar) {
        const rad = Math.PI / 180;
        const lat = latDeg * rad;
        const lon = lonDeg * rad;
        const dec = subsolar.lat * rad;
        const lonS = subsolar.lon * rad;
        const cosC = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(lon - lonS);
        return cosC < 0;
    }

    isNearGreyline(latDeg, lonDeg, subsolar, widthDeg = 6) {
        const rad = Math.PI / 180;
        const lat = latDeg * rad;
        const lon = lonDeg * rad;
        const dec = subsolar.lat * rad;
        const lonS = subsolar.lon * rad;
        const cosC = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(lon - lonS);
        // sun altitude approx: alt = asin(cosC)
        const altDeg = Math.asin(Math.max(-1, Math.min(1, cosC))) / rad;
        return Math.abs(altDeg) <= widthDeg;
    }

    solarAltitudeDegAt(latDeg, lonDeg, subsolar) {
        const rad = Math.PI / 180;
        const lat = latDeg * rad;
        const lon = lonDeg * rad;
        const dec = subsolar.lat * rad;
        const lonS = subsolar.lon * rad;
        const cosC = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(lon - lonS);
        return Math.asin(Math.max(-1, Math.min(1, cosC))) / rad;
    }
}
