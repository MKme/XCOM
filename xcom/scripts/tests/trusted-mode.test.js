const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      store.set(String(key), String(value))
    },
    removeItem(key) {
      store.delete(String(key))
    },
    clear() {
      store.clear()
    },
  }
}

function makeSandbox() {
  const sandbox = {
    console,
    localStorage: makeLocalStorage(),
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  return sandbox
}

function runScriptFile(sandbox, filePath) {
  const code = fs.readFileSync(filePath, 'utf8')
  vm.runInContext(code, sandbox, { filename: filePath })
}

function fromRepoRoot(...parts) {
  return path.join(__dirname, '..', '..', ...parts)
}

test('Trusted Mode setting persists in localStorage', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))

  assert.equal(sandbox.getTacticalMapTrustedModeEnabled(), false)

  sandbox.setTacticalMapTrustedModeEnabled(true)
  assert.equal(sandbox.getTacticalMapTrustedModeEnabled(), true)
  assert.equal(sandbox.localStorage.getItem('xtoc.tacticalMap.trustedMode'), '1')

  sandbox.setTacticalMapTrustedModeEnabled(false)
  assert.equal(sandbox.getTacticalMapTrustedModeEnabled(), false)
  assert.equal(sandbox.localStorage.getItem('xtoc.tacticalMap.trustedMode'), null)
})

test('Map Imported overlay filters out CLEAR entries when Trusted Mode enabled', () => {
  const sandbox = makeSandbox()

  sandbox.getImportedPackets = () => [
    {
      key: 'c',
      mode: 'C',
      importedAt: 111,
      features: [
        {
          type: 'Feature',
          id: 'c1',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { note: 'clear' },
        },
      ],
    },
    {
      key: 's',
      mode: 'S',
      importedAt: 222,
      features: [
        {
          type: 'Feature',
          id: 's1',
          geometry: { type: 'Point', coordinates: [1, 1] },
          properties: { note: 'secure' },
        },
        {
          type: 'Feature',
          id: 's2',
          geometry: { type: 'Point', coordinates: [2, 2] },
          properties: { note: 'secure2' },
        },
      ],
    },
  ]

  runScriptFile(sandbox, fromRepoRoot('modules', 'map', 'map.js'))

  const MapModule = vm.runInContext('MapModule', sandbox)
  const fTrusted = MapModule.prototype.getImportedOverlayFeatures.call({ _trustedModeEnabled: true })
  assert.deepEqual(
    [...fTrusted].map((f) => f.id).sort(),
    ['s1', 's2'],
  )

  const fAll = MapModule.prototype.getImportedOverlayFeatures.call({ _trustedModeEnabled: false })
  assert.deepEqual(
    [...fAll].map((f) => f.id).sort(),
    ['c1', 's1', 's2'],
  )
})

test('XTOC Data table greys out CLEAR rows when Trusted Mode enabled', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'xtoc-data', 'xtoc-data.js'))
  const XtocDataModule = vm.runInContext('XtocDataModule', sandbox)

  const tbody = { innerHTML: '', querySelectorAll: () => [] }
  sandbox.document = {
    getElementById(id) {
      if (id === 'xtocDataTbody') return tbody
      return null
    },
  }

  const fakeThis = {
    fmtWhen: () => 'WHEN',
    templateName: (t) => `T=${String(t)}`,
    withRosterLabels: (s) => String(s),
    escapeHtml: (s) => String(s),
    highlightSelectedRow: () => {},
  }

  const packets = [
    { key: 'k1', templateId: 1, mode: 'C', id: '1', source: 'comms', receivedAt: 1, summary: 'CLEAR' },
    { key: 'k2', templateId: 1, mode: 'S', id: '2', source: 'comms', receivedAt: 2, summary: 'SECURE' },
  ]

  // Trusted Mode OFF: no untrusted rows.
  XtocDataModule.prototype.renderTable.call(fakeThis, packets)
  assert.equal(tbody.innerHTML.includes('xtocDataRow--untrusted'), false)

  // Trusted Mode ON: CLEAR rows are flagged.
  sandbox.setTacticalMapTrustedModeEnabled(true)
  XtocDataModule.prototype.renderTable.call(fakeThis, packets)
  assert.equal(tbody.innerHTML.includes('xtocDataRow--untrusted'), true)
})
