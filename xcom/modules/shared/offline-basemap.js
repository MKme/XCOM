/**
 * Offline Basemap Module
 * Loads pre-cached map tiles from local storage for offline use.
 * Tiles are downloaded using: npm run fetch-tiles
 */

(function() {
    'use strict';

    // Path to local tiles (relative to HTML file)
    const TILE_PATH = 'assets/tiles/world';
    const MIN_ZOOM = 0;

    // We only ship tiles up to this zoom level.
    // Leaflet can still zoom further by scaling these tiles ("overzoom").
    const MAX_NATIVE_ZOOM = 6;

    // Allow higher zoom for UI usability (markers, precise clicking), even if the
    // underlying raster tiles don't add extra detail past MAX_NATIVE_ZOOM.
    const DEFAULT_MAX_ZOOM = 12;

    // Custom tile layer that loads from local cache
    L.OfflineWorldLayer = L.TileLayer.extend({
        initialize: function(options) {
            // Use local tile path
            const url = TILE_PATH + '/{z}/{x}/{y}.png';
            const maxZoom = (options && Number.isFinite(options.maxZoom)) ? options.maxZoom : DEFAULT_MAX_ZOOM;

            L.TileLayer.prototype.initialize.call(this, url, L.extend({
                minZoom: MIN_ZOOM,
                maxZoom,
                maxNativeZoom: MAX_NATIVE_ZOOM,  // Don't request higher-resolution tiles than we have; Leaflet will smoothly scale beyond this
                attribution: 'Offline Map &copy; <a href="https://carto.com/">CARTO</a>',
                errorTileUrl: ''  // No fallback for missing tiles
            }, options));
        },

        // Override to handle missing tiles gracefully
        createTile: function(coords, done) {
            const tile = L.TileLayer.prototype.createTile.call(this, coords, done);
            
            // Add error handler for missing tiles - show simple fallback
            tile.onerror = function() {
                // Create a simple colored tile as fallback
                const canvas = document.createElement('canvas');
                canvas.width = 256;
                canvas.height = 256;
                const ctx = canvas.getContext('2d');
                
                // Light blue for ocean as default
                ctx.fillStyle = '#E8F4F8';
                ctx.fillRect(0, 0, 256, 256);
                
                // Draw grid
                ctx.strokeStyle = 'rgba(200, 200, 200, 0.5)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(256, 256);
                ctx.moveTo(256, 0);
                ctx.lineTo(0, 256);
                ctx.stroke();
                
                // Replace tile src with canvas data
                tile.src = canvas.toDataURL();
                done(null, tile);
            };
            
            return tile;
        }
    });
    
    // Factory function
    L.offlineWorldLayer = function(options) {
        return new L.OfflineWorldLayer(options);
    };

    // Also provide grid layer alias for compatibility
    L.offlineGridLayer = L.offlineWorldLayer;

    console.log('Offline basemap module loaded - L.offlineWorldLayer() and L.offlineGridLayer() available');
    console.log('Tiles loaded from: ' + TILE_PATH);
})();
