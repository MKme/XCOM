class OfflineGeocoder {
    constructor() {
        this.places = [];
        this.ready = false;
        this.loading = null;
    }

    async load() {
        if (this.ready) return;
        if (this.loading) return this.loading;

        this.loading = (async () => {
            let geojson = null;

            // 1) Try direct fetch (works over http/https and in many Electron contexts)
            try {
                const url = new URL('assets/data/world-cities.geojson', window.location.href).toString();
                const res = await fetch(url);
                if (res.ok) {
                    geojson = await res.json();
                } else {
                    console.warn('Offline geocoder fetch failed with status', res.status);
                }
            } catch (err) {
                console.warn('Offline geocoder fetch failed, trying fallbacks:', err);
            }

            // 2) Fallback to JS payload if present (generated as window.WORLD_CITIES_GEOJSON)
            if (!geojson && window.WORLD_CITIES_GEOJSON) {
                geojson = window.WORLD_CITIES_GEOJSON;
            }

            // 3) If still nothing and JS payload not yet loaded, try to load it dynamically
            if (!geojson && typeof document !== 'undefined') {
                try {
                    await new Promise((resolve, reject) => {
                        const existing = document.querySelector('script[data-world-cities-payload="true"]');
                        if (existing) {
                            existing.addEventListener('load', resolve, { once: true });
                            existing.addEventListener('error', reject, { once: true });
                            return;
                        }
                        const script = document.createElement('script');
                        script.src = 'assets/data/world-cities.js';
                        script.async = true;
                        script.dataset.worldCitiesPayload = 'true';
                        script.onload = resolve;
                        script.onerror = () => reject(new Error('Failed to load assets/data/world-cities.js'));
                        document.body.appendChild(script);
                    });
                    if (window.WORLD_CITIES_GEOJSON) {
                        geojson = window.WORLD_CITIES_GEOJSON;
                    }
                } catch (err) {
                    console.warn('Offline geocoder JS payload fallback failed:', err);
                }
            }

            // 4) Electron preload helper (optional)
            if (!geojson && window.offlineData && typeof window.offlineData.loadWorldCities === 'function') {
                try {
                    const raw = window.offlineData.loadWorldCities();
                    if (raw) {
                        geojson = JSON.parse(raw);
                    }
                } catch (err) {
                    console.warn('Offline geocoder preload fallback failed:', err);
                }
            }

            if (!geojson) {
                throw new Error('Failed to load offline gazetteer from JSON, JS payload, or preload helper');
            }

            this.places = (geojson.features || []).map((feat) => {
                const props = feat.properties || {};
                const coords = feat.geometry && feat.geometry.coordinates;
                const lat = coords ? coords[1] : props.latitude;
                const lng = coords ? coords[0] : props.longitude;
                return {
                    name: props.name || props.nameascii || 'Unknown',
                    alt: props.namealt || '',
                    admin0: props.adm0name || props.sov0name || '',
                    admin1: props.adm1name || '',
                    iso: props.iso_a2 || '',
                    pop: props.pop_max || props.pop_min || 0,
                    lat,
                    lng
                };
            }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));

            this.ready = true;
        })();

        return this.loading;
    }

    /**
     * Search places by substring (case-insensitive).
     * @param {string} query
     * @param {number} limit
     * @returns {Array<{name:string, lat:number, lng:number, display:string}>}
     */
    search(query, limit = 5) {
        if (!this.ready) {
            throw new Error('Offline geocoder not loaded yet');
        }
        const q = query.trim().toLowerCase();
        if (!q) return [];

        const results = [];
        for (const p of this.places) {
            const haystacks = [
                p.name.toLowerCase(),
                p.alt.toLowerCase(),
                p.admin0.toLowerCase(),
                p.admin1.toLowerCase()
            ];
            if (haystacks.some(h => h && h.includes(q))) {
                results.push({
                    name: p.name,
                    lat: p.lat,
                    lng: p.lng,
                    display: this.buildDisplay(p),
                    pop: p.pop
                });
            }
        }

        results.sort((a, b) => (b.pop || 0) - (a.pop || 0));
        return results.slice(0, limit);
    }

    buildDisplay(p) {
        const parts = [p.name];
        if (p.admin1) parts.push(p.admin1);
        if (p.admin0) parts.push(p.admin0);
        if (p.iso) parts.push(p.iso);
        return parts.join(', ');
    }

    first(query) {
        const res = this.search(query, 1);
        return res.length ? res[0] : null;
    }
}

window.offlineGeocoder = new OfflineGeocoder();
