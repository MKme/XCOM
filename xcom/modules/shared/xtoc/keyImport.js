// Key import workflow for XCOM.
//
// IMPORTANT: XCOM loads this file via dynamic <script> injection (classic script,
// not ESM). So we must NOT use `import` / `export` here.

function importKeyBundle(text, { setActive = true } = {}) {
  const parseKeyBundle = globalThis.parseKeyBundle
  if (typeof parseKeyBundle !== 'function') return { ok: false, reason: 'Key bundle parser not loaded' }

  const parsed = parseKeyBundle(text)
  if (!parsed) return { ok: false, reason: 'Invalid key bundle' }

  // Persist in the team-key map for general use.
  if (typeof globalThis.putTeamKey !== 'function') return { ok: false, reason: 'Storage helpers not loaded' }
  globalThis.putTeamKey(parsed.teamId, parsed.kid, parsed.keyB64Url)

  // XCOM Comms behavior: importing a key should ONLY set the active comms key
  // (used for SECURE packet generation) and should NOT overwrite Team ID / KID
  // UI fields.
  if (setActive) {
    if (typeof globalThis.setCommsActiveKey === 'function') {
      globalThis.setCommsActiveKey({ teamId: parsed.teamId, kid: parsed.kid, keyB64Url: parsed.keyB64Url })
    }
  }

  return { ok: true, teamId: parsed.teamId, kid: parsed.kid }
}

// Make available to non-module scripts (XCOM loads via <script> not ESM).
try {
  globalThis.importKeyBundle = importKeyBundle
} catch (_) {
  // ignore
}
