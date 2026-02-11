/**
 * Repeater Map Module
 * Displays amateur radio repeaters on an interactive map
 */

class RepeaterMap {
    constructor() {
        this.map = null;
        this.userLocation = null;
        this.repeaterMarkers = [];
        this.selectedRepeater = null;
        this.currentRadius = 50;
        this.offlineLayer = null;
        this.geocoder = window.offlineGeocoder || null;
        this.geocoderReady = false;
        this.mapClickMode = false;
        this.mapContainer = null;
        this.hasInitializedDefaultView = false;

        // MapLibre state
        this._markerById = new Map();
        this._repeaterSourceId = null;
        this._repeaterLayerId = null;
        this._userMarker = null;
        this._repeaterById = new Map();
        
        this.init();
    }
    
    init() {
        // Create module HTML structure
        this.createModuleStructure();
        this.mapContainer = document.getElementById('map');
        
        // Initialize map
        this.initMap();

        // Default behavior: show all repeaters as soon as the user enters this tab.
        // Filtering-by-radius only happens after a location is chosen.
        this.showAllRepeaters();
        this.hasInitializedDefaultView = true;

        // Start loading offline geocoder dataset
        this.ensureGeocoder();
        
        // Bind events
        this.bindEvents();
        
        // Update status (showAllRepeaters already sets a useful status)
    }
    
    createModuleStructure() {
        const moduleContainer = document.getElementById('repeater-map');
        
        moduleContainer.innerHTML = `
            <div class="repeater-map-container">
                <div class="xModuleIntro">
                    <div class="xModuleIntroTitle">What you can do here</div>
                    <div class="xModuleIntroText">
                        Find repeaters near a place (or your GPS), filter by band/mode/radius, then tap a marker to see tones, offsets, and notes.
                    </div>
                </div>
                <div class="controls">
                    <div class="search-container">
                        <input type="text" id="locationSearch" placeholder="Enter location">
                        <button id="searchBtn">Search</button>
                        <button id="currentLocationBtn">Current Location</button>
                        <button id="pickOnMapBtn" type="button">Pick on map</button>
                    </div>
                    
                    <div class="filter-controls">
                        <div class="filter-group">
                            <label for="bandFilter">Band:</label>
                            <select id="bandFilter">
                                <option value="all">All Bands</option>
                                <option value="2m">2 Meters</option>
                                <option value="70cm">70 cm</option>
                                <option value="6m">6 Meters</option>
                                <option value="1.25m">1.25m</option>
                            </select>
                        </div>
                        
                        <div class="filter-group">
                            <label for="radiusFilter">Radius:</label>
                            <select id="radiusFilter">
                                <option value="25">25 km</option>
                                <option value="50" selected>50 km</option>
                                <option value="100">100 km</option>
                                <option value="200">200 km</option>
                            </select>
                        </div>
                        
                        <div class="filter-group">
                            <label for="modeFilter">Mode:</label>
                            <select id="modeFilter">
                                <option value="all">All Modes</option>
                                <option value="FM">FM</option>
                                <option value="DMR">DMR</option>
                                <option value="D-STAR">D-STAR</option>
                                <option value="YSF">Fusion</option>
                            </select>
                        </div>
                    </div>
                </div>
                
                <div id="map"></div>
                
                <div class="sidebar">
                    <div class="info-panel">
                        <h3>Repeater Information</h3>
                        <div id="repeaterInfo">
                            <p>Click on a repeater marker to view details</p>
                        </div>
                    </div>
                    
                    <div class="results-panel">
                        <h3>Results (<span id="resultCount">0</span>)</h3>
                        <div id="repeaterList"></div>
                    </div>
                </div>
            </div>
        `;
    }
    
    initMap() {
        if (!globalThis.maplibregl) {
            console.warn('MapLibre not available');
            return;
        }

        // Shared view state.
        const c = globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 39.8283, lon: -98.5795 };
        const z = globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 3;

