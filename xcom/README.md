## XCOM

XCOM is a **local-first, offline-capable Progressive Web App (PWA)** for radio reference + mapping.

### Mapping architecture (MapLibre + XTOC-style offline tiles)

XCOM now uses **MapLibre GL JS** everywhere (no Leaflet in the main app).

Key points:

- **AO (Area of Operations) selection happens in the Map module** (`#map`).
  - Pan/zoom to your AO.
  - AO bounds are derived from center+zoom (see `modules/shared/xtoc/ao.js`).
- **Offline raster tiles are downloaded into browser Cache Storage** under cache name:
  - `xtoc.tiles.v1`
  - Download logic: `modules/shared/xtoc/offlineTiles.js` (`cacheTilesForBounds`).
- **Offline tile serving is done by the Service Worker**:
  - `sw.js` intercepts cross-origin tile requests and serves cache-first from `xtoc.tiles.v1`.
- All map modules share the same:
  - view state (`getMapDefaultCoords/getMapDefaultZoom` in `modules/shared/xtoc/settings.js`)
  - style builder (`buildMapLibreStyle` in `modules/shared/xtoc/maplibre.js`).

#### Offline workflow

1. Open the **Map** module.
2. Set base to **Offline Raster** (or Offline Raster Dark) and choose a tile template.
3. Pan/zoom to the desired AO.
4. Click **Download tiles (this AO)**.
5. Confirm the **Tile cache status** increases (cached request count).
6. Go offline and maps will continue to load tiles from the Service Worker cache.

> Note: Public tile servers have usage policies. For serious/off-grid use, point the raster template at your own tile server.

---

# Quick start (dev + build)

All commands below are run from:

```powershell
cd c:\GitHub\XCOM\xcom
```

### 1) Install dependencies

```powershell
npm install
```

### 2) Run locally (dev)

Starts a tiny static server at **http://127.0.0.1:5174**.

```powershell
npm run dev
```

### 3) Build a release bundle

Creates a versioned, self-contained static bundle under `releases/`.

```powershell
npm run build
```

Example output:

- `releases\xcom-1.0.14\`

### 4) Preview the latest release

Serves the *most recent* folder under `releases/` at **http://127.0.0.1:5179**.

```powershell
npm run preview
```

---

## Notes on offline/PWA behavior

- Service workers require `http://` or `https://` (not `file://`).
- On localhost, `registerSW.js` disables service worker registration to keep development predictable.
- The production/release bundle contains:
  - `manifest.webmanifest`
  - `sw.js`
  - `registerSW.js`

---

## Legacy / retained artifacts

Desktop/Electron packaging has been retired.

Older Electron/one-off scrape files have been moved to:

- `obsolete/`

They are kept for reference only and are not part of the PWA build.

## Features

- **Interactive Offline Map**: MapLibre map modules with optional offline raster tile caching
- **Location Search**: Search by city, state/province or use current GPS location
- **Offline Geocoder**: Looks up cities/QTHs from a local gazetteer instead of live web services
- **Comprehensive Database**: Includes repeaters across USA and Canada
- **Multiple Bands**: Supports 2m, 70cm, 6m, and 1.25m bands
- **Digital Modes**: Includes FM, DMR, D-STAR, and System Fusion repeaters
- **Shortwave Schedule**: Worldwide HF broadcasts by time/frequency (EiBi snapshot)
- **Filtering Options**: Filter by band, mode, and search radius
- **Detailed Information**: Shows frequency, offset, tone, callsign, and notes
- **Distance Calculation**: Shows distance from your location to each repeater
- **Responsive Design**: Works on desktop and mobile devices
- **Installable PWA**: Can be installed from the browser (manifest + service worker)

## Running the App

Use the **Quick start** section above.

## Offline Data Pipeline & Backend Scripts

Most of the heavy lifting happens in Node scripts under `scripts/` and data files under `assets/data` and `assets/tiles`.

### 1. Offline map tiles (basemap)

**Goal:** provide a lightweight worldwide basemap that works offline.

- Current preferred approach (XTOC-style):
  - Use the **Map** module to download tiles for your AO into **Cache Storage** (`xtoc.tiles.v1`).
  - The Service Worker serves those cached tiles when offline.

**Script:** `scripts/fetch-tiles.js`

Downloads a low-zoom worldwide OSM raster tile cache from CARTO for offline use.

```bash
npm run fetch-tiles
```

Details:
- Downloads zoom levels **0–6** into `assets/tiles/world/{z}/{x}/{y}.png`
- Skips tiles that already exist and look valid (>1 KB)
- Respects the server with limited concurrency and small delays
- Safe to re-run to fill in any missing or corrupted tiles

> Disk usage grows quickly with each extra zoom level. Zoom 6 is a compromise between detail and size.

### 2. Offline callsign database (USA + Canada)

**Goal:** provide an offline callsign lookup database for the callsign lookup module and to help improve the geocoder coverage.

**Script:** `scripts/fetch-callsigns.js`

```bash
npm run fetch-callsigns
```

What it does:
- Downloads FCC ULS **USA** amateur dataset (`l_amat.zip`)
- Downloads ISED **Canada** amateur dataset (`amateur_delim.zip`)
- Parses and filters for active amateur records
- Outputs:
  - `assets/data/callsigns.json`
  - `assets/data/callsigns.js` (wraps the JSON in `window.CALLSIGNS_DATA = ...` for browser/Electron use)

These files are used by:
- `modules/callsign-lookup/callsign-lookup.js`
- `scripts/augment-world-cities-from-callsigns.js` (see next section)

