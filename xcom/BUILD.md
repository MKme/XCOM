# XCOM - Build & Test Instructions (PWA-only)

This document covers **how to run, build, and validate XCOM as a static Progressive Web App (PWA)**.

> Desktop/Electron packaging has been retired. Legacy artifacts were moved to `obsolete/`.

---

## Prerequisites

- Node.js (LTS recommended)
- npm

---

## Working directory

All commands are run from:

```powershell
cd c:\GitHub\XCOM\xcom
```

---

## Install

```powershell
npm install
```

---

## Run (development)

Serves the repo root at **http://127.0.0.1:5174**.

```powershell
npm run dev
```

Notes:

- `registerSW.js` disables service worker registration on localhost so caching does not interfere with development.
- Use the browser devtools console to see any runtime errors.

---

## Build (release bundle)

Creates a versioned, self-contained static bundle under `releases/`.

```powershell
npm run build
```

What the build does:

- Bumps the patch version in `package.json`
- Updates version/branding strings in `index.html` and `modules/help/help.js`
- Creates `releases/xcom-<version>/` with all required runtime assets

---

## Build (webserver fileset)

Creates a single folder you can upload to your server (optionally including `license.php` + `.htaccess`).

From the repo root:

```powershell
cd c:\GitHub\XCOM
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\make-web-fileset.ps1 -Label "1.0.19-license" -BasePath "/xcom/" -AccessMode license -IncludeHelpers -Zip
```

From the `xcom/` folder:

```powershell
cd c:\GitHub\XCOM\xcom
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\make-web-fileset.ps1 -Label "1.0.19-license" -BasePath "/xcom/" -AccessMode license -IncludeHelpers -Zip
```

Output:

- `releases/xcom-web-fileset-<version>-<label>-<base>/` (plus optional `.zip` if you pass `-Zip`)
  - If your `-Label` already contains a version (e.g. `1.0.19-license`), it won't be duplicated.

Tip: if a previous run already created `releases/xcom-<version>/` and you only want to re-package without bumping the patch version again, pass `-SkipBuild`.

Notes:

- For faster packaging, the fileset script excludes the pre-generated offline basemap tile pack (`assets/tiles/`) by default. If you want to ship it, pass `-IncludeOfflineTiles` (expect zips to be slower/larger).
- The fileset script also excludes redundant JS payload wrappers (`assets/data/callsigns.js`, `assets/data/world-cities.js`) by default. Hosted/PWA use prefers `callsigns.json` + `world-cities.geojson`.
- If zipping is still slow, try `-CompressionLevel Fastest` (or `NoCompression`).
- `-IncludeHelpers` also bundles the standalone MANET bridge helper (`halow-bridge/`) alongside the fileset/zip (look in `XCOM/halow-bridge/` or a sibling `../XTOC/halow-bridge/` checkout).

---

## Preview (release bundle)

Serves the **latest** release folder under `releases/` at **http://127.0.0.1:5179**.

```powershell
npm run preview
```

---

## Offline/PWA validation checklist

1. Run `npm run preview` and open http://127.0.0.1:5179
2. In Chrome/Edge:
   - DevTools → Application → Manifest: manifest loads
   - DevTools → Application → Service Workers: `sw.js` is registered (on non-localhost deployments)
3. Offline test:
   - DevTools → Network → Offline
   - Reload and confirm the app shell loads
4. Map tiles:
   - Open **Map** module, download tiles for an AO
   - Go offline and verify cached tiles still render

---

## License gate (production)

XCOM defaults to a **license activation gate** on non-localhost deployments (localhost/dev is ungated).

The browser app validates a WooCommerce license key via a tiny server-side proxy endpoint hosted alongside XCOM:

- `https://mkme.org/xcom/license.php` (or `./license.php` relative to where XCOM is hosted)

Server files to deploy are included in this repo:

- `XCOM/site/xcom/keys etc NOGIT/license.php`
- `XCOM/site/xcom/keys etc NOGIT/.xcom-license-secrets.php.example`
- `XCOM/site/xcom/keys etc NOGIT/.htaccess`
- `XCOM/site/xcom/keys etc NOGIT/README.md` (deployment + secrets checklist)

## Optional: Refresh offline datasets

These scripts update offline data under `assets/data/`:

```powershell
npm run fetch-callsigns
npm run fetch-tiles
node scripts/augment-world-cities-from-callsigns.js
```
