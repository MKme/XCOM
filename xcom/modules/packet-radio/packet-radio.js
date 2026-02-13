/**
 * Packet Radio Module
 * - Offline map of packet nodes + BBS
 * - Common frequencies reference
 * - Help/config section including import/export and local-only storage
 */

class PacketRadioModule {
  constructor() {
    this.map = null;
    this.mapContainer = null;
    this.userLocation = null;
    this.userMarker = null; // legacy name kept; now MapLibre Marker
    this.markers = []; // legacy list kept; now MapLibre Markers
    this.selectedItem = null;

    // MapLibre state
    this._nodesSourceId = null;
    this._nodesLayerId = null;

    // Filter radius in km.
    // NOTE: Packet / HF paths can be thousands of miles, so the UI supports large values.
    // Use Infinity for "Any".
    this.currentRadius = 100;
    this.typeFilter = 'all';
    this.bandFilter = 'all';
    this.searchText = '';

    this.geocoder = window.offlineGeocoder || null;
    this.geocoderReady = false;

    this.storageKey = 'packetRadio.customNodes.v1';
    this.customNodes = [];

    // Render scheduling
    this._pendingRenderTimer = null;
    this._mapLoaded = false;

    this.init();
  }

  static get MAX_RADIUS_KM() { return 20000; } // ~half the Earth's circumference

  init() {
    this.createModuleStructure();
    this.mapContainer = document.getElementById('packetMap');

    this.loadCustomNodes();
    this.initMap();
    this.ensureGeocoder();
    this.bindEvents();

    this.renderFrequencies();
    // NOTE: updateResults() is safe to call before the map is ready, but map layers/sources
    // are only created on MapLibre's 'load' event. We will also refresh results once the
    // map is fully loaded so markers reliably appear on first entry.
    this.updateResults();

    window.radioApp.updateStatus('Packet Stations module loaded');
  }

