#!/usr/bin/env node
/**
 * Fetch a low-zoom worldwide OSM raster tile cache for offline use.
 * Downloads zoom levels 0-5 into assets/tiles/world/{z}/{x}/{y}.png
 * Uses CartoDB/CARTO basemaps which allow reasonable offline caching.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const TILE_ROOT = path.join(ROOT, 'assets', 'tiles', 'world');
const MAX_ZOOM = 6; // Fetch one extra zoom level for more detail when zoomed in
const CONCURRENCY = 4; // Be respectful of server resources
const DELAY_MS = 100; // Delay between batches

// Use CartoDB/CARTO positron (light) tiles - allows offline caching
// Alternative servers that allow caching:
// - https://cartodb-basemaps-a.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png
// - https://stamen-tiles.a.ssl.fastly.net/terrain/{z}/{x}/{y}.png
// - https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png

function getTileUrl(z, x, y) {
    // Use CARTO light_all basemap - clean, light style good for overlays
    const servers = ['a', 'b', 'c', 'd'];
    const server = servers[(x + y) % servers.length];
    return `https://${server}.basemaps.cartocdn.com/rastertiles/light_all/${z}/${x}/${y}.png`;
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchTile(z, x, y) {
    return new Promise((resolve) => {
        const url = getTileUrl(z, x, y);
        const outPath = path.join(TILE_ROOT, String(z), String(x), `${y}.png`);
        
        // Check if file exists and is valid (not a blocked response)
        if (fs.existsSync(outPath)) {
            const stats = fs.statSync(outPath);
            // If file is larger than 1KB, it's probably valid
            // Blocked responses are typically small HTML error pages
            if (stats.size > 1000) {
                return resolve({ skipped: true });
            }
            // Delete corrupted/blocked file
            fs.unlinkSync(outPath);
        }
        
        ensureDir(path.dirname(outPath));

        const options = {
            headers: {
                'User-Agent': 'VE3YLO-Offline-Communication-Suite/1.0 (Ham Radio Repeater Map; offline cache)'
            }
        };

        https.get(url, options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                console.log(`  Warning: HTTP ${res.statusCode} for ${z}/${x}/${y}`);
                return resolve({ error: new Error(`HTTP ${res.statusCode}`) });
            }
            const file = fs.createWriteStream(outPath);
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve({ ok: true })));
        }).on('error', (err) => {
            console.log(`  Error fetching ${z}/${x}/${y}: ${err.message}`);
            resolve({ error: err });
        });
    });
}

async function run() {
    console.log('VE3YLO Offline Communication Suite - Tile Fetcher');
    console.log('================================================');
    console.log(`Downloading tiles to: ${TILE_ROOT}`);
    console.log(`Zoom levels: 0-${MAX_ZOOM}`);
    console.log('Source: CARTO basemaps (light_all)\n');

    ensureDir(TILE_ROOT);
    const tasks = [];

    for (let z = 0; z <= MAX_ZOOM; z++) {
        const max = 2 ** z;
        for (let x = 0; x < max; x++) {
            for (let y = 0; y < max; y++) {
                tasks.push({ z, x, y });
            }
        }
    }

    console.log(`Total tiles to check: ${tasks.length}`);

    let downloaded = 0;
    let skipped = 0;
    let errors = 0;

    // Process in batches
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(t => fetchTile(t.z, t.x, t.y)));
        
        for (const res of results) {
            if (res.ok) downloaded++;
            else if (res.skipped) skipped++;
            else errors++;
        }

        // Progress update
        const progress = Math.round(((i + batch.length) / tasks.length) * 100);
        process.stdout.write(`\rProgress: ${progress}% (${downloaded} downloaded, ${skipped} cached, ${errors} errors)`);
        
        // Rate limiting
        if (downloaded > 0) await sleep(DELAY_MS);
    }

    console.log(`\n\nComplete!`);
    console.log(`  Downloaded: ${downloaded}`);
    console.log(`  Already cached: ${skipped}`);
    console.log(`  Errors: ${errors}`);
    console.log(`  Total: ${tasks.length}`);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
