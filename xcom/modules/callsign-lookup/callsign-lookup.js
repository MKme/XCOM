// Basic US state and Canadian province mappings so we can expand abbreviations
// like "AZ" -> "Arizona" when using the offline gazetteer (which stores
// full admin1 names, not postal codes).
const US_STATE_NAMES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
    MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
    NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
    ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
    TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
    WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
};

const CA_PROVINCE_NAMES = {
    AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
    NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
    NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
    SK: 'Saskatchewan', YT: 'Yukon'
};

class CallsignLookupModule {
    constructor() {
        this.callsignDb = globalThis.xcomCallsignDb || null;
        this.callsignDbReady = false;
        this.callsignDbLoading = false;
        this.meta = null;
        this.suggestionLookup = new Map();
        this._dbProgressBound = false;
        this.userLocation = null;
        this.targetLocation = null;
        this.map = null;
        this.pathLayer = null;
        this._pathSourceId = null;
        this._pathLineLayerId = null;
        this._pathPointSourceId = null;
        this._pathPointLayerId = null;
        this._userMarker = null;
        this._targetMarker = null;
        this.geocodeCache = new Map();
        this.activeRecord = null;
        this.lastDistanceKm = null;
        this.mapClickMode = null;
        this.offlineLayer = null;
        this.geocoder = window.offlineGeocoder || null;
        this.geocoderReady = false;

        this.createLayout();
        this.initMap();
        // Defer large offline dataset parsing so the UI can paint first.
        setTimeout(() => this.ensureGeocoder(), 0);
        this.bindEvents();
        // Defer DB load so the UI can paint first (prevents "black screen" on offline cache hits).
        setTimeout(() => this.loadData(), 0);
    }

    createLayout() {
        const container = document.getElementById('callsign-lookup');
        container.innerHTML = `
            <div class="callsign-lookup">
                <div class="xModuleIntro">
                    <div class="xModuleIntroTitle">What you can do here</div>
                    <div class="xModuleIntroText">
                        Look up a callsign or place entirely offline, plot a line between you and them, and get a quick HF prediction for the time and mode you choose.
                    </div>
                </div>
                <section class="lookup-header">
                    <div class="lookup-copy">
                        <h2>Predict</h2>
                        <p>Offline callsign lookup for USA/Canada, with path plotting and HF prediction tools.</p>
                        <div class="meta" id="callsignMeta">Loading data...</div>
                    </div>
                </section>

                <section class="path-controls">
                    <div class="control-block">
                        <div class="control-title">Your station</div>
                        <div class="inline-controls">
                            <input type="text" id="userLocationInput" placeholder="City, State/Province, grid (e.g., FN03) or 43.7,-79.4" autocomplete="off" />
                            <button id="userLocationSetBtn">Set</button>
                            <button id="userLocationGpsBtn">Use GPS</button>
                            <button id="userLocationMapBtn" type="button">Pick on map</button>
                        </div>
                        <div class="control-hint">Needed to draw the path and measure distance.</div>
                        <div class="control-status" id="userLocationStatus">Location not set.</div>
                        <div class="inline-controls stacked-inputs">
                            <input type="text" id="callsignQuery" placeholder="Enter callsign (e.g., W1AW, VE3XYZ)" autocomplete="off" />
                            <button id="callsignSearchBtn">Predict</button>
                        </div>
                        <div class="inline-controls stacked-inputs">
                            <input type="text" id="cityQuery" placeholder="Or enter city, state/province (e.g., Toronto, ON)" autocomplete="off" />
                            <button id="citySearchBtn">Predict City</button>
                            <button id="clearQueriesBtn" type="button">Clear</button>
                            <button id="targetMapBtn" type="button">Pick target on map</button>
                        </div>
                        <div class="inline-controls stacked-inputs">
                            <input type="text" id="gridQuery" placeholder="Or enter grid square (e.g., FN03, FN03fr)" autocomplete="off" />
                            <button id="gridSearchBtn">Predict Grid</button>
                        </div>
                    </div>
                    <div class="control-block">
                        <div class="control-title">Propagation inputs</div>
                        <div class="inline-controls propagation-inline">
                            <label for="sfiInput">SFI</label>
                            <input type="number" id="sfiInput" min="50" max="300" step="1" value="120" />
                            <button id="fetchSfiBtn" type="button">Fetch solar flux</button>
                            <label for="dateTimeInput">UTC</label>
                            <input type="datetime-local" id="dateTimeInput" />
                            <button id="utcNowBtn" type="button">Use current UTC</button>
                            <label for="modeInput">Mode</label>
                            <select id="modeInput">
                                <option value="SSB">SSB/CW</option>
                                <option value="Digital" selected>Digital (FT8/JS8)</option>
                            </select>
                            <label for="powerInput">Power (W)</label>
                            <input type="number" id="powerInput" min="1" max="1500" step="5" value="8" />
                            <label for="forecastHoursInput">Forecast (hrs)</label>
                            <input type="number" id="forecastHoursInput" min="1" max="72" step="1" value="12" />
                        </div>
                        <div class="control-hint utc-hint">
                            <span id="utcNowStatus">Current UTC: --</span>
                            <span>VOACAP-style estimate uses distance, time, and solar flux.</span>
                        </div>
                        <div class="solar-card" id="solarFluxCard">Solar flux: use manual SFI or fetch current values (requires internet).</div>
                    </div>
                </section>

                <section class="lookup-results">
                    <div id="callsignStatus" class="status-line">Downloading offline database...</div>
                    <div id="callsignResult" class="result-card muted">Enter a callsign to see license details.</div>
                    <div class="path-panel">
                        <div class="path-summary" id="pathSummary">Set your location and run a prediction to see path, distance, and propagation.</div>
                        <div class="map-wrapper">
                            <div id="callsignPathMap"></div>
                        </div>
                        <div class="voacap-card" id="voacapCard">Propagation predictions will appear here once both endpoints are known.</div>
                        <div class="voacap-card" id="voacapForecast">
                            Future windows will appear here once both endpoints are known.
                            <div class="forecast-graph" id="forecastGraph"></div>
                            <div class="band-graphs" id="bandGraphs"></div>
                        </div>
                    </div>
                    <div id="callsignSuggestions" class="suggestions"></div>
                </section>
            </div>
        `;

        this.metaEl = container.querySelector('#callsignMeta');
        this.statusEl = container.querySelector('#callsignStatus');
        this.resultEl = container.querySelector('#callsignResult');
        this.suggestionsEl = container.querySelector('#callsignSuggestions');
        this.queryInput = container.querySelector('#callsignQuery');
        this.searchBtn = container.querySelector('#callsignSearchBtn');
        this.cityInput = container.querySelector('#cityQuery');
        this.citySearchBtn = container.querySelector('#citySearchBtn');
        this.gridInput = container.querySelector('#gridQuery');
        this.gridSearchBtn = container.querySelector('#gridSearchBtn');
        this.clearQueriesBtn = container.querySelector('#clearQueriesBtn');
        this.userLocationMapBtn = container.querySelector('#userLocationMapBtn');
        this.targetMapBtn = container.querySelector('#targetMapBtn');
        this.userLocationInput = container.querySelector('#userLocationInput');
        this.userLocationSetBtn = container.querySelector('#userLocationSetBtn');
        this.userLocationGpsBtn = container.querySelector('#userLocationGpsBtn');
        this.userLocationStatus = container.querySelector('#userLocationStatus');
        this.sfiInput = container.querySelector('#sfiInput');
        this.dateTimeInput = container.querySelector('#dateTimeInput');
        this.utcNowBtn = container.querySelector('#utcNowBtn');
        this.utcNowStatus = container.querySelector('#utcNowStatus');
        this.fetchSfiBtn = container.querySelector('#fetchSfiBtn');
        this.solarFluxCard = container.querySelector('#solarFluxCard');
        this.modeInput = container.querySelector('#modeInput');
        this.powerInput = container.querySelector('#powerInput');
        this.forecastHoursInput = container.querySelector('#forecastHoursInput');
        this.pathSummary = container.querySelector('#pathSummary');
        this.voacapCard = container.querySelector('#voacapCard');
        this.voacapForecast = container.querySelector('#voacapForecast');
        this.forecastGraph = container.querySelector('#forecastGraph');
        this.bandGraphs = container.querySelector('#bandGraphs');
        this.mapContainer = container.querySelector('#callsignPathMap');
        this.setDefaultDateTime();
        this.updateUtcStatus();
        this.ensureModalShell();
    }

