// Minimal SW registration, matching the XTOC release bundles.
// NOTE: keep paths relative so the app can be hosted from any subfolder.
// DEV NOTE:
// Service Workers can aggressively cache JS/CSS and make local iteration painful.
// When running on localhost ("npm run dev"), we skip SW registration.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      const isLocalhost =
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1' ||
        location.hostname === '[::1]'
      if (isLocalhost) return

      // Register at the same folder as index.html ("./sw.js")
      // updateViaCache:'none' ensures sw.js updates aren't blocked by HTTP caching.
      navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
        // Proactively ask for an update check on every load.
        try { reg.update() } catch (_) {}

        // If there's already a waiting SW, activate it immediately.
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' })
        }

        // When a new SW is found, force activation.
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing
          if (!sw) return
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              try {
                sw.postMessage({ type: 'SKIP_WAITING' })
              } catch (_) {}
            }
          })
        })

        // Reload once the new SW takes control so CSS changes apply.
        let refreshing = false
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (refreshing) return
          refreshing = true
          window.location.reload()
        })
      })
    } catch (_) {
      // ignore
    }
  })
}