### 3. Offline geocoder / world cities gazetteer

**Goal:** allow searching for locations (cities/QTH) completely offline, and ensure that every callsign QTH has at least an approximate point on the map.

Key files:
- `assets/data/world-cities.geojson` – base world city dataset
- `assets/data/world-cities.js` – JS wrapper that exposes the GeoJSON as `window.WORLD_CITIES_GEOJSON`
- `modules/shared/offline-geocoder.js` – in‑browser geocoder that searches the local gazetteer

**Script:** `scripts/augment-world-cities-from-callsigns.js`

```bash
node scripts/augment-world-cities-from-callsigns.js
```

What it does:
- Loads `assets/data/callsigns.json`
- Loads `assets/data/world-cities.geojson`
- For each unique US/Canada QTH `(city, state/province)` in the callsign data:
  - If already present in the gazetteer, it’s left alone
  - Otherwise, it synthesizes a new city feature at the **state/province centroid**
- Writes back an augmented gazetteer:
  - `assets/data/world-cities.geojson`
  - `assets/data/world-cities.js` (`window.WORLD_CITIES_GEOJSON = ...`)

This ensures the offline geocoder can always plot something for a callsign’s QTH, even if the town isn’t in the original world‑cities dataset.

### 4. Test / helper scripts

- `scripts/test-callsign-geocoding.js`
  - CLI tool to sanity‑check that callsigns can be associated with locations using the offline geocoder pipeline.

### 5. Shortwave schedule (EiBi)

**Goal:** provide an offline shortwave broadcast schedule for the **Shortwave** module.

**Script:** `scripts/fetch-shortwave-schedule.js`

```bash
npm run fetch-shortwave
```

What it does:
- Downloads the EiBi schedule text file (default source is `http://www.eibispace.de/dx/eibi.txt`)
- Parses and filters to **1700-30000 kHz**
- Writes: `modules/shortwave/shortwave-data.js`
- The same EiBi dataset is also browsable online at `https://shortwave.live/` (nice UI)

### 6. Repeater database (ARD — USA)

**Goal:** keep the **Repeaters** module backed by a community-maintained, CC0 dataset.

**Script:** `scripts/fetch-ard-repeaters.js`

```bash
npm run fetch-ard-repeaters
```

What it does:
- Downloads the ARD master list JSON from GitHub
- Normalizes it into XCOM's `repeaterData` format (adds band/mode/tone/offset strings)
- Writes:
  - `modules/repeater-map/repeater-data.js` (used by the app)
  - `repeater-data.js` (legacy mirror kept in sync)

> Note: ARD coverage varies by state; rerun the script periodically to pull updates.

## Application Modules (Front‑End)

- `modules/repeater-map/repeater-map.js`
  - Main repeater map UI: map, filters, sidebar, and marker rendering (MapLibre)
- `modules/callsign-lookup/callsign-lookup.js`
  - Callsign search UI backed by `assets/data/callsigns.js`
- `modules/shortwave/shortwave.js`
  - Shortwave schedule browser (by time / frequency) backed by `modules/shortwave/shortwave-data.js`
- `modules/map/map.js`
  - AO selection + offline raster tile downloads (Cache Storage)
- `modules/shared/offline-geocoder.js`
  - Client‑side geocoder that works entirely from local JSON/GeoJSON data
- `modules/help/help.js`
  - Static help content module

## Release bundles

`npm run build` bumps the patch version and creates `releases/xcom-<version>`.

## Technical dependencies

- **Node.js** (for running build/data scripts)
- **npm** (to install dependencies and run scripts)
- (No Electron) — PWA-only
- **MapLibre GL JS** (mapping library)

Useful scripts (from `package.json`):

```bash
npm run dev            # Serve repo root at http://127.0.0.1:5174
npm run build          # Create releases/xcom-<version>
npm run preview        # Serve latest release at http://127.0.0.1:5179
npm run fetch-tiles    # Download offline basemap tiles (zoom 0–6)
npm run fetch-callsigns
npm run fetch-shortwave
npm run test
```

## Browser compatibility

- Modern browsers with JavaScript enabled
- Geolocation API support for current location feature
- For full offline functionality, use `npm run preview` (or host the release bundle) — avoid `file://`

## Data Sources

The repeater database includes:
- Major metropolitan areas across USA and Canada
- Common repeater frequencies and offsets
- Popular digital mode repeaters
- Emergency and public service frequencies
- ARRL and club repeaters

Callsign data sources:
- FCC ULS public data (USA)
- ISED SMS TAFL (Canada)

## Future Enhancements

Potential improvements for a production version:
- Real-time repeater database integration
- User-submitted repeater information
- Repeater status and activity indicators
- Export functionality for GPS devices
- Mobile app version
- Higher-zoom offline tiles (with optional download)

## License

XCOM is distributed as a commercial product. On production deployments (non-localhost), it uses a **one-time WooCommerce license-key activation gate**. After activation, XCOM works offline on that device.

The repeater and callsign datasets are compiled from public sources and should be verified before use.

## Contributing

To add more repeaters or improve the application:
1. Prefer updating the repeater dataset via `npm run fetch-ard-repeaters`
2. Follow the existing data format
3. Run relevant data-prep scripts if needed (tiles, callsigns, world-cities)
4. Test the application thoroughly
5. Submit improvements

## Disclaimer

Repeater information should be verified with local sources before use. Frequencies, tones, and availability may change. Always follow proper amateur radio operating procedures and licensing requirements.

---

**73!** (Best wishes in amateur radio)
