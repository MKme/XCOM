// Shared space-weather scraper (HTML parsing) extracted from the Predict module.
// Intended for optional online use (Ham Clock, Predict, etc.).

(function () {
    'use strict';

    async function fetchTextWithTimeout(url, timeoutMs = 12_000) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } finally {
            clearTimeout(t);
        }
    }

    async function fetchWithFallback(url) {
        const attempts = [
            url,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            // jina.ai mirrors HTML by fetching the target and returning the content
            `https://r.jina.ai/http://www.wm7d.net/hamradio/solar/index.shtml`
        ];

        let lastErr = null;
        for (const attempt of attempts) {
            try {
                return await fetchTextWithTimeout(attempt, 12_000);
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr || new Error('All space weather fetch attempts failed');
    }

    function parseWm7dSolarHtml(html) {
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

            const sfi = grab('Solar Flux|SFI');
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
            console.warn('Space weather parse error:', err);
            return null;
        }
    }

    async function fetchWm7dSolar() {
        const url = 'https://www.wm7d.net/hamradio/solar/index.shtml';
        const html = await fetchWithFallback(url);
        return {
            sourceUrl: url,
            data: parseWm7dSolarHtml(html)
        };
    }

    // NOAA SWPC R/S/G scales (JSON)
    // Example: https://services.swpc.noaa.gov/json/noaa-scales.json
    async function fetchNoaaScales() {
        const url = 'https://services.swpc.noaa.gov/json/noaa-scales.json';

        // Browsers may block SWPC with CORS depending on environment.
        // Provide fallbacks similar to the SFI scraper.
        const attempts = [
            url,
            `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
            `https://r.jina.ai/http://services.swpc.noaa.gov/json/noaa-scales.json`
        ];

        let lastErr = null;
        for (const attempt of attempts) {
            try {
                const txt = await fetchTextWithTimeout(attempt, 12_000);
                const json = JSON.parse(txt);
                return {
                    sourceUrl: attempt,
                    data: Array.isArray(json) ? json : null
                };
            } catch (err) {
                lastErr = err;
            }
        }

        throw lastErr || new Error('NOAA scales fetch failed');
    }

    function parseNoaaScales(jsonArray) {
        // Expect array of objects with fields like:
        // { "scale": "G", "level": 0, "text": "None" ... }
        if (!Array.isArray(jsonArray)) return null;
        const byScale = { R: null, S: null, G: null };
        jsonArray.forEach((item) => {
            if (!item || typeof item !== 'object') return;
            const scale = String(item.scale || '').toUpperCase();
            if (!['R', 'S', 'G'].includes(scale)) return;
            const levelRaw = item.level;
            const level = Number.isFinite(levelRaw) ? levelRaw : parseInt(levelRaw, 10);
            byScale[scale] = {
                level: Number.isFinite(level) ? level : 0,
                text: item.text || item.description || ''
            };
        });
        return byScale;
    }

    window.SpaceWeather = {
        fetchTextWithTimeout,
        fetchWithFallback,
        parseWm7dSolarHtml,
        fetchWm7dSolar,
        fetchNoaaScales,
        parseNoaaScales
    };
})();
