// Shared offline propagation utilities (VOACAP-style heuristic)
// Extracted from the Predict module so other modules (e.g., Ham Clock) can reuse it.

(function () {
    'use strict';

    function clamp01(v) {
        if (!Number.isFinite(v)) return 0;
        return Math.max(0, Math.min(1, v));
    }

    function powerReliabilityFactor(powerW) {
        const base = Number.isFinite(powerW) ? powerW : 50;
        const ref = 5;
        const factor = 1 + Math.log10(Math.max(base, 1) / ref) * 0.12; // modest lift for higher power
        return Math.min(Math.max(factor, 0.75), 1.25);
    }

    function extractMHz(label) {
        const m = String(label || '').match(/([\d.]+)\s*MHz/i);
        return m ? parseFloat(m[1]) : 0;
    }

    function rangeScore(distanceKm, minKm, maxKm) {
        const d = Number(distanceKm);
        if (!Number.isFinite(d) || !Number.isFinite(minKm) || !Number.isFinite(maxKm)) return 0;

        const center = (minKm + maxKm) / 2;
        const halfWidth = (maxKm - minKm) / 2;
        if (d < minKm) {
            const diff = minKm - d;
            return Math.max(-0.6, 0.2 - (diff / Math.max(minKm, 1)) * 0.8);
        }
        if (d > maxKm) {
            const diff = d - maxKm;
            return Math.max(-0.6, 0.2 - (diff / Math.max(maxKm, 1)) * 0.8);
        }
        const t = 1 - Math.abs(d - center) / Math.max(halfWidth, 1);
        return 0.2 + t * 0.6; // 0.2 to 0.8
    }

    // Returns scores for HF bands given a path length + time + SFI + mode + power.
    function buildBandScores({
        distanceKm,
        utcDate = new Date(),
        sfi = 120,
        mode = 'Digital',
        powerW = 8
    }) {
        const date = utcDate instanceof Date ? utcDate : new Date(utcDate);
        const hour = date.getUTCHours();
        const month = date.getUTCMonth() + 1;
        const isNight = hour < 7 || hour >= 20;
        const isDay = hour >= 8 && hour <= 17;
        const isDuskDawn = (hour >= 6 && hour < 8) || (hour >= 17 && hour < 20);
        const solarFactor = clamp01((Number(sfi) - 60) / 140); // 0..1 between SFI 60-200
        const pFactor = powerReliabilityFactor(powerW);

        const baseBands = [
            { name: '80m (3.5-4 MHz)', minKm: 0, maxKm: 800, solarWeight: 0.05 },
            { name: '60m (5 MHz)', minKm: 0, maxKm: 900, solarWeight: 0.08 },
            { name: '40m (7 MHz)', minKm: 50, maxKm: 1800, solarWeight: 0.1 },
            { name: '30m (10 MHz)', minKm: 200, maxKm: 3000, solarWeight: 0.15 },
            { name: '20m (14 MHz)', minKm: 500, maxKm: 5000, solarWeight: 0.25 },
            { name: '17m (18 MHz)', minKm: 800, maxKm: 6000, solarWeight: 0.3 },
            { name: '15m (21 MHz)', minKm: 1000, maxKm: 7000, solarWeight: 0.4 },
            { name: '12m (24 MHz)', minKm: 1500, maxKm: 8000, solarWeight: 0.45 },
            { name: '10m (28 MHz)', minKm: 1200, maxKm: 8000, solarWeight: 0.5 }
        ];

        return baseBands.map((band) => {
            const mhz = extractMHz(band.name);
            const rScore = rangeScore(distanceKm, band.minKm, band.maxKm);

            // Diurnal weighting by band class (simple D-layer absorption proxy)
            let diurnal = 0;
            if (mhz <= 8) {
                diurnal = isNight ? 0.35 : -0.25;
            } else if (mhz <= 18) {
                diurnal = isDay ? 0.15 : -0.1;
            } else {
                diurnal = isDay ? 0.35 : -0.35;
            }

            const solarBoost = band.solarWeight * solarFactor;
            const duskBoost = isDuskDawn ? 0.1 : 0;
            const seasonalLoss = (month >= 5 && month <= 8 && mhz <= 10) ? -0.05 : 0;

            let score = 0.25 + diurnal + solarBoost + duskBoost + rScore + seasonalLoss;

            if (String(mode).toLowerCase() === 'fm' && band.name.includes('10m')) {
                score += 0.05;
            }
            if (String(mode).toLowerCase() === 'digital') {
                score += 0.05;
            }

            score = clamp01(score * pFactor);

            const detail = [];
            if (rScore > 0.65) detail.push('Sweet-spot path length');
            if (rScore < 0) detail.push('Out of skip range');
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

    function pickMethod({ distanceKm, sfi, mode }) {
        if (String(mode).toLowerCase() === 'digital') return 'Digital weak-signal (FT8/JS8) for reliable paths.';
        if (distanceKm < 150) return 'Ground/NVIS with 80/60/40 m at moderate power.';
        if (sfi < 80) return 'Lower bands (40/30 m) with CW or digital due to low SFI.';
        if (distanceKm > 3000) return 'Multi-hop HF; prioritize 20/17/15 m SSB or digital around local daytime.';
        return 'SSB/CW on 20/17 m in daylight; 40 m near dusk/dawn.';
    }

    function predictPropagation({ distanceKm, utcDate, sfi, mode, powerW }) {
        const all = buildBandScores({ distanceKm, utcDate, sfi, mode, powerW });
        const bands = [...all].sort((a, b) => b.score - a.score).slice(0, 5);
        const method = pickMethod({ distanceKm, sfi, mode });
        const notes = 'Modelled with a lightweight VOACAP-inspired curve. For precise results use full VOACAP with exact coordinates.';
        return { bands, method, notes, allBands: all };
    }

    // Expose as a stable global for legacy modules.
    window.PropagationModel = {
        buildBandScores,
        predictPropagation,
        pickMethod,
        rangeScore,
        powerReliabilityFactor
    };
})();