        this.map = globalThis.createMapLibreMap
            ? globalThis.createMapLibreMap({
                container: 'map',
                centerLon: c.lon,
                centerLat: c.lat,
                zoom: z,
            })
            : new globalThis.maplibregl.Map({
                container: 'map',
                style: globalThis.buildMapLibreStyle ? globalThis.buildMapLibreStyle() : 'https://tiles.openfreemap.org/styles/liberty',
                center: [c.lon, c.lat],
                zoom: z,
            });

        try {
            this.map.addControl(new globalThis.maplibregl.NavigationControl(), 'top-right');
        } catch (_) { /* ignore */ }

        // Persist view.
        const saveView = () => {
            try {
                const center = this.map.getCenter();
                const zoom = this.map.getZoom();
                globalThis.setMapDefaultCoords && globalThis.setMapDefaultCoords({ lat: center.lat, lon: center.lng });
                globalThis.setMapDefaultZoom && globalThis.setMapDefaultZoom(Number(zoom));
            } catch (_) { /* ignore */ }
        };
        this.map.on('moveend', saveView);
        this.map.on('zoomend', saveView);

        // Create a GeoJSON source for repeaters (keeps rendering fast for large datasets)
        this._repeaterSourceId = `repeaters-${Date.now()}`;
        this._repeaterLayerId = `repeaters-circle-${Date.now()}`;

        this.map.on('load', () => {
            this.map.addSource(this._repeaterSourceId, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            this.map.addLayer({
                id: this._repeaterLayerId,
                type: 'circle',
                source: this._repeaterSourceId,
                paint: {
                    'circle-radius': 6,
                    'circle-color': '#3498db',
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff',
                }
            });

            // Click selection
            this.map.on('click', this._repeaterLayerId, (e) => {
                const f = e && e.features && e.features[0];
                if (!f) return;
                const id = f.properties && f.properties.id ? String(f.properties.id) : '';
                if (!id) return;
                const repeater = this._repeaterById ? this._repeaterById.get(id) : null;
                if (!repeater) return;
                this.selectRepeater(repeater);
            });

            // cursor affordance
            this.map.on('mouseenter', this._repeaterLayerId, () => {
                try { this.map.getCanvas().style.cursor = 'pointer'; } catch (_) {}
            });
            this.map.on('mouseleave', this._repeaterLayerId, () => {
                try { this.map.getCanvas().style.cursor = ''; } catch (_) {}
            });
        });
    }
    
