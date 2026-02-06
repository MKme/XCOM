#!/usr/bin/env node
/**
 * XCOM Release Builder (PWA-only)
 *
 * Builds a lightweight, shareable, static bundle for offline use.
 *
 * - Bumps patch version in package.json
 * - Updates XCOM branding/version strings in index/help where applicable
 * - Copies runtime files into releases/xcom-<version>
 *   (index.html, app-main.js, repeater-data.js, styles/, modules/, assets/)
 * - Includes PWA assets (manifest.webmanifest, sw.js, registerSW.js)
 *
 * NOTE: This is intentionally PWA-only. Desktop/Electron packaging has been retired.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_ROOT = path.join(ROOT, 'releases');
const APP_NAME = 'XCOM™';

function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function bumpPatch(version) {
    const parts = version.split('.').map(Number);
    while (parts.length < 3) parts.push(0);
    parts[2] += 1;
    return parts.join('.');
}

function updateIndexVersion(indexPath, version) {
    let html = fs.readFileSync(indexPath, 'utf8');

    // Title bar / header / footer strings may vary historically.
    // Replace any known legacy variants with XCOM.
    html = html.replace(/VE3YLO Offline Communication Suite/gi, `${APP_NAME}`);
    html = html.replace(/Amateur Radio Toolkit/gi, `${APP_NAME}`);

    // If a version string exists, normalize it.
    // (We only add "vX" if a "v" token already exists, to avoid changing unrelated text.)
    html = html.replace(/\bv\s*\d+\.\d+\.\d+\b/g, `v${version}`);

    fs.writeFileSync(indexPath, html);
}

function updateHelpVersion(helpPath, version) {
    let js = fs.readFileSync(helpPath, 'utf8');

    js = js.replace(/Amateur Radio Toolkit/gi, `${APP_NAME}`);
    js = js.replace(/VE3YLO Offline Communication Suite/gi, `${APP_NAME}`);
    js = js.replace(/\bv\s*\d+\.\d+\.\d+\b/g, `v${version}`);

    fs.writeFileSync(helpPath, js);
}

function copyRecursive(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dest, entry));
        }
    } else {
        try {
            fs.copyFileSync(src, dest);
        } catch (err) {
            // Fallback for OneDrive/locked files: read/write
            const data = fs.readFileSync(src);
            fs.writeFileSync(dest, data);
        }
    }
}

// Electron build retired. PWA-only.

function main() {
    const pkgPath = path.join(ROOT, 'package.json');
    const indexPath = path.join(ROOT, 'index.html');
    const helpPath = path.join(ROOT, 'modules', 'help', 'help.js');

    const pkg = readJson(pkgPath);
    const newVersion = bumpPatch(pkg.version || '1.0.0');
    pkg.version = newVersion;
    writeJson(pkgPath, pkg);

    updateIndexVersion(indexPath, newVersion);
    updateHelpVersion(helpPath, newVersion);

    const releaseDir = path.join(RELEASE_ROOT, `xcom-${newVersion}`);
    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'styles'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'modules'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'assets', 'data'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'assets', 'vendor'), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, 'assets', 'tiles'), { recursive: true });

    ['index.html', 'app-main.js', 'repeater-data.js'].forEach((file) => {
        fs.copyFileSync(path.join(ROOT, file), path.join(releaseDir, file));
    });

    // PWA runtime files
    ['manifest.webmanifest', 'sw.js', 'registerSW.js'].forEach((file) => {
        const src = path.join(ROOT, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(releaseDir, file));
        }
    });

    copyRecursive(path.join(ROOT, 'styles'), path.join(releaseDir, 'styles'));
    copyRecursive(path.join(ROOT, 'modules'), path.join(releaseDir, 'modules'));
    copyRecursive(path.join(ROOT, 'assets', 'vendor'), path.join(releaseDir, 'assets', 'vendor'));
    copyRecursive(path.join(ROOT, 'assets', 'tiles'), path.join(releaseDir, 'assets', 'tiles'));

    // Top-level icon(s) for favicon and in-app logo
    ['icon.svg', 'icon.png', 'icon.ico', 'icon.txt'].forEach((f) => {
        const src = path.join(ROOT, 'assets', f);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(releaseDir, 'assets', f));
        }
    });

    // optional callsign data if present
    const dataDir = path.join(ROOT, 'assets', 'data');
    ['callsigns.json', 'callsigns.js'].forEach((f) => {
        const src = path.join(dataDir, f);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(releaseDir, 'assets', 'data', f));
        }
    });
    ['world-cities.geojson', 'world-cities.js', 'README.md'].forEach((f) => {
        const src = path.join(dataDir, f);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(releaseDir, 'assets', 'data', f));
        }
    });

    console.log(`Release created: ${releaseDir}`);
    console.log(`Version bumped to ${newVersion}`);
}

main();
