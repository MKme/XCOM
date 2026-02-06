// Minimal entrypoint to bundle Meshtastic JS for browser usage.
// We export the package namespace so it can be attached to `window.Meshtastic`
// by esbuild's `globalName` when bundled as IIFE.

export * from '@meshtastic/js';