    bindEvents() {
        // Search button
        document.getElementById('searchBtn').addEventListener('click', () => {
            this.searchLocation();
        });
        
        // Current location button
        document.getElementById('currentLocationBtn').addEventListener('click', () => {
            this.getCurrentLocation();
        });

        // Pick on map button (mirrors lookup tab UX)
        const pickOnMapBtn = document.getElementById('pickOnMapBtn');
        if (pickOnMapBtn) {
            pickOnMapBtn.addEventListener('click', () => {
                this.mapClickMode = true;
                this.updateStatus('Click on the map to set your search center.');
                this.updateMapCursor(true);
            });
        }
        
        // Enter key in search box
        document.getElementById('locationSearch').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.searchLocation();
            }
        });
        
        // Filter controls
        document.getElementById('bandFilter').addEventListener('change', () => {
            this.updateRepeaters();
        });
        
        document.getElementById('radiusFilter').addEventListener('change', () => {
            this.currentRadius = parseInt(document.getElementById('radiusFilter').value);
            this.updateRepeaters();
        });
        
        document.getElementById('modeFilter').addEventListener('change', () => {
            this.updateRepeaters();
        });

        // Repeater list click (event delegation so large lists stay fast)
        const listContainer = document.getElementById('repeaterList');
        if (listContainer) {
            listContainer.addEventListener('click', (e) => {
                const item = e && e.target && e.target.closest ? e.target.closest('.repeater-item') : null;
                if (!item) return;
                const repeaterId = String(item.dataset.id || '');
                if (!repeaterId) return;
                const repeater = this._repeaterById ? this._repeaterById.get(repeaterId) : null;
                if (!repeater) return;

                this.selectRepeater(repeater);
                try {
                    this.map.easeTo({ center: [repeater.lng, repeater.lat], zoom: Math.max(this.map.getZoom() || 6, 6) });
                } catch (_) { /* ignore */ }
            });
        }

        // Map click to set location manually (and support "Pick on map" mode like the Predict tab)
        if (this.map) {
            this.map.on('click', (e) => {
                // IMPORTANT: Only set a search center when explicitly in "Pick on map" mode.
                if (!this.mapClickMode) return;

                const { lat, lng } = e.lngLat;
                this.setUserLocation(lat, lng, `Custom location (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
                this.mapClickMode = false;
                this.updateMapCursor(false);
            });
        }
    }

    async ensureGeocoder() {
        if (this.geocoder && !this.geocoderReady) {
            try {
                await this.geocoder.load();
                this.geocoderReady = true;
            } catch (err) {
                console.warn('Offline geocoder failed to load', err);
                this.updateStatus('Offline geocoder unavailable; use lat,lng or GPS.');
            }
        }
    }

    parseLatLng(raw) {
        const parts = raw.split(',').map(p => p.trim());
        if (parts.length !== 2) return null;
        const lat = parseFloat(parts[0]);
        const lng = parseFloat(parts[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng };
    }
    
    async searchLocation() {
        const query = document.getElementById('locationSearch').value.trim();
        if (!query) {
            alert('Please enter a location to search');
            return;
        }
        
        this.updateStatus('Searching for location...');
        
        try {
            const manual = this.parseLatLng(query);
            if (manual) {
                this.setUserLocation(manual.lat, manual.lng, `${manual.lat.toFixed(4)}, ${manual.lng.toFixed(4)}`);
                return;
            }

            await this.ensureGeocoder();

            if (this.geocoderReady) {
                const result = this.geocoder.first(query);
                if (result) {
                    this.setUserLocation(result.lat, result.lng, result.display || result.name);
                    return;
                }
            }

            this.updateStatus('Location not found in offline gazetteer. Enter lat,lng or click the map.');
            alert('Location not found offline. Enter lat,lng (e.g., 43.7,-79.4) or click on the map.');
        } catch (error) {
            console.error('Geocoding error:', error);
            this.updateStatus('Error searching offline gazetteer.');
            alert('Error searching offline gazetteer. Enter lat,lng or click on the map.');
        }
    }
    
    getCurrentLocation() {
        this.updateStatus('Getting your current location...');
        
        // Check if we're running in Electron
        if (window.electronAPI && window.electronAPI.isElectron) {
            // Use Electron's custom geolocation API
            window.electronAPI.getCurrentPosition()
                .then((position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    this.setUserLocation(lat, lng, 'Your Current Location');
                })
                .catch((error) => {
                    console.error('Geolocation error:', error);
                    const message = 'Unable to get your location. ' + (error.message || 'Unknown error occurred.');
                    this.updateStatus(message);
                    alert(message);
                });
        } else {
            // Use browser's geolocation API
            if (!navigator.geolocation) {
                alert('Geolocation is not supported by this browser');
                return;
            }
            
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    this.setUserLocation(lat, lng, 'Your Current Location');
                },
                (error) => {
                    console.error('Geolocation error:', error);
                    let message = 'Unable to get your location. ';
                    switch (error.code) {
                        case error.PERMISSION_DENIED:
                            message += 'Location access denied by user.';
                            break;
                        case error.POSITION_UNAVAILABLE:
                            message += 'Location information unavailable.';
                            break;
                        case error.TIMEOUT:
                            message += 'Location request timed out.';
                            break;
                        default:
                            message += 'Unknown error occurred.';
                            break;
                    }
                    this.updateStatus(message);
                    alert(message);
                },
                {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 300000 // 5 minutes
                }
            );
        }
    }
    
    setUserLocation(lat, lng, locationName) {
        this.userLocation = { lat, lng, name: locationName };

        // Enable radius selection only after a search center has been chosen.
        const radiusFilter = document.getElementById('radiusFilter');
        if (radiusFilter) radiusFilter.disabled = false;
        
        // Center map on user location
        try {
            this.map.easeTo({ center: [lng, lat], zoom: Math.max(3, Math.min(10, this.map.getZoom() || 6)) });
        } catch (_) { /* ignore */ }

        // Add/replace user location marker (DOM marker)
        try {
            if (this._userMarker) this._userMarker.remove();
        } catch (_) { /* ignore */ }

        const el = document.createElement('div');
        el.innerHTML = `<div style="width:14px;height:14px;border-radius:999px;background:#e74c3c;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.35);"></div>`;
        this._userMarker = new globalThis.maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([lng, lat])
            .addTo(this.map);
        
        // Update repeaters for this location
        this.updateRepeaters();
        
        this.updateStatus(`Found location: ${locationName}`);
    }
    
    updateRepeaters() {
        // If the user hasn't selected a location yet, we show ALL repeaters by default
        // (filtered only by band/mode). Once a location is set, we switch to radius mode.
        if (!this.userLocation) {
            this.showAllRepeaters();
            return;
        }
        
        // Clear existing markers list (MapLibre uses a single geojson source)
        this.repeaterMarkers = [];

        // Prefer the merged dataset (ARD + legacy supplement) when available.
        const dataset = Array.isArray(window.repeaterData)
            ? window.repeaterData
            : (typeof repeaterData !== 'undefined' ? repeaterData : []);
        
        // Get repeaters in radius
        let repeaters = getRepeatersInRadius(
            this.userLocation.lat,
            this.userLocation.lng,
            this.currentRadius,
            dataset
        );
        
        // Apply filters
        const bandFilter = document.getElementById('bandFilter').value;
        const modeFilter = document.getElementById('modeFilter').value;

        repeaters = filterByBand(repeaters, bandFilter);
        repeaters = filterByMode(repeaters, modeFilter);
        
        // Sort by distance and annotate with bearing from user to repeater
        repeaters = repeaters.map(repeater => {
            const distance = calculateDistance(
                this.userLocation.lat,
                this.userLocation.lng,
                repeater.lat,
                repeater.lng
            );
            const bearingDeg = this.calculateBearingDeg(
                this.userLocation.lat,
                this.userLocation.lng,
                repeater.lat,
                repeater.lng
            );
            const bearingLabel = this.formatBearing(bearingDeg);
            return { ...repeater, distance, bearingDeg, bearingLabel };
        }).sort((a, b) => a.distance - b.distance);
        
        // Render repeaters to MapLibre
        this.renderRepeatersOnMap(repeaters);
        
        // Update sidebar
        this.updateRepeaterList(repeaters);
        
        // Update status
        this.updateStatus(`Found ${repeaters.length} repeaters within ${this.currentRadius} km`);
    }

    showAllRepeaters() {
        // Clear existing markers list (MapLibre uses a single geojson source)
        this.repeaterMarkers = [];

        // Disable radius selection until the user sets a center
        const radiusFilter = document.getElementById('radiusFilter');
        if (radiusFilter) radiusFilter.disabled = true;

        // Base set: everything
        let repeaters = Array.isArray(window.repeaterData) ? window.repeaterData : (typeof repeaterData !== 'undefined' ? repeaterData : []);

        // Apply filters that don't require a location
        const bandFilter = document.getElementById('bandFilter').value;
        const modeFilter = document.getElementById('modeFilter').value;

        repeaters = filterByBand(repeaters, bandFilter);
        repeaters = filterByMode(repeaters, modeFilter);

        // Stable-ish sort (location/state/callsign) since we don't have distance
        repeaters = repeaters.slice().sort((a, b) => {
            const ak = `${a.country || ''}|${a.state || ''}|${a.location || ''}|${a.callsign || ''}|${a.frequency || ''}`;
            const bk = `${b.country || ''}|${b.state || ''}|${b.location || ''}|${b.callsign || ''}|${b.frequency || ''}`;
            return ak.localeCompare(bk);
        });

        this.renderRepeatersOnMap(repeaters);
        this.updateRepeaterList(repeaters);
        this.updateStatus(`Showing all repeaters (${repeaters.length}) - set a location to filter by radius`);
    }

    renderRepeatersOnMap(repeaters) {
        if (!this.map || !this._repeaterSourceId) return;
        const src = this.map.getSource(this._repeaterSourceId);
        if (!src) {
            // map may not have finished loading yet; try again shortly
            setTimeout(() => this.renderRepeatersOnMap(repeaters), 150);
            return;
        }

        // Keep an index so map clicks and list clicks can resolve to a full record
        // without embedding the entire record into each GeoJSON feature.
        this._repeaterById = new Map();

        const features = (repeaters || []).map(r => {
            const id = String(r.id);
            this._repeaterById.set(id, r);
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
                properties: {
                    id,
                    callsign: r.callsign || '',
                    frequency: r.frequency || '',
                }
            };
        });

        src.setData({ type: 'FeatureCollection', features });
    }
    
    updateRepeaterList(repeaters) {
        const listContainer = document.getElementById('repeaterList');
        const countElement = document.getElementById('resultCount');
        
        const total = repeaters.length;
        countElement.textContent = total;
        
        if (total === 0) {
            listContainer.innerHTML = '<p>No repeaters found in the selected area with current filters.</p>';
            return;
        }

        const MAX_LIST_ITEMS = 500;
        const display = total > MAX_LIST_ITEMS ? repeaters.slice(0, MAX_LIST_ITEMS) : repeaters;
        const note = total > MAX_LIST_ITEMS
            ? `<div class="repeater-list-note">Showing first ${display.length} of ${total}. Set a location or reduce radius/filters to narrow results.</div>`
            : '';

        listContainer.innerHTML = note + display.map(repeater => {
            const hasDistance = Number.isFinite(repeater.distance);
            const distanceLabel = hasDistance
                ? ` (${repeater.distance.toFixed(1)} km${repeater.bearingLabel ? ' @ ' + repeater.bearingLabel : ''})`
                : '';
            return `
                <div class="repeater-item" data-id="${repeater.id}">
                    <div class="repeater-frequency">${repeater.frequency} MHz</div>
                    <div class="repeater-callsign">${repeater.callsign}</div>
                    <div class="repeater-location">${repeater.location}, ${repeater.state}${distanceLabel}</div>
                    <div class="repeater-details">
                        <span class="repeater-tone">Tone: ${repeater.tone}</span>
                        <span class="repeater-mode">${repeater.mode}</span>
                        <br>Offset: ${repeater.offset} | Band: ${repeater.band}
                    </div>
                </div>
            `;
        }).join('');
    }
    
    selectRepeater(repeater) {
        this.selectedRepeater = repeater;
        
        // Update info panel
        const infoPanel = document.getElementById('repeaterInfo');
        infoPanel.innerHTML = `
            <div class="repeater-frequency">${repeater.frequency} MHz</div>
            <div class="repeater-callsign">${repeater.callsign}</div>
            <div class="repeater-location">${repeater.location}, ${repeater.state}, ${repeater.country}</div>
            <div class="repeater-details">
                <p><strong>Offset:</strong> ${repeater.offset}</p>
                <p><strong>Tone:</strong> ${repeater.tone}</p>
                <p><strong>Mode:</strong> ${repeater.mode}</p>
                <p><strong>Band:</strong> ${repeater.band}</p>
                ${Number.isFinite(repeater.distance)
                    ? `<p><strong>Distance:</strong> ${repeater.distance.toFixed(1)} km${repeater.bearingLabel ? ' @ ' + repeater.bearingLabel : ''}</p>`
                    : ''}
                ${repeater.notes ? `<p><strong>Notes:</strong> ${repeater.notes}</p>` : ''}
            </div>
        `;
        
        // Highlight selected item in list
        document.querySelectorAll('.repeater-item').forEach(item => {
            item.classList.remove('selected');
        });
        const selectedItem = document.querySelector(`[data-id="${repeater.id}"]`);
        if (selectedItem) {
            selectedItem.classList.add('selected');
        }
    }
    
    // NOTE: Leaflet clustering removed; MapLibre uses a GeoJSON source.

    updateMapCursor(active) {
        if (!this.mapContainer) return;
        if (active) {
            this.mapContainer.classList.add('map-pick-mode');
        } else {
            this.mapContainer.classList.remove('map-pick-mode');
        }
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
    
    updateStatus(message) {
        document.getElementById('statusText').textContent = message;
    }
}

// The module will be initialized by main.js after loading