  createModuleStructure() {
    const moduleContainer = document.getElementById('packet-radio');
    moduleContainer.innerHTML = `
      <div class="packet-radio-container">
        <div class="xModuleIntro">
          <div class="xModuleIntroTitle">What you can do here</div>
          <div class="xModuleIntroText">
            Find packet radio nodes (routing stations) and BBS (bulletin board system) stations, which store-and-forward messages and bulletins via linked networks worldwide, on a map, filter by distance, and keep a personal local list.
          </div>
        </div>
        <div class="controls">
          <div class="search-container">
            <input type="text" id="packetLocationSearch" placeholder="Enter location or lat,lng">
            <button id="packetSearchBtn">Search</button>
            <button id="packetCurrentLocationBtn">Current Location</button>
            <button id="packetPickOnMapBtn" type="button">Pick on map</button>
          </div>

          <div class="filter-controls">
            <div class="filter-group">
              <label for="packetTypeFilter">Type:</label>
              <select id="packetTypeFilter">
                <option value="all" selected>All</option>
                <option value="node">Nodes</option>
                <option value="bbs">BBS</option>
              </select>
            </div>

            <div class="filter-group">
              <label for="packetRadiusFilter">Radius:</label>
              <select id="packetRadiusFilter">
                <option value="25">25 km</option>
                <option value="50">50 km</option>
                <option value="100" selected>100 km</option>
                <option value="200">200 km</option>
                <option value="500">500 km</option>
                <option value="1000">1000 km</option>
                <option value="2000">2000 km</option>
                <option value="5000">5000 km</option>
                <option value="10000">10000 km</option>
                <option value="20000">20000 km</option>
                <option value="any">Any distance</option>
              </select>
            </div>

            <div class="filter-group">
              <label for="packetTextFilter">Filter:</label>
              <input id="packetTextFilter" type="text" placeholder="callsign, location..." />
            </div>
          </div>
        </div>

        <div id="packetMap"></div>

        <div class="sidebar">
          <div class="info-panel">
            <h3>Node / BBS</h3>
            <div id="packetInfo">
              <p>Click a marker or list item to view details.</p>
            </div>
          </div>

          <div class="results-panel">
            <h3>Results (<span id="packetResultCount">0</span>)</h3>
            <div id="packetList"></div>
          </div>
        </div>

        <div class="bottom-panels">
          <div class="panel">
            <h3>Common Packet Frequencies</h3>
            <div class="small-muted">Always verify your local band plan before transmitting.</div>
            <div class="table-wrap">
              <table class="packet-table" id="packetFreqTable">
                <thead>
                  <tr>
                    <th>Band</th>
                    <th>Usage</th>
                    <th>Freq (MHz)</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>
          </div>

          <div class="panel">
            <h3>Help & Config</h3>
            <details open>
              <summary>How to find nodes</summary>
              <div class="help-text">
                <p>
                  Packet nodes and BBS are highly regional, and the most reliable way to discover what’s active is to
                  (1) listen, (2) ask local operators, and (3) connect and request node lists.
                </p>
                <p>
                  A great primer is here:
                  <a href="https://packetcommander.com/docs/finding-nodes" target="_blank" rel="noopener">packetcommander.com/docs/finding-nodes</a>
                </p>
                <ul>
                  <li><strong>Listen first:</strong> monitor common packet channels (e.g. 145.010) and APRS.</li>
                  <li><strong>Connect to a known node:</strong> use your TNC + terminal and try common connect strings.</li>
                  <li><strong>Ask the node:</strong> commands vary by software (JNOS, BPQ, etc.). Many provide a routes/nodes list.</li>
                  <li><strong>Build your local list:</strong> keep a curated list of nodes/BBS that are confirmed on-air.</li>
                </ul>

                <div class="packet-help-block">
                  <h4 class="packet-help-title">AX.25 Terminal / Node quick commands (cheat sheet)</h4>
                  <p class="small-muted">
                    Commands vary by node/BBS software (BPQ, JNOS, FBB, etc.).
                    This is a <strong>generic</strong> quick reference; always try <code>?</code> or <code>HELP</code> on the system you’re connected to.
                  </p>

                  <div class="table-wrap">
                    <table class="packet-table">
                      <thead>
                        <tr>
                          <th>What you want</th>
                          <th>Common command(s)</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>Help / menu</td>
                          <td><code>?</code>, <code>HELP</code>, <code>H</code></td>
                          <td>Some systems have layered help: <code>??</code> / <code>HELP COMMANDS</code>.</td>
                        </tr>
                        <tr>
                          <td>Show heard stations</td>
                          <td><code>MHEARD</code>, <code>MH</code></td>
                          <td>Useful for checking local activity and last-heard times.</td>
                        </tr>
                        <tr>
                          <td>List nodes / routes</td>
                          <td><code>NODES</code>, <code>ROUTES</code></td>
                          <td>Many BPQ nodes support <code>NODES</code>; JNOS often supports routes + neighbors lists.</td>
                        </tr>
                        <tr>
                          <td>List users currently connected</td>
                          <td><code>USERS</code></td>
                          <td>Not available everywhere; sometimes <code>WHO</code>.</td>
                        </tr>
                        <tr>
                          <td>See available ports</td>
                          <td><code>PORTS</code>, <code>P</code></td>
                          <td>Shows RF/TNC ports vs internet/AXIP ports (varies by node).</td>
                        </tr>
                        <tr>
                          <td>Connect to a node/BBS</td>
                          <td><code>C &lt;CALL&gt;</code>, <code>CONNECT &lt;CALL&gt;</code></td>
                          <td>
                            Examples: <code>C VE3ABC-7</code>, <code>CONNECT N0CALL-1</code>.
                            Some nodes accept <code>C &lt;CALL&gt; VIA &lt;DIGI&gt;</code>.
                          </td>
                        </tr>
                        <tr>
                          <td>Disconnect / return</td>
                          <td><code>B</code>, <code>BYE</code>, <code>D</code>, <code>DISCONNECT</code></td>
                          <td>Exact command differs; sometimes <code>QUIT</code>.</td>
                        </tr>
                        <tr>
                          <td>Show your QTH / location</td>
                          <td><code>QTH</code></td>
                          <td>
                            Some systems support <code>QTH</code> (or a similar command) and may show the node’s location.
                            If not, try <code>INFO</code> or the node’s welcome banner.
                          </td>
                        </tr>
                        <tr>
                          <td>Show node info</td>
                          <td><code>INFO</code></td>
                          <td>Often prints sysop info, frequencies, and local policies.</td>
                        </tr>
                        <tr>
                          <td>Read/send mail (BBS)</td>
                          <td><code>R</code>/<code>READ</code>, <code>S</code>/<code>SEND</code>, <code>L</code>/<code>LIST</code></td>
                          <td>
                            BBS command sets differ a lot (FBB vs JNOS vs BPQ Mail).
                            Use <code>?</code> on the BBS prompt.
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div class="packet-help-subblock">
                    <h5 class="packet-help-subtitle">Setting your “home BBS” (forward mail through)</h5>
                    <p>
                      “Home BBS” usually means the BBS you use for message handling/forwarding (your primary mailbox).
                      The <strong>exact</strong> way to set it depends on your terminal/TNC software:
                    </p>
                    <ul>
                      <li><strong>In your terminal app:</strong> look for settings like <em>Home BBS</em>, <em>Mailbox</em>, <em>Forward BBS</em>, or <em>BBS callsign/SSID</em>.</li>
                      <li><strong>In node/BBS software:</strong> forwarding is usually configured by the sysop, but some systems let users set a preferred BBS in their personal settings.</li>
                      <li><strong>Practical tip:</strong> pick a nearby, reliable BBS with good uptime and ask the sysop what they recommend for new users.</li>
                    </ul>
                    <p class="small-muted">
                      If you tell me what terminal app you’re using (e.g., LinPac, Outpost, BPQ32 terminal, Dire Wolf + a client, etc.),
                      I can add exact menu paths/commands for that specific software.
                    </p>
                  </div>
                </div>
              </div>
            </details>

            <details>
              <summary>Local node list (offline) – import/export</summary>
              <div class="help-text">
                <p>
                  This module stores your custom nodes locally (in your browser/Electron profile). It never uploads.
                </p>
                <div class="button-row">
                  <button id="packetExportBtn" type="button">Export JSON</button>
                  <button id="packetImportBtn" type="button">Import JSON</button>
                  <button id="packetClearCustomBtn" type="button" class="danger">Clear Custom</button>
                </div>
                <input type="file" id="packetImportFile" accept="application/json" style="display:none" />

                <p class="small-muted">JSON format: an array of items like {type, callsign, name, location, lat, lng, freq, baud, notes}</p>
              </div>
            </details>
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

    const c = globalThis.getMapDefaultCoords ? globalThis.getMapDefaultCoords() : { lat: 39.8283, lon: -98.5795 };
    const z = globalThis.getMapDefaultZoom ? globalThis.getMapDefaultZoom() : 3;

    const useHelper = typeof globalThis.createMapLibreMap === 'function'

    this.map = useHelper
      ? globalThis.createMapLibreMap({
          container: 'packetMap',
          centerLon: c.lon,
          centerLat: c.lat,
          zoom: z,
        })
      : new globalThis.maplibregl.Map({
          container: 'packetMap',
          style: globalThis.buildMapLibreStyle ? globalThis.buildMapLibreStyle() : 'https://tiles.openfreemap.org/styles/liberty',
          center: [c.lon, c.lat],
          zoom: z,
        });

    if (!useHelper) {
      try {
        this.map.addControl(new globalThis.maplibregl.NavigationControl(), 'top-right');
      } catch (_) { /* ignore */ }
    }

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

    this._nodesSourceId = `packet-nodes-${Date.now()}`;
    this._nodesLayerId = `packet-nodes-circle-${Date.now()}`;

    this.map.on('load', () => {
      this._mapLoaded = true;
      this.map.addSource(this._nodesSourceId, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      this.map.addLayer({
        id: this._nodesLayerId,
        type: 'circle',
        source: this._nodesSourceId,
        paint: {
          'circle-radius': 7,
          'circle-color': ['match', ['get', 'type'], 'bbs', '#8e44ad', 'node', '#2ecc71', '#94a3b8'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        }
      });

      this.map.on('click', this._nodesLayerId, (e) => {
        const f = e && e.features && e.features[0];
        if (!f) return;
        const item = f.properties && f.properties._raw ? JSON.parse(f.properties._raw) : null;
        if (!item) return;
        this.selectItem(item);
      });

      this.map.on('mouseenter', this._nodesLayerId, () => {
        try { this.map.getCanvas().style.cursor = 'pointer'; } catch (_) {}
      });
      this.map.on('mouseleave', this._nodesLayerId, () => {
        try { this.map.getCanvas().style.cursor = this.mapClickMode ? 'crosshair' : ''; } catch (_) {}
      });

      // Ensure markers are rendered on first load (fixes "empty map until user changes a filter")
      try { this.updateResults(); } catch (_) { /* ignore */ }
    });
  }

  scheduleUpdateResults(delayMs = 75) {
    try {
      if (this._pendingRenderTimer) clearTimeout(this._pendingRenderTimer);
    } catch (_) { /* ignore */ }
    this._pendingRenderTimer = setTimeout(() => {
      this._pendingRenderTimer = null;
      try { this.updateResults(); } catch (_) { /* ignore */ }
    }, delayMs);
  }

  bindEvents() {
    const searchBtn = document.getElementById('packetSearchBtn');
    const gpsBtn = document.getElementById('packetCurrentLocationBtn');
    const pickBtn = document.getElementById('packetPickOnMapBtn');
    const typeFilter = document.getElementById('packetTypeFilter');
    const radiusFilter = document.getElementById('packetRadiusFilter');
    const textFilter = document.getElementById('packetTextFilter');
    const locationInput = document.getElementById('packetLocationSearch');

    this.mapClickMode = false;

    searchBtn.addEventListener('click', () => this.searchLocation());
    gpsBtn.addEventListener('click', () => this.getCurrentLocation());
    pickBtn.addEventListener('click', () => {
      this.mapClickMode = true;
      this.updateStatus('Click on the map to set your search center.');
      this.updateMapCursor(true);
    });

    locationInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.searchLocation();
    });

    typeFilter.addEventListener('change', () => {
      this.typeFilter = typeFilter.value;
      this.updateResults();
    });
    radiusFilter.addEventListener('change', () => {
      const raw = (radiusFilter.value || '').trim().toLowerCase();
      const parsed = raw === 'any' ? Infinity : parseInt(raw, 10);
      const capped = Number.isFinite(parsed)
        ? Math.max(1, Math.min(PacketRadioModule.MAX_RADIUS_KM, parsed))
        : Infinity;
      this.currentRadius = capped;
      this.updateResults();
    });
    textFilter.addEventListener('input', () => {
      this.searchText = (textFilter.value || '').trim().toLowerCase();
      this.updateResults();
    });

    if (this.map) {
      this.map.on('click', (e) => {
        const { lat, lng } = e.lngLat;
        this.setUserLocation(lat, lng, `Custom location (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
        if (this.mapClickMode) {
          this.mapClickMode = false;
          this.updateMapCursor(false);
        }
      });
    }

    // Import/export buttons
    document.getElementById('packetExportBtn').addEventListener('click', () => this.exportCustomNodes());
    document.getElementById('packetImportBtn').addEventListener('click', () => document.getElementById('packetImportFile').click());
    document.getElementById('packetImportFile').addEventListener('change', (e) => this.importCustomNodesFromFile(e));
    document.getElementById('packetClearCustomBtn').addEventListener('click', () => this.clearCustomNodes());
  }

  updateStatus(message) {
    const el = document.getElementById('statusText');
    if (el) el.textContent = message;
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
    const query = (document.getElementById('packetLocationSearch').value || '').trim();
    if (!query) {
      alert('Please enter a location to search');
      return;
    }

    this.updateStatus('Searching for location...');

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
  }

  getCurrentLocation() {
    this.updateStatus('Getting your current location...');

    if (window.electronAPI && window.electronAPI.isElectron) {
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
      return;
    }

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
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
    );
  }

  setUserLocation(lat, lng, locationName) {
    this.userLocation = { lat, lng, name: locationName };

    try {
      this.map.easeTo({ center: [lng, lat], zoom: Math.max(3, Math.min(10, this.map.getZoom() || 6)) });
    } catch (_) { /* ignore */ }

    try {
      if (this.userMarker) this.userMarker.remove();
    } catch (_) { /* ignore */ }

    const el = document.createElement('div');
    el.innerHTML = `<div style="width:14px;height:14px;border-radius:999px;background:#e74c3c;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.35);"></div>`;
    this.userMarker = new globalThis.maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([lng, lat])
      .addTo(this.map);

    this.updateResults();
    this.updateStatus(`Found location: ${locationName}`);
  }

  // Fallback distance in case repeater-map helpers are not loaded yet.
  calculateDistanceKm(lat1, lng1, lat2, lng2) {
    if (typeof calculateDistance === 'function') {
      // existing helper returns km
      return calculateDistance(lat1, lng1, lat2, lng2);
    }
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  getAllNodes() {
    const base = (typeof packetNodeData !== 'undefined' && Array.isArray(packetNodeData)) ? packetNodeData : [];
    const custom = Array.isArray(this.customNodes) ? this.customNodes : [];
    return [...base, ...custom].map(normalizePacketItem);
  }

  filterNodes(nodes) {
    let out = nodes;

    if (this.typeFilter !== 'all') {
      out = out.filter(n => n.type === this.typeFilter);
    }

    if (this.searchText) {
      const q = this.searchText;
      out = out.filter(n => {
        const chanText = Array.isArray(n.channels)
          ? n.channels.map(c => `${(c && c.freq) || ''} ${(c && c.baud) || ''}`).join(' ')
          : '';
        const hay = `${n.callsign || ''} ${n.name || ''} ${n.location || ''} ${n.freq || ''} ${chanText} ${n.notes || ''}`.toLowerCase();
        return hay.includes(q);
      });
    }

    if (this.userLocation) {
      out = out.map(n => {
        const distanceKm = this.calculateDistanceKm(this.userLocation.lat, this.userLocation.lng, n.lat, n.lng);
        return { ...n, distanceKm };
      }).filter(n => n.distanceKm <= this.currentRadius)
        .sort((a, b) => (a.distanceKm || 0) - (b.distanceKm || 0));
    } else {
      out = out.slice().sort((a, b) => (a.callsign || '').localeCompare(b.callsign || ''));
    }

    return out;
  }

  updateResults() {
    const nodes = this.filterNodes(this.getAllNodes());
    this.renderMarkers(nodes);
    this.renderList(nodes);
    const radiusLabel = this.userLocation
      ? (Number.isFinite(this.currentRadius) ? ` within ${this.currentRadius} km` : ' (any distance)')
      : '';
    this.updateStatus(`Showing ${nodes.length} entries${radiusLabel}`);
  }

  clearMarkers() {
    // MapLibre Markers
    (this.markers || []).forEach(m => {
      try { m.remove(); } catch (_) { /* ignore */ }
    });
    this.markers = [];

    // GeoJSON source
    if (this.map && this._nodesSourceId) {
      const src = this.map.getSource(this._nodesSourceId);
      if (src) {
        try { src.setData({ type: 'FeatureCollection', features: [] }); } catch (_) { /* ignore */ }
      }
    }
  }

  renderMarkers(nodes) {
    if (!this.map) return;
    this.clearMarkers();

    const formatChannelsSummary = (item) => {
      const chans = Array.isArray(item.channels) ? item.channels : [];
      const pretty = chans
        .filter(c => c && (c.freq || c.baud))
        .map(c => {
          const f = c.freq ? `${c.freq} MHz` : '— MHz';
          const b = c.baud ? `${c.baud} baud` : '— baud';
          return `${f} @ ${b}`;
        });

      if (pretty.length === 0) {
        // fallback to legacy fields
        const f = item.freq ? `${item.freq} MHz` : '— MHz';
        const b = item.baud ? `${item.baud} baud` : '— baud';
        return { oneLine: `${f} @ ${b}`, lines: [`${f} @ ${b}`] };
      }

      return {
        oneLine: pretty[0] + (pretty.length > 1 ? ` (+${pretty.length - 1} more)` : ''),
        lines: pretty,
      };
    };

    // Render as a GeoJSON layer for performance.
    // IMPORTANT: The source is only created after the map 'load' event.
    // If updateResults() runs before that (very common on first module entry),
    // we queue a retry.
    if (this._nodesSourceId) {
      const src = this.map.getSource(this._nodesSourceId);
      if (!src) {
        // map not ready yet; retry shortly
        this.scheduleUpdateResults(120);
      } else {
        const features = (nodes || []).map(item => {
          const raw = JSON.stringify(item);
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [item.lng, item.lat] },
            properties: {
              id: item.id,
              type: item.type,
              callsign: item.callsign,
              _raw: raw,
            }
          };
        });
        try {
          src.setData({ type: 'FeatureCollection', features });
        } catch (_) {
          // If MapLibre is mid-style reload, setData can throw.
          this.scheduleUpdateResults(200);
        }
      }
    }

    // If we have a user location and some results, fit view a bit nicer.
    if (this.userLocation && nodes.length > 0) {
      try {
        const b = new globalThis.maplibregl.LngLatBounds();
        b.extend([this.userLocation.lng, this.userLocation.lat]);
        nodes.forEach(n => b.extend([n.lng, n.lat]));
        this.map.fitBounds(b, { padding: 24, maxZoom: 7 });
      } catch (_) { /* ignore */ }
    }
  }

  renderList(nodes) {
    const listEl = document.getElementById('packetList');
    const countEl = document.getElementById('packetResultCount');
    if (!listEl || !countEl) return;
    countEl.textContent = `${nodes.length}`;

    if (nodes.length === 0) {
      listEl.innerHTML = '<p>No entries match your filters. Try increasing radius or clearing the text filter.</p>';
      return;
    }

    const primaryChannelLabel = (n) => {
      const chans = Array.isArray(n.channels) ? n.channels : [];
      const best = chans.find(c => c && c.freq) || null;
      if (best && best.freq) {
        return `${best.freq} MHz` + (chans.length > 1 ? ` (+${chans.length - 1})` : '');
      }
      return `${n.freq || '—'} MHz`;
    };

    listEl.innerHTML = nodes.map(n => {
      const distance = Number.isFinite(n.distanceKm) ? `${n.distanceKm.toFixed(1)} km` : '';
      return `
        <div class="packet-item" data-id="${n.id}">
          <div class="packet-item-top">
            <span class="badge ${n.type}">${n.type.toUpperCase()}</span>
            <span class="callsign">${n.callsign || ''}</span>
            <span class="freq">${primaryChannelLabel(n)}</span>
          </div>
          <div class="packet-item-sub">
            <span class="name">${n.name || ''}</span>
            <span class="loc">${n.location || ''}</span>
            <span class="dist">${distance}</span>
          </div>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.packet-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id, 10);
        const item = nodes.find(n => n.id === id);
        if (item) {
          this.selectItem(item);
          try {
            this.map.easeTo({ center: [item.lng, item.lat], zoom: Math.max(this.map.getZoom() || 6, 6) });
          } catch (_) { /* ignore */ }
        }
      });
    });
  }

  selectItem(item) {
    this.selectedItem = item;
    const infoEl = document.getElementById('packetInfo');
    if (!infoEl) return;

    const chans = Array.isArray(item.channels) ? item.channels : [];
    const chanLines = chans
      .filter(c => c && (c.freq || c.baud))
      .map(c => {
        const f = c.freq ? `${c.freq} MHz` : '— MHz';
        const b = c.baud ? `${c.baud} baud` : '— baud';
        return `${f} @ ${b}`;
      });

    const chanBlock = chanLines.length > 0
      ? `<div class="detail-row"><strong>Channels:</strong><br>${chanLines.map(l => `• ${l}`).join('<br>')}</div>`
      : '';

    infoEl.innerHTML = `
      <div class="detail-title">${item.type === 'bbs' ? 'BBS' : 'Node'}: ${item.callsign || ''}</div>
      <div class="detail-sub">${item.name || ''}</div>
      <div class="detail-row"><strong>Location:</strong> ${item.location || ''}</div>
      <div class="detail-row"><strong>Coordinates:</strong> ${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}</div>
      <div class="detail-row"><strong>Primary:</strong> ${(item.freq || '—')} MHz @ ${(item.baud || '—')} baud</div>
      ${chanBlock}
      <div class="detail-row"><strong>Mode:</strong> ${item.mode || '—'}</div>
      ${Number.isFinite(item.distanceKm) ? `<div class="detail-row"><strong>Distance:</strong> ${item.distanceKm.toFixed(1)} km</div>` : ''}
      ${item.notes ? `<div class="detail-row"><strong>Notes:</strong> ${item.notes}</div>` : ''}
    `;

    // highlight selection
    document.querySelectorAll('.packet-item').forEach(el => el.classList.remove('selected'));
    const selectedEl = document.querySelector(`.packet-item[data-id="${item.id}"]`);
    if (selectedEl) selectedEl.classList.add('selected');
  }

  renderFrequencies() {
    const tableBody = document.querySelector('#packetFreqTable tbody');
    if (!tableBody) return;

    const freqs = (typeof packetCommonFrequencies !== 'undefined' && Array.isArray(packetCommonFrequencies))
      ? packetCommonFrequencies
      : [];

    tableBody.innerHTML = freqs.map(row => `
      <tr>
        <td>${row.band || ''}</td>
        <td>${row.usage || ''}</td>
        <td><code>${row.freq || ''}</code></td>
        <td>${row.notes || ''}</td>
      </tr>
    `).join('');
  }

  updateMapCursor(active) {
    if (!this.mapContainer) return;
    if (active) this.mapContainer.classList.add('map-pick-mode');
    else this.mapContainer.classList.remove('map-pick-mode');
  }

  // -----------------
  // Local storage
  // -----------------
  loadCustomNodes() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        this.customNodes = [];
        return;
      }
      const parsed = JSON.parse(raw);
      this.customNodes = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('Failed to load custom packet nodes', e);
      this.customNodes = [];
    }
  }

  saveCustomNodes() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.customNodes || []));
    } catch (e) {
      console.warn('Failed to save custom packet nodes', e);
      alert('Failed to save custom nodes (storage unavailable).');
    }
  }

  exportCustomNodes() {
    const data = JSON.stringify(this.customNodes || [], null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'packet-radio-nodes.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async importCustomNodesFromFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array');

      const normalized = parsed.map(normalizePacketItem);
      const invalid = normalized.map(validatePacketItem).find(r => !r.ok);
      if (invalid) throw new Error(invalid.error);

      // Replace custom list entirely.
      this.customNodes = normalized;
      this.saveCustomNodes();
      this.updateResults();
      alert(`Imported ${normalized.length} custom entries.`);
    } catch (err) {
      console.error(err);
      alert(`Import failed: ${err.message}`);
    } finally {
      // allow re-importing same file
      e.target.value = '';
    }
  }

  clearCustomNodes() {
    if (!confirm('Clear all custom Packet Radio entries?')) return;
    this.customNodes = [];
    this.saveCustomNodes();
    this.updateResults();
  }
}

// The module will be initialized by app-main.js after loading
