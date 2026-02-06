#!/usr/bin/env node
/**
 * Downloads and builds an offline callsign database for USA (FCC ULS) and Canada (ISED SMS TAFL).
 * Outputs a compact JSON file at assets/data/callsigns.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Readable } = require('stream');
const AdmZip = require('adm-zip');
const { parse } = require('csv-parse');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'assets', 'data');
const RAW_DIR = path.join(DATA_DIR, 'raw');

const US_ZIP_URL = 'https://data.fcc.gov/download/pub/uls/complete/l_amat.zip';
const CA_ZIP_URL = 'https://apc-cap.ic.gc.ca/datafiles/amateur_delim.zip';

const OUTPUT_FILE = path.join(DATA_DIR, 'callsigns.json');
const OUTPUT_JS_FILE = path.join(DATA_DIR, 'callsigns.js');
const US_ZIP_PATH = path.join(RAW_DIR, 'us-l_amat.zip');
const CA_ZIP_PATH = path.join(RAW_DIR, 'ca-amateur.zip');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to download ${url} - status ${res.statusCode}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

function clean(value) {
    if (!value) return '';
    return value.replace(/\s+/g, ' ').trim();
}

async function parseUS(zipPath) {
    const zip = new AdmZip(zipPath);

    const entityById = new Map();
    const amateurById = new Map();
    const results = [];

    zip.readFile('EN.dat').toString().split(/\r?\n/).forEach((line) => {
        if (!line) return;
        const parts = line.split('|');
        const id = parts[1];
        if (!id) return;
        const record = {
            entityName: clean(parts[7]),
            firstName: clean(parts[8]),
            lastName: clean(parts[10]),
            city: clean(parts[16]),
            state: clean(parts[17]),
        };
        entityById.set(id, record);
    });

    zip.readFile('AM.dat').toString().split(/\r?\n/).forEach((line) => {
        if (!line) return;
        const parts = line.split('|');
        const id = parts[1];
        if (!id) return;
        amateurById.set(id, {
            operatorClass: clean(parts[5]),
            trustee: clean(parts[9]),
        });
    });

    zip.readFile('HD.dat').toString().split(/\r?\n/).forEach((line) => {
        if (!line) return;
        const parts = line.split('|');
        const id = parts[1];
        const callSign = clean(parts[4]);
        const status = clean(parts[5]);
        const service = clean(parts[6]);
        const grantDate = clean(parts[7]);
        const expireDate = clean(parts[8]);

        if (!id || !callSign) return;
        if (status !== 'A') return; // Only active
        if (service !== 'HA' && service !== 'HV') return; // Amateur services

        const entity = entityById.get(id) || {};
        const amateur = amateurById.get(id) || {};
        const name = entity.entityName || [entity.firstName, entity.lastName].filter(Boolean).join(' ');

        results.push({
            c: callSign.toUpperCase(),
            n: name || undefined,
            city: entity.city || undefined,
            st: entity.state || undefined,
            co: 'USA',
            cl: amateur.operatorClass || undefined,
            ex: expireDate || undefined,
            g: grantDate || undefined,
        });
    });

    return results;
}

function summarizeQualifications(fields) {
    const norm = (v) => (v || '').trim().toUpperCase();
    const yes = (v) => !!norm(v);

    const flags = [];
    if (yes(fields[7])) flags.push('Basic');
    if (yes(fields[8])) flags.push('5 WPM');
    if (yes(fields[9])) flags.push('12 WPM');
    if (yes(fields[10])) flags.push('Advanced');
    if (yes(fields[11])) flags.push('Basic Honours');
    return flags.join(', ');
}

async function parseCanada(zipPath) {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry('amateur_delim.txt');
    if (!entry) {
        throw new Error('Missing amateur_delim.txt in Canadian archive');
    }

    const text = zip.readFile(entry).toString();
    const lines = text.split(/\r?\n/);
    const results = [];

    for (const line of lines) {
        if (!line.trim()) continue;
        const fields = line.split(';');
        const call = clean(fields[0]);
        if (!call) continue;
        const given = clean(fields[1]);
        const surname = clean(fields[2]);
        const name = [given, surname].filter(Boolean).join(' ');
        const city = clean(fields[4]);
        const province = clean(fields[5]);
        const qual = summarizeQualifications(fields);

        results.push({
            c: call.toUpperCase(),
            n: name || undefined,
            city: city || undefined,
            st: province || undefined,
            co: 'Canada',
            cl: qual || undefined,
            ex: undefined,
        });
    }

    return results;
}

async function main() {
    ensureDir(RAW_DIR);

    console.log('Downloading FCC Amateur Radio dataset (USA)...');
    await downloadFile(US_ZIP_URL, US_ZIP_PATH);
    console.log('USA dataset downloaded.');

    console.log('Downloading ISED SMS TAFL dataset (Canada)...');
    await downloadFile(CA_ZIP_URL, CA_ZIP_PATH);
    console.log('Canada dataset downloaded.');

    console.log('Parsing USA data...');
    const usRecords = await parseUS(US_ZIP_PATH);
    console.log(`Parsed ${usRecords.length.toLocaleString()} USA records`);

    console.log('Parsing Canada data...');
    let caRecords = [];
    try {
        caRecords = await parseCanada(CA_ZIP_PATH);
        console.log(`Parsed ${caRecords.length.toLocaleString()} Canada records`);
    } catch (err) {
        console.warn('Canada dataset could not be parsed (continuing with USA only):', err.message);
    }

    const combined = [...usRecords, ...caRecords];
    const payload = {
        meta: {
            generatedAt: new Date().toISOString(),
            sources: {
                usa: US_ZIP_URL,
                canada: CA_ZIP_URL,
            },
            counts: {
                usa: usRecords.length,
                canada: caRecords.length,
                total: combined.length,
            },
        },
        records: combined,
    };

    ensureDir(DATA_DIR);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload));
    fs.writeFileSync(OUTPUT_JS_FILE, `window.CALLSIGNS_DATA = ${JSON.stringify(payload)};`);
    console.log(`Saved ${combined.length.toLocaleString()} total callsigns to ${OUTPUT_FILE} and ${OUTPUT_JS_FILE}`);
}

main().catch((err) => {
    console.error('Failed to fetch callsign data:', err);
    process.exit(1);
});