    bindEvents() {
        this.searchBtn.addEventListener('click', () => this.lookupCallsign());
        this.queryInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.lookupCallsign();
            }
        });
        this.citySearchBtn.addEventListener('click', () => this.lookupCity());
        this.cityInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.lookupCity();
            }
        });
        if (this.gridSearchBtn && this.gridInput) {
            this.gridSearchBtn.addEventListener('click', () => this.lookupGrid());
            this.gridInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.lookupGrid();
                }
            });
        }
        this.userLocationMapBtn.addEventListener('click', () => {
            this.mapClickMode = 'user';
            this.setStatus('Click on the map to set your station.');
        });
        this.targetMapBtn.addEventListener('click', () => {
            this.mapClickMode = 'target';
            this.setStatus('Click on the map to set the target location.');
        });
        this.clearQueriesBtn.addEventListener('click', () => {
            this.queryInput.value = '';
            this.cityInput.value = '';
            this.activeRecord = null;
            this.targetLocation = null;
            this.userLocation = null;
            this.lastDistanceKm = null;
            this.mapClickMode = null;
            this.updateMapCursor(false);
            this.clearPath();
            this.resultEl.classList.add('muted');
            this.resultEl.textContent = 'Enter a callsign or city to see details.';
            this.suggestionsEl.innerHTML = '';
            this.pathSummary.textContent = 'Set your location and run a prediction to see path, distance, and propagation.';
            this.voacapCard.textContent = 'Propagation predictions will appear here once both endpoints are known.';
            this.voacapForecast.textContent = 'Future windows will appear here once both endpoints are known.';
            this.setStatus('Inputs and map selection cleared.');
        });

        this.userLocationSetBtn.addEventListener('click', () => this.setUserLocationFromInput());
        this.userLocationInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.setUserLocationFromInput();
            }
        });

        this.userLocationGpsBtn.addEventListener('click', () => this.setUserLocationFromGps());
        this.dateTimeInput.addEventListener('change', () => {
            if (this.activeRecord) {
                this.updatePathAndPrediction(this.activeRecord);
            }
        });
        this.sfiInput.addEventListener('change', () => {
            if (this.activeRecord) {
                this.updatePathAndPrediction(this.activeRecord);
            }
        });
        this.modeInput.addEventListener('change', () => {
            if (this.activeRecord) {
                this.updatePathAndPrediction(this.activeRecord);
            }
        });
        this.powerInput.addEventListener('change', () => {
            if (this.activeRecord) {
                this.updatePathAndPrediction(this.activeRecord);
            }
        });
        this.forecastHoursInput.addEventListener('change', () => {
            if (this.activeRecord) {
                this.updateForecast();
            }
        });
        this.fetchSfiBtn.addEventListener('click', () => this.fetchSolarFlux());
        this.utcNowBtn.addEventListener('click', () => {
            this.setDateTimeToNow();
            this.updateUtcStatus();
            if (this.activeRecord) {
                this.updatePathAndPrediction(this.activeRecord);
            }
        });
    }

    setDefaultDateTime() {
        const iso = new Date().toISOString().slice(0, 16);
        this.dateTimeInput.value = iso;
    }

    async lookupCity() {
        const query = this.cityInput.value.trim();
        if (!query) {
            this.setStatus('Enter a city/state to search.');
            return;
        }
        try {
            const target = await this.geocodePlace(query);
            if (!target) {
                this.setStatus('City lookup failed. Try a different city/state.');
                return;
            }
            this.activeRecord = {
                c: query,
                n: 'Location search',
                city: query,
                st: '',
                co: 'Geocoded',
                cl: 'n/a',
                ex: '',
                g: ''
            };
            this.setDateTimeToNow();
            this.updateUtcStatus();
            this.renderPlaceResult(query, target.name);
            this.targetLocation = target;
            // Bypass callsign geocode; set location directly and render path/forecast
            await this.drawPathAndPredictFromTarget(target, query);
        } catch (err) {
            console.error('City lookup error:', err);
            this.setStatus('City lookup failed.');
        }
    }

    async drawPathAndPredictFromTarget(target, displayName) {
        if (!target) return;

        this.targetLocation = target;

        if (!this.userLocation) {
            this.showTargetOnly(target, displayName || target.name);
            this.voacapCard.textContent = 'Propagation predictions need both endpoints.';
            this.voacapForecast.textContent = 'Forecast available after path is plotted.';
            this.lastDistanceKm = null;
            return;
        }

        const distanceKm = this.calculateDistanceKm(
            this.userLocation.lat,
            this.userLocation.lng,
            target.lat,
            target.lng
        );
        this.lastDistanceKm = distanceKm;
        const distanceMi = distanceKm * 0.621371;
        const bearingDeg = this.calculateBearingDeg(
            this.userLocation.lat,
            this.userLocation.lng,
            target.lat,
            target.lng
        );
        const bearingLabel = this.formatBearing(bearingDeg);

        this.pathSummary.innerHTML = `
            <strong>${distanceMi.toFixed(1)} mi</strong> / ${distanceKm.toFixed(1)} km
            @ <strong>${bearingLabel}</strong> between
            <span class="path-label">${this.userLocation.name}</span> and
            <span class="path-label">${displayName || target.name}</span>
        `;

        this.drawPath(target);
        this.renderPropagation(distanceKm);
        this.renderForecast(distanceKm);
    }

    setDateTimeToNow() {
        const iso = new Date().toISOString().slice(0, 16);
        this.dateTimeInput.value = iso;
    }

    updateUtcStatus() {
        if (!this.utcNowStatus) return;
        const now = new Date();
        const iso = now.toISOString().replace('T', ' ').slice(0, 16);
        this.utcNowStatus.textContent = `Current UTC: ${iso}`;
    }

    async fetchSolarFlux() {
        if (!navigator.onLine) {
            this.setSolarCard('Offline: enter SFI manually.');
            return;
        }
        const url = 'https://www.wm7d.net/hamradio/solar/index.shtml';
        this.setSolarCard('Fetching solar flux...');
        try {
            const html = await this.fetchWithFallback(url);
            this.handleSolarFluxHtml(html, url);
        } catch (err) {
            console.error('Solar flux fetch failed:', err);
            this.setSolarCard('Solar flux fetch failed. Enter SFI manually.');
        }
    }

    async fetchWithFallback(url) {
        const attempts = [
            url,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            `https://r.jina.ai/http://www.wm7d.net/hamradio/solar/index.shtml`
        ];
        let lastErr = null;
        for (const attempt of attempts) {
            try {
                const res = await fetch(attempt, { cache: 'no-store' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.text();
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr || new Error('All solar flux fetch attempts failed');
    }

    handleSolarFluxHtml(html, sourceUrl) {
        const data = this.parseSolarFlux(html);
        if (!data) {
            this.setSolarCard('Could not parse solar flux data. Enter SFI manually.');
            return;
        }
        if (data.sfi) {
            const cleaned = Math.round(data.sfi);
            this.sfiInput.value = cleaned;
            this.setStatus(`Solar flux updated to ${cleaned} from ${sourceUrl}`);
        } else {
            this.setStatus('Solar flux fetched but SFI not found; using manual value.');
        }
        this.setSolarCard(`
            <div><strong>Source:</strong> ${sourceUrl}</div>
            ${data.sfi ? `<div><strong>SFI:</strong> ${data.sfi}</div>` : ''}
            ${data.sunspot ? `<div><strong>Sunspot #:</strong> ${data.sunspot}</div>` : ''}
            ${data.aIndex ? `<div><strong>A-index:</strong> ${data.aIndex}</div>` : ''}
            ${data.kIndex ? `<div><strong>K-index:</strong> ${data.kIndex}</div>` : ''}
            ${data.date ? `<div><strong>Updated:</strong> ${data.date}</div>` : ''}
        `);

        // Only recompute propagation using the existing path; do not change
        // target/user locations or re-geocode anything here.
        if (this.lastDistanceKm) {
            this.renderPropagation(this.lastDistanceKm);
            this.renderForecast(this.lastDistanceKm);
        }
    }

    parseSolarFlux(html) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const textRaw = doc.body ? doc.body.textContent : html;
            const text = textRaw.replace(/\s+/g, ' ');
            const grab = (labels) => {
                const re = new RegExp(`(?:${labels})\\s*[:=]?\\s*([\\d.]+)`, 'i');
                const m = text.match(re);
                return m ? parseFloat(m[1]) : undefined;
            };

            let sfi = grab('Solar Flux|SFI');
            const sunspot = grab('Sunspot|SSN');
            const aIndex = grab('A-Index|A Index|Planetary A|Aindex');
            const kIndex = grab('K-Index|K Index|Planetary K|Kp');
            const dateMatch = text.match(/Updated\s*[:=]?\s*([\w\-/: ]+)/i);
            return {
                sfi,
                sunspot,
                aIndex,
                kIndex,
                date: dateMatch ? dateMatch[1].trim() : undefined
            };
        } catch (err) {
            console.warn('Solar flux parse error:', err);
            return null;
        }
    }

    setSolarCard(html) {
        if (!this.solarFluxCard) return;
        this.solarFluxCard.innerHTML = html;
    }

    async ensureGeocoder() {
        if (this.geocoder && !this.geocoderReady) {
            try {
                await this.geocoder.load();
                this.geocoderReady = true;
            } catch (err) {
                console.warn('Offline geocoder failed to load', err);
                this.setStatus('Offline geocoder unavailable; use lat,lng or GPS.');
            }
        }
    }

    initMap() {
        if (!this.mapContainer || !globalThis.maplibregl) {
            return;
        }

        // Shared view state (aligns with Map module AO selection).
        const c = globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 37.8, lon: -96 };
        const z = globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 3;

        if (globalThis.createMapLibreMap) {
            this.map = globalThis.createMapLibreMap({
                container: this.mapContainer,
                centerLon: c.lon,
                centerLat: c.lat,
                zoom: z,
            });
        } else {
            this.map = new globalThis.maplibregl.Map({
                container: this.mapContainer,
                style: globalThis.buildMapLibreStyle ? globalThis.buildMapLibreStyle() : 'https://tiles.openfreemap.org/styles/liberty',
                center: [c.lon, c.lat],
                zoom: z,
                attributionControl: true,
            });
            this.map.addControl(new globalThis.maplibregl.NavigationControl(), 'top-right');
        }

        this._pathSourceId = `predict-path-${Date.now()}`;
        this._pathLineLayerId = `predict-path-line-${Date.now()}`;
        this._pathPointSourceId = `predict-path-pts-${Date.now()}`;
        this._pathPointLayerId = `predict-path-pts-layer-${Date.now()}`;

        const ensureLayers = () => {
            if (!this.map) return;
            if (this.map.getSource(this._pathSourceId)) return;

            // Line (path)
            this.map.addSource(this._pathSourceId, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            this.map.addLayer({
                id: this._pathLineLayerId,
                type: 'line',
                source: this._pathSourceId,
                paint: {
                    'line-color': '#38bdf8',
                    'line-width': 3,
                    'line-opacity': 0.8,
                },
            });

            // Points (for potential future styling; markers are DOM markers for now)
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
                    'circle-color': ['match', ['get', 'kind'], 'user', '#22c55e', 'target', '#f97316', '#94a3b8'],
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#0b1224',
                },
            });
        };

        this.map.on('load', () => {
            ensureLayers();
        });

        // Persist view (best-effort) so the AO selection is shared.
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

        this.map.on('click', (e) => {
            const { lat, lng } = e.lngLat;
            if (this.mapClickMode === 'user') {
                this.setUserLocation(lat, lng, `Map (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
                this.mapClickMode = null;
                this.updateMapCursor(false);
            } else if (this.mapClickMode === 'target') {
                const target = { lat, lng, name: `Map target (${lat.toFixed(4)}, ${lng.toFixed(4)})` };
                this.renderPlaceResult('Map target', target.name);
                this.drawPathAndPredictFromTarget(target, target.name);
                this.mapClickMode = null;
                this.updateMapCursor(false);
            }
        });
    }

    _setDomMarker(which, lat, lng) {
        if (!this.map) return;
        const isUser = which === 'user';
        const cls = isUser ? 'user' : 'target';
        const prev = isUser ? this._userMarker : this._targetMarker;
        try {
            if (prev) prev.remove();
        } catch (_) {}

        const el = document.createElement('div');
        el.className = `path-icon ${cls}`;
        el.innerHTML = `<div class="marker-dot marker-${cls}"></div>`;

        const mk = new globalThis.maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([lng, lat])
            .addTo(this.map);

        if (isUser) this._userMarker = mk;
        else this._targetMarker = mk;
    }

    _setGeojsonPath({ user, target }) {
        if (!this.map) return;
        const lineSrc = this.map.getSource(this._pathSourceId);
        const ptSrc = this.map.getSource(this._pathPointSourceId);
        if (!lineSrc || !ptSrc) return;

        const featuresLine = [];
        const featuresPts = [];

        if (user && Number.isFinite(user.lat) && Number.isFinite(user.lng)) {
            featuresPts.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [user.lng, user.lat] },
                properties: { kind: 'user' },
            });
        }
        if (target && Number.isFinite(target.lat) && Number.isFinite(target.lng)) {
            featuresPts.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [target.lng, target.lat] },
                properties: { kind: 'target' },
            });
        }
        if (user && target) {
            featuresLine.push({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [user.lng, user.lat],
                        [target.lng, target.lat],
                    ],
                },
                properties: {},
            });
        }

        lineSrc.setData({ type: 'FeatureCollection', features: featuresLine });
        ptSrc.setData({ type: 'FeatureCollection', features: featuresPts });
    }

    async setUserLocationFromInput() {
        const raw = this.userLocationInput.value.trim();
        if (!raw) {
            this.userLocationStatus.textContent = 'Enter a city/state, grid square, or lat,lng.';
            return;
        }

        this.userLocationStatus.textContent = 'Resolving location...';
        try {
            const parsedLatLng = this.parseLatLngInput(raw);
            const parsedGrid = this.parseGridSquare(raw);
            let resolved = null;
            if (parsedLatLng) {
                resolved = { lat: parsedLatLng.lat, lng: parsedLatLng.lng, name: `${parsedLatLng.lat.toFixed(4)}, ${parsedLatLng.lng.toFixed(4)}` };
            } else if (parsedGrid) {
                const label = raw.trim().toUpperCase();
                resolved = { lat: parsedGrid.lat, lng: parsedGrid.lng, name: `${label} grid center` };
            } else {
                resolved = await this.geocodePlace(raw);
            }
            if (!resolved) {
                throw new Error('Geocoder returned no results');
            }

            this.setUserLocation(resolved.lat, resolved.lng, resolved.name);
        } catch (err) {
            console.error('User location lookup failed:', err);
            this.userLocationStatus.textContent = 'Could not resolve that location.';
            this.setStatus('Unable to resolve your station location input.');
        }
    }

    parseLatLngInput(raw) {
        const match = raw.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
        if (!match) return null;
        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
        return { lat, lng };
    }

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

    setUserLocation(lat, lng, label) {
        this.userLocation = { lat, lng, name: label || 'Your station' };
        this.userLocationStatus.textContent = `Set to ${this.userLocation.name} (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
        this.setStatus(`Your station set to ${this.userLocation.name}`);
        
        // Always show user marker and center map on user location
        this.showUserMarker();
        
        if (this.activeRecord) {
            this.updatePathAndPrediction(this.activeRecord);
        } else if (this.targetLocation) {
            // If target already set but no active record, try to draw path
            this.drawPathAndPredictFromTarget(this.targetLocation, this.targetLocation.name);
        }
    }

    setUserLocationFromGps() {
        if (!navigator.geolocation) {
            this.userLocationStatus.textContent = 'Geolocation is not supported in this environment.';
            return;
        }
        this.userLocationStatus.textContent = 'Requesting GPS fix...';
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                this.setUserLocation(latitude, longitude, 'Current position');
            },
            (err) => {
                console.error('Geolocation error:', err);
                this.userLocationStatus.textContent = 'Unable to read GPS/OS location.';
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
        );
    }

    async geocodeRecord(record) {
        const city = (record.city || '').trim();
        const st = (record.st || '').trim().toUpperCase();
        const co = (record.co || '').trim();

        const queries = [];

        // 1) Original full string: "CAVE CREEK, AZ, USA"
        if (city || st || co) {
            queries.push([city, st, co].filter(Boolean).join(', '));
        }

        // 2) Expand state/province codes to full names where possible
        let regionName = null;
        if (st) {
            if (co === 'USA' || co === 'US' || co === 'United States') {
                regionName = US_STATE_NAMES[st] || null;
            } else if (co === 'Canada' || co === 'CAN') {
                regionName = CA_PROVINCE_NAMES[st] || null;
            } else {
                regionName = US_STATE_NAMES[st] || CA_PROVINCE_NAMES[st] || null;
            }
        }

        if (regionName) {
            // City + full region, with/without country
            if (city) {
                queries.push([city, regionName, co].filter(Boolean).join(', '));
                queries.push([city, regionName].filter(Boolean).join(', '));
            }

            // Region + country only as a coarse fallback (e.g., "Arizona, USA")
            queries.push([regionName, co || (co === 'Canada' ? 'Canada' : 'United States of America')].filter(Boolean).join(', '));
            queries.push(regionName);
        }

        // Deduplicate while preserving order
        const seen = new Set();
        const uniqueQueries = queries
            .map(q => q.trim())
            .filter(q => q.length > 0)
            .filter(q => {
                const key = q.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        for (const q of uniqueQueries) {
            const loc = await this.geocodePlace(q);
            if (loc) return loc;
        }

        return null;
    }

    async geocodePlace(query) {
        const raw = (query || '').trim();
        if (!raw) return null;

        const cacheKey = raw.toLowerCase();
        if (this.geocodeCache.has(cacheKey)) {
            return this.geocodeCache.get(cacheKey);
        }

        await this.ensureGeocoder();
        if (!this.geocoderReady) return null;

        const attemptQueries = [];
        const pushUnique = (q) => {
            const v = (q || '').trim();
            if (!v) return;
            const k = v.toLowerCase();
            if (!attemptQueries.some((aq) => aq.toLowerCase() === k)) {
                attemptQueries.push(v);
            }
        };

        // Original full query
        pushUnique(raw);

        // If the query contains commas (e.g., "Toronto, ON, Canada"),
        // also try each component so offline gazetteer matches city names.
        if (raw.includes(',')) {
            const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
            parts.forEach((p) => pushUnique(p));
        }

        // Also try splitting on whitespace for inputs like "New York NY"
        if (/\s+/.test(raw)) {
            raw.split(/\s+/).forEach((p) => pushUnique(p));
        }

        let location = null;
        for (const q of attemptQueries) {
            const key = q.toLowerCase();
            if (this.geocodeCache.has(key)) {
                location = this.geocodeCache.get(key);
                break;
            }

            const offline = this.geocoder.first(q);
            if (offline) {
                location = {
                    lat: offline.lat,
                    lng: offline.lng,
                    name: offline.display || offline.name
                };
                this.geocodeCache.set(key, location);
                break;
            }
        }

        if (!location) {
            // Stay offline-only if no match
            return null;
        }

        // Also cache under the original composite query for faster reuse
        this.geocodeCache.set(cacheKey, location);
        return location;
    }

    async updatePathAndPrediction(record) {
        if (!record) return;

        try {
            const target = await this.geocodeRecord(record);
            if (!target) {
                this.pathSummary.textContent = 'No mappable address for this callsign.';
                this.voacapCard.textContent = 'Propagation unavailable until a valid QTH is found.';
                this.clearPath();
                return;
            }
            this.targetLocation = target;

            if (!this.userLocation) {
                this.showTargetOnly(target, target.name);
                this.voacapCard.textContent = 'Propagation predictions need both endpoints.';
                this.voacapForecast.textContent = 'Forecast available after path is plotted.';
                this.lastDistanceKm = null;
                return;
            }

            const distanceKm = this.calculateDistanceKm(
                this.userLocation.lat,
                this.userLocation.lng,
                target.lat,
                target.lng
            );
            this.lastDistanceKm = distanceKm;
            const distanceMi = distanceKm * 0.621371;
            const bearingDeg = this.calculateBearingDeg(
                this.userLocation.lat,
                this.userLocation.lng,
                target.lat,
                target.lng
            );
            const bearingLabel = this.formatBearing(bearingDeg);

            this.pathSummary.innerHTML = `
                <strong>${distanceMi.toFixed(1)} mi</strong> / ${distanceKm.toFixed(1)} km
                @ <strong>${bearingLabel}</strong> between
                <span class="path-label">${this.userLocation.name}</span> and
                <span class="path-label">${target.name}</span>
            `;

            this.drawPath(target);
            this.renderPropagation(distanceKm);
            this.renderForecast(distanceKm);
        } catch (err) {
            console.error('Path drawing failed:', err);
            this.pathSummary.textContent = 'Unable to compute path for this record.';
            this.voacapCard.textContent = 'Propagation prediction skipped due to missing path.';
            this.voacapForecast.textContent = 'Forecast unavailable.';
            this.lastDistanceKm = null;
        }
    }

    clearPath() {
        // Clear any existing path/target markers
        try {
            this._setGeojsonPath({ user: null, target: null });
        } catch (_) {
            // ignore
        }
        try {
            if (this._targetMarker) this._targetMarker.remove();
        } catch (_) {}
        this._targetMarker = null;

        // If we still have a station location set, keep showing that marker.
        if (this.userLocation && this.map) {
            this._setDomMarker('user', this.userLocation.lat, this.userLocation.lng);
            this._setGeojsonPath({ user: this.userLocation, target: null });
        }

        this.lastDistanceKm = null;
    }

    showTargetOnly(targetLocation, displayName) {
        if (!this.map || !targetLocation) return;

        this._setGeojsonPath({ user: null, target: targetLocation });
        this._setDomMarker('target', targetLocation.lat, targetLocation.lng);

        try {
            this.map.easeTo({ center: [targetLocation.lng, targetLocation.lat], zoom: 5 });
        } catch (_) {
            // ignore
        }

        this.pathSummary.innerHTML = `Target location: <span class="path-label">${displayName || targetLocation.name}</span> (${targetLocation.lat.toFixed(4)}, ${targetLocation.lng.toFixed(4)})`;
        this.lastDistanceKm = null;
    }

    showUserMarker() {
        // Show just the user marker and center map on their location
        if (!this.map || !this.userLocation) return;

        this._setGeojsonPath({ user: this.userLocation, target: null });
        this._setDomMarker('user', this.userLocation.lat, this.userLocation.lng);

        // Center map on user location
        try {
            this.map.easeTo({ center: [this.userLocation.lng, this.userLocation.lat], zoom: 5 });
        } catch (_) {
            // ignore
        }
        
        this.pathSummary.innerHTML = `Your location: <span class="path-label">${this.userLocation.name}</span> (${this.userLocation.lat.toFixed(4)}, ${this.userLocation.lng.toFixed(4)})`;
    }

    drawPath(targetLocation) {
        if (!this.map || !this.userLocation || !targetLocation) return;

        this._setGeojsonPath({ user: this.userLocation, target: targetLocation });
        this._setDomMarker('user', this.userLocation.lat, this.userLocation.lng);
        this._setDomMarker('target', targetLocation.lat, targetLocation.lng);

        try {
            const b = new globalThis.maplibregl.LngLatBounds();
            b.extend([this.userLocation.lng, this.userLocation.lat]);
            b.extend([targetLocation.lng, targetLocation.lat]);
            this.map.fitBounds(b, {
                padding: 24,
                maxZoom: 8,
            });
        } catch (_) {
            // ignore
        }
    }

    renderPropagation(distanceKm) {
        const sfi = parseInt(this.sfiInput.value, 10) || 120;
        const utcDate = this.getUtcDateFromInput();
        const prediction = this.predictPropagation({
            distanceKm,
            utcDate,
            sfi,
            mode: this.modeInput.value,
            power: this.getPowerWatts()
        });

        this.voacapCard.innerHTML = `
            <div class="voacap-header">VOACAP-style estimate</div>
            <div class="voacap-meta">
                <span>Path: ${distanceKm.toFixed(1)} km</span>
                <span>UTC: ${utcDate.toISOString().replace('T', ' ').slice(0, 16)}</span>
                <span>SFI: ${sfi}</span>
            </div>
            <div class="voacap-bands">
                ${prediction.bands.map((band) => `
                    <div class="voacap-band">
                        <div class="band-name">${band.name}</div>
                        <div class="band-detail">${band.detail}</div>
                        <div class="band-score">Reliability: ${(band.score * 100).toFixed(0)}%</div>
                    </div>
                `).join('')}
            </div>
            <div class="voacap-notes">
                <strong>Method:</strong> ${prediction.method}<br>
                <strong>Notes:</strong> ${prediction.notes}
            </div>
        `;
    }

    renderForecast(distanceKm) {
        const hoursRaw = parseInt(this.forecastHoursInput.value, 10);
        const horizon = Math.min(Math.max(hoursRaw || 12, 1), 72);
        const sfi = parseInt(this.sfiInput.value, 10) || 120;
        const baseDate = this.getUtcDateFromInput();

        if (!distanceKm || Number.isNaN(distanceKm)) {
            this.voacapForecast.textContent = 'Forecast available after path is plotted.';
            if (this.forecastGraph) this.forecastGraph.innerHTML = '';
            return;
        }

        const step = Math.max(1, Math.round(horizon / 6));
        const rows = [];
        const timeSlots = [];
        const bandSeries = new Map();

        for (let h = 0; h <= horizon; h += step) {
            const slotDate = new Date(baseDate.getTime() + h * 3600 * 1000);
            const allBands = this.buildBandScores(distanceKm, slotDate, sfi, this.modeInput.value, this.getPowerWatts());
            const sorted = [...allBands].sort((a, b) => b.score - a.score);
            const top = sorted[0];
            const timeLabel = slotDate.toISOString().slice(11, 16); // HH:MM
            timeSlots.push(slotDate);
            rows.push({
                hour: timeLabel,
                name: top.name,
                score: top.score,
                detail: top.detail
            });

            sorted.forEach((band) => {
                if (!bandSeries.has(band.name)) {
                    bandSeries.set(band.name, []);
                }
                bandSeries.get(band.name).push({
                    time: timeLabel,
                    score: band.score
                });
            });
        }

        this.voacapForecast.innerHTML = `
            <div class="voacap-header">Next ${horizon}h best windows (UTC)</div>
            <div class="forecast-grid">
                ${rows.map((row) => `
                    <div class="forecast-item">
                        <div class="forecast-time">${row.hour} UTC</div>
                        <div class="forecast-band">${row.name}</div>
                        <div class="forecast-score">Reliability: ${(row.score * 100).toFixed(0)}%</div>
                        <div class="forecast-detail">${row.detail}</div>
                    </div>
                `).join('')}
            </div>
            <div class="forecast-graph" id="forecastGraph"></div>
            <div class="band-graphs" id="bandGraphs"></div>
        `;

        this.forecastGraph = this.voacapForecast.querySelector('#forecastGraph');
        this.bandGraphs = this.voacapForecast.querySelector('#bandGraphs');
        const labels = rows.map((r) => r.hour);
        this.renderForecastGraph(labels, bandSeries, this.forecastGraph);
        this.renderBandGraphs(labels, timeSlots, distanceKm, sfi);
    }

    updateForecast() {
        if (!this.lastDistanceKm) {
            this.voacapForecast.textContent = 'Forecast available after path is plotted.';
            if (this.forecastGraph) this.forecastGraph.innerHTML = '';
            return;
        }
        this.renderForecast(this.lastDistanceKm);
    }

    getUtcDateFromInput() {
        const dateValue = this.dateTimeInput.value;
        if (dateValue) {
            const parsed = new Date(`${dateValue}Z`);
            if (!Number.isNaN(parsed.getTime())) {
                return parsed;
            }
        }
        return new Date();
    }

    renderBandGraphs(labels, timeSlots, distanceKm, sfi) {
        if (!this.bandGraphs) return;
        this.bandGraphs.innerHTML = '';

        const bandNames = [
            '80m (3.5-4 MHz)', '60m (5 MHz)', '40m (7 MHz)', '30m (10 MHz)',
            '20m (14 MHz)', '17m (18 MHz)', '15m (21 MHz)', '12m (24 MHz)', '10m (28 MHz)'
        ];

        bandNames.forEach((bandName) => {
            const seriesMap = new Map();

            // FM is not generally used on HF/shortwave in this context, so we
            // hide it from the per-band charts to reduce clutter.
            const modesForBand = ['SSB', 'Digital'];

            modesForBand.forEach((mode) => {
                const modeSeries = [];
                timeSlots.forEach((slot) => {
                    const timeLabel = slot.toISOString().slice(11, 16);
                    const bands = this.buildBandScores(distanceKm, slot, sfi, mode, this.getPowerWatts());
                    const target = bands.find((b) => b.name === bandName);
                    modeSeries.push({
                        time: timeLabel,
                        score: target ? target.score : 0
                    });
                });
                seriesMap.set(mode, modeSeries);
            });

            const graphHost = document.createElement('div');
            graphHost.className = 'mode-graph';
            graphHost.innerHTML = `<div class="mode-graph-title">${bandName}</div><div class="forecast-graph"></div>`;
            const graphDiv = graphHost.querySelector('.forecast-graph');
            this.bandGraphs.appendChild(graphHost);
            this.renderForecastGraph(labels, seriesMap, graphDiv, `${bandName} (SSB/Digital)`);
        });
    }

    renderForecastGraph(labels, bandSeries, container = this.forecastGraph, title = 'Forecast') {
        if (!container) return;
        const seriesList = Array.from(bandSeries.entries()).slice(0, 8); // limit lines for readability
        if (!seriesList.length) {
            container.innerHTML = '';
            return;
        }

        const width = 720;
        const height = 180;
        const padding = { left: 40, right: 10, top: 10, bottom: 24 };
        const xStep = (width - padding.left - padding.right) / Math.max(labels.length - 1, 1);
        const toX = (idx) => padding.left + idx * xStep;
        const toY = (score) => padding.top + (1 - Math.max(0, Math.min(1, score))) * (height - padding.top - padding.bottom);

        const colors = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#facc15', '#fb923c'];

        let paths = '';
        seriesList.forEach(([name, points], idx) => {
            const color = colors[idx % colors.length];
            const ordered = labels.map((label) => {
                const found = points.find((p) => p.time === label);
                return found ? found.score : null;
            });
            let d = '';
            ordered.forEach((val, i) => {
                if (val === null || val === undefined) return;
                const x = toX(i);
                const y = toY(val);
                d += d ? ` L ${x} ${y}` : `M ${x} ${y}`;
            });
            paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9" />`;
            const lastIdx = ordered.reduce((acc, val, i) => (val !== null && val !== undefined ? i : acc), 0);
            const lastVal = ordered[lastIdx];
            if (lastVal !== null && lastVal !== undefined) {
                const tx = toX(lastIdx);
                const ty = toY(lastVal) - 6;
                paths += `<text x="${tx}" y="${ty}" fill="${color}" font-size="10" text-anchor="start" font-weight="700">${name}</text>`;
            }
        });

        // x-axis labels
        const xTicks = labels.map((label, idx) => {
            const x = toX(idx);
            const y = height - padding.bottom + 14;
            return `<text x="${x}" y="${y}" fill="#9ca3af" font-size="10" text-anchor="middle">${label}</text>`;
        }).join('');

        const yTicks = [0, 0.25, 0.5, 0.75, 1].map((v) => {
            const y = toY(v);
            return `<g>
                <line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#1f2937" stroke-width="1" />
                <text x="${padding.left - 8}" y="${y + 3}" fill="#9ca3af" font-size="10" text-anchor="end">${Math.round(v * 100)}%</text>
            </g>`;
        }).join('');

        const legendItems = seriesList.map(([name], idx) => {
            const color = colors[idx % colors.length];
            return `<div class="legend-item"><span class="legend-swatch" style="background:${color};"></span>${name}</div>`;
        }).join('');

        container.innerHTML = `
            <div class="forecast-svg graph-clickable" data-graph-title="${title}">
                <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
                    <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
                    ${yTicks}
                    ${paths}
                    ${xTicks}
                </svg>
            </div>
            <div class="forecast-legend">
                ${legendItems}
            </div>
        `;

        const svgHost = container.querySelector('.forecast-svg');
        if (svgHost) {
            svgHost.addEventListener('click', () => {
                this.openGraphModal(svgHost.innerHTML, svgHost.dataset.graphTitle || title);
            });
        }
    }

    predictPropagation({ distanceKm, utcDate, sfi, mode, power }) {
        const bandsAll = this.buildBandScores(distanceKm, utcDate, sfi, mode, power);
        const bands = [...bandsAll].sort((a, b) => b.score - a.score).slice(0, 5);

        const method = this.pickMethod({ distanceKm, sfi, mode });
        const notes = `Modelled with a lightweight VOACAP-inspired curve. For precise results use full VOACAP with exact coordinates.`;

        return { bands, method, notes };
    }

    buildBandScores(distanceKm, utcDate, sfi, mode, power) {
        const hour = utcDate.getUTCHours();
        const month = utcDate.getUTCMonth() + 1;
        const isNight = hour < 7 || hour >= 20;
        const isDay = hour >= 8 && hour <= 17;
        const isDuskDawn = (hour >= 6 && hour < 8) || (hour >= 17 && hour < 20);
        const solarFactor = Math.min(Math.max((sfi - 60) / 140, 0), 1); // 0..1 between SFI 60-200
        const powerFactor = this.powerReliabilityFactor(power);

        const baseBands = [
            { name: '80m (3.5-4 MHz)', minKm: 0, maxKm: 800, day: -0.25, night: 0.45, solarWeight: 0.05 },
            { name: '60m (5 MHz)', minKm: 0, maxKm: 900, day: -0.15, night: 0.35, solarWeight: 0.08 },
            { name: '40m (7 MHz)', minKm: 50, maxKm: 1800, day: 0.25, night: 0.45, solarWeight: 0.1 },
            { name: '30m (10 MHz)', minKm: 200, maxKm: 3000, day: 0.4, night: 0.35, solarWeight: 0.15 },
            { name: '20m (14 MHz)', minKm: 500, maxKm: 5000, day: 0.6, night: isNight ? 0.25 : 0.6, solarWeight: 0.25 },
            { name: '17m (18 MHz)', minKm: 800, maxKm: 6000, day: 0.45, night: isNight ? -0.05 : 0.45, solarWeight: 0.3 },
            { name: '15m (21 MHz)', minKm: 1000, maxKm: 7000, day: 0.35, night: -0.25, solarWeight: 0.4 },
            { name: '12m (24 MHz)', minKm: 1500, maxKm: 8000, day: 0.25, night: -0.35, solarWeight: 0.45 },
            { name: '10m (28 MHz)', minKm: 1200, maxKm: 8000, day: 0.2, night: -0.5, solarWeight: 0.5 }
        ];

        return baseBands.map((band) => {
            const mhz = this.extractMHz(band.name);
            const rangeScore = this.rangeScore(distanceKm, band.minKm, band.maxKm);

            // Diurnal weighting by band class
            let diurnal = 0;
            if (mhz <= 8) {
                diurnal = isNight ? 0.35 : -0.25; // D-layer absorption daytime
            } else if (mhz <= 18) {
                diurnal = isDay ? 0.15 : -0.1;
            } else {
                diurnal = isDay ? 0.35 : -0.35;
            }

            const solarBoost = band.solarWeight * solarFactor;
            const duskBoost = isDuskDawn ? 0.1 : 0;
            const seasonalLoss = (month >= 5 && month <= 8 && mhz <= 10) ? -0.05 : 0;

            let score = 0.25 + diurnal + solarBoost + duskBoost + rangeScore + seasonalLoss;

            if (mode === 'FM' && band.name.includes('10m')) {
                score += 0.05; // FM calling around 29 MHz
            }

            if (mode === 'Digital') {
                score += 0.05; // digital modes stretch marginal paths
            }

            score = Math.max(0, Math.min(1, score * powerFactor));

            const detail = [];
            if (rangeScore > 0.65) detail.push('Sweet-spot path length');
            if (rangeScore < 0) detail.push('Out of skip range');
            if (isNight && mhz <= 10) detail.push('Night-favored');
            if (isDay && mhz >= 14) detail.push('Day-favored');
            if (solarBoost > 0.2) detail.push('High solar boost');
            if (duskBoost) detail.push('Greyline assist');

            return {
                name: band.name,
                score,
                detail: detail.length ? detail.join(' - ') : 'General use'
            };
        });
    }

    rangeScore(distanceKm, minKm, maxKm) {
        const center = (minKm + maxKm) / 2;
        const halfWidth = (maxKm - minKm) / 2;
        if (distanceKm < minKm) {
            const diff = minKm - distanceKm;
            return Math.max(-0.6, 0.2 - (diff / minKm) * 0.8);
        }
        if (distanceKm > maxKm) {
            const diff = distanceKm - maxKm;
            return Math.max(-0.6, 0.2 - (diff / maxKm) * 0.8);
        }
        const t = 1 - Math.abs(distanceKm - center) / halfWidth;
        return 0.2 + t * 0.6; // 0.2 to 0.8
    }

    extractMHz(name) {
        const m = name.match(/([\d.]+)\s*MHz/i);
        return m ? parseFloat(m[1]) : 0;
    }

    pickMethod({ distanceKm, sfi, mode }) {
        if (mode === 'Digital') return 'Digital weak-signal (FT8/JS8) for reliable paths.';
        if (distanceKm < 150 && !this.userLocation?.coastal) return 'Ground/NVIS with 80/60/40 m at moderate power.';
        if (sfi < 80) return 'Lower bands (40/30 m) with CW or digital due to low SFI.';
        if (distanceKm > 3000) return 'Multi-hop HF; prioritize 20/17/15 m SSB or digital around local daytime.';
        return 'SSB/CW on 20/17 m in daylight; 40 m near dusk/dawn.';
    }

    getPowerWatts() {
        const val = parseInt(this.powerInput.value, 10);
        if (Number.isNaN(val) || val <= 0) return 50;
        return Math.max(1, Math.min(1500, val));
    }

    powerReliabilityFactor(powerW) {
        const base = powerW || 50;
        const ref = 5;
        const factor = 1 + Math.log10(base / ref) * 0.12; // modest lift for higher power
        return Math.min(Math.max(factor, 0.75), 1.25);
    }

    ensureModalShell() {
        if (document.querySelector('.graph-modal')) return;
        const modal = document.createElement('div');
        modal.className = 'graph-modal hidden';
        modal.innerHTML = `
            <div class="graph-modal-backdrop"></div>
            <div class="graph-modal-dialog">
                <div class="graph-modal-header">
                    <div class="graph-modal-title" id="graphModalTitle"></div>
                    <button class="graph-modal-close" aria-label="Close">✕</button>
                </div>
                <div class="graph-modal-body" id="graphModalBody"></div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.graph-modal-backdrop').addEventListener('click', () => this.closeGraphModal());
        modal.querySelector('.graph-modal-close').addEventListener('click', () => this.closeGraphModal());
    }

    openGraphModal(contentHtml, title) {
        const modal = document.querySelector('.graph-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        modal.querySelector('#graphModalBody').innerHTML = contentHtml;
        modal.querySelector('#graphModalTitle').textContent = title || 'Graph';
    }

    closeGraphModal() {
        const modal = document.querySelector('.graph-modal');
        if (!modal) return;
        modal.classList.add('hidden');
    }

    updateMapCursor(active) {
        if (!this.mapContainer) return;
        if (active) {
            this.mapContainer.classList.add('map-pick-mode');
        } else {
            this.mapContainer.classList.remove('map-pick-mode');
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

    calculateBearingDeg(lat1, lng1, lat2, lng2) {
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δλ = (lng2 - lng1) * Math.PI / 180;

        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) -
            Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

        let θ = Math.atan2(y, x) * 180 / Math.PI; // in degrees
        if (!Number.isFinite(θ)) return 0;

        // Normalize to 0–360°
        θ = (θ + 360) % 360;
        return θ;
    }

    bearingToCompass(bearingDeg) {
        if (!Number.isFinite(bearingDeg)) return '';
        const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
            'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const normalized = ((bearingDeg % 360) + 360) % 360;
        const index = Math.round(normalized / 22.5) % 16;
        return dirs[index];
    }

    formatBearing(bearingDeg) {
        if (!Number.isFinite(bearingDeg)) return '\u2014';
        const rounded = Math.round(bearingDeg);
        const dir = this.bearingToCompass(rounded);
        return dir ? `${rounded}\u00b0 ${dir}` : `${rounded}\u00b0`;
    }

    async loadData() {
        try {
            if (!this.callsignDb) {
                throw new Error('Callsign DB helper not loaded');
            }
            if (this.callsignDbReady || this.callsignDbLoading) return;

            this.callsignDbLoading = true;
            this.setStatus('Loading callsign database...');

            // Bind progress once per module instance.
            if (!this._dbProgressBound && typeof this.callsignDb.onProgress === 'function') {
                this._dbProgressBound = true;
                this.callsignDb.onProgress((evt) => {
                    try {
                        if (!evt || evt.type !== 'CALLSIGN_DB_PROGRESS') return;
                        if (evt.phase === 'index' && Number.isFinite(evt.done) && Number.isFinite(evt.total) && evt.total > 0) {
                            const pct = Math.max(0, Math.min(100, Math.round((evt.done / evt.total) * 100)));
                            this.setStatus(`Indexing callsign database... ${pct}%`);
                        }
                    } catch (_) {
                        // ignore
                    }
                });
            }

            this.meta = await this.callsignDb.load();
            this.callsignDbReady = true;
            this.callsignDbLoading = false;

            const metaText = this.meta
                ? `Loaded ${this.meta.counts?.total?.toLocaleString?.() || '?'} records (${this.meta.counts?.usa?.toLocaleString?.() || '?'} USA, ${this.meta.counts?.canada?.toLocaleString?.() || '?'} Canada)`
                : `Loaded callsign records`;
            this.metaEl.textContent = metaText;
            this.setStatus('Callsign data ready for offline lookup.');
            this.resultEl.textContent = 'Enter a callsign to see license details.';
        } catch (error) {
            console.error('Error loading callsign data:', error);
            this.callsignDbReady = false;
            this.callsignDbLoading = false;
            this.setStatus('Unable to load callsign data. Ensure assets/data/callsigns.json is available.');
            this.resultEl.classList.add('error');
            this.resultEl.textContent = 'Callsign data unavailable. Make sure callsigns.json is present and cached for offline use.';
        }
    }

    async lookupCallsign() {
        const query = this.queryInput.value.trim().toUpperCase();
        if (!query) {
            this.setStatus('Enter a callsign to search.');
            return;
        }
        if (!this.callsignDb || typeof this.callsignDb.lookup !== 'function') {
            this.setStatus('Callsign DB helper unavailable.');
            return;
        }
        if (!this.callsignDbReady) {
            this.setStatus('Callsign database is still loading...');
            this.loadData().catch(() => {});
            return;
        }

        let exact = null;
        try {
            exact = await this.callsignDb.lookup(query);
        } catch (e) {
            console.error(e);
            this.setStatus('Callsign lookup failed (DB error).');
            return;
        }
        if (exact) {
            this.activeRecord = exact;
            this.setDateTimeToNow();
            this.updateUtcStatus();
            this.renderResult(exact);
            this.setStatus(`Exact match found for ${query}`);
            this.suggestionsEl.innerHTML = '';
            this.updatePathAndPrediction(exact);
            return;
        }

        // Prefix suggestions (limited to 25 to avoid UI spam)
        let prefixMatches = [];
        try {
            prefixMatches = await this.callsignDb.suggest(query, 25);
        } catch (e) {
            console.error(e);
            this.setStatus('Callsign suggestion search failed (DB error).');
            return;
        }
        this.suggestionLookup.clear();
        (prefixMatches || []).forEach((rec) => {
            if (rec && rec.c) this.suggestionLookup.set(rec.c, rec);
        });

        if (prefixMatches.length === 0) {
            this.resultEl.classList.add('muted');
            this.resultEl.textContent = 'No results found. Check the callsign and try again.';
            this.suggestionsEl.innerHTML = '';
            this.setStatus('No results found.');
            return;
        }

        this.resultEl.classList.add('muted');
        this.resultEl.textContent = `No exact match for ${query}. Showing ${prefixMatches.length} nearby callsigns.`;
        this.setStatus(`Showing ${prefixMatches.length} callsigns starting with ${query}`);
        this.renderSuggestions(prefixMatches);
    }

    renderResult(record) {
        this.activeRecord = record;
        this.resultEl.classList.remove('muted', 'error');
        this.resultEl.innerHTML = `
            <div class="result-header">
                <div>
                    <div class="callsign">${record.c}</div>
                    <div class="name">${record.n || 'Unknown licensee'}</div>
                </div>
                <div class="country-tag">${record.co || 'Unknown'}</div>
            </div>
            <div class="result-details">
                <div><span class="label">City/Province:</span> ${[record.city, record.st].filter(Boolean).join(', ') || 'n/a'}</div>
                <div><span class="label">Class:</span> ${record.cl || 'n/a'}</div>
                <div><span class="label">Expires:</span> ${record.ex || 'n/a'}</div>
                <div><span class="label">Granted:</span> ${record.g || 'n/a'}</div>
            </div>
        `;
    }

    renderPlaceResult(query, resolvedName) {
        this.resultEl.classList.remove('muted', 'error');
        this.resultEl.innerHTML = `
            <div class="result-header">
                <div>
                    <div class="callsign">${query}</div>
                    <div class="name">Location lookup</div>
                </div>
                <div class="country-tag">Geocoded</div>
            </div>
            <div class="result-details">
                <div><span class="label">Resolved to:</span> ${resolvedName}</div>
                <div><span class="label">Class:</span> n/a</div>
                <div><span class="label">Expires:</span> n/a</div>
                <div><span class="label">Granted:</span> n/a</div>
            </div>
        `;
    }

    renderSuggestions(records) {
        this.suggestionsEl.innerHTML = records.map((rec) => `
            <div class="suggestion" data-callsign="${rec.c}">
                <div class="callsign">${rec.c}</div>
                <div class="name">${rec.n || 'Unknown licensee'}</div>
                <div class="location">${[rec.city, rec.st].filter(Boolean).join(', ') || 'n/a'}</div>
                <div class="class">${rec.cl || 'n/a'}</div>
            </div>
        `).join('');

        this.suggestionsEl.querySelectorAll('.suggestion').forEach((node) => {
            node.addEventListener('click', () => {
                const cs = node.getAttribute('data-callsign');
                const record = this.suggestionLookup.get(cs);
                if (record) {
                    this.queryInput.value = cs;
                    this.activeRecord = record;
                    this.renderResult(record);
                    this.setStatus(`Exact match found for ${cs}`);
                    this.suggestionsEl.innerHTML = '';
                    this.updatePathAndPrediction(record);
                }
            });
        });
    }

    setStatus(message) {
        this.statusEl.textContent = message;
        if (window.radioApp) {
            window.radioApp.updateStatus(message);
        }
    }

    async tryFetchJson() {
        try {
            const dataUrl = new URL('assets/data/callsigns.json', window.location.href).toString();
            const response = await fetch(dataUrl);
            if (!response.ok) return null;
            return await response.json();
        } catch (err) {
            console.warn('fetch JSON failed:', err);
            return null;
        }
    }

    async lookupGrid() {
        if (!this.gridInput) return;
        const raw = this.gridInput.value.trim();
        if (!raw) {
            this.setStatus('Enter a grid square to search (e.g., FN03 or FN03fr).');
            return;
        }

        const parsed = this.parseGridSquare(raw);
        if (!parsed) {
            this.setStatus('Grid square not recognized. Use formats like FN03 or FN03fr.');
            return;
        }

        const grid = raw.toUpperCase();
        const target = {
            lat: parsed.lat,
            lng: parsed.lng,
            name: `${grid} grid center`
        };

        this.activeRecord = {
            c: grid,
            n: 'Grid square',
            city: '',
            st: '',
            co: 'Grid',
            cl: 'n/a',
            ex: '',
            g: ''
        };

        this.setDateTimeToNow();
        this.updateUtcStatus();
        this.renderPlaceResult(grid, target.name);
        await this.drawPathAndPredictFromTarget(target, grid);
    }

    async tryLoadScriptPayload() {
        try {
            await this.loadScriptOnce('assets/data/callsigns.js');
            return window.CALLSIGNS_DATA || null;
        } catch (err) {
            console.warn('Loading callsigns.js failed:', err);
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
}
