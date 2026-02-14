const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem(key) {
      return store.has(String(key)) ? store.get(String(key)) : null
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

function loadMapModuleInSandbox(sandbox) {
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'map', 'map.js'))
  return vm.runInContext('MapModule', sandbox)
}

test('Imported overlay popup includes Hide from map for phase line overlays (no markerId)', () => {
  const sandbox = makeSandbox()
  const MapModule = loadMapModuleInSandbox(sandbox)

  const fakeThis = Object.create(MapModule.prototype)
  fakeThis.withRosterLabels = (s) => String(s)
  fakeThis.getHiddenItems = () => []

  const feature = {
    type: 'Feature',
    id: 'imported:key:phaseline',
    geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    properties: { templateId: 10, phaseLineId: 'PL1', summary: 'PL', mode: 'C', packetId: 'X' },
  }

  const html = MapModule.prototype.importedPopupHtmlForFeature.call(fakeThis, feature, null)
  assert.ok(String(html).includes('Hide from map'))
  assert.ok(String(html).includes('data-kind="imported"'))
  assert.ok(String(html).includes('data-id="T10:PL1"'))
})

test('Imported overlay popup includes Hide from map for zone polygon overlays (no markerId)', () => {
  const sandbox = makeSandbox()
  const MapModule = loadMapModuleInSandbox(sandbox)

  const fakeThis = Object.create(MapModule.prototype)
  fakeThis.withRosterLabels = (s) => String(s)
  fakeThis.getHiddenItems = () => []

  const feature = {
    type: 'Feature',
    id: 'imported:key:zone',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    properties: { templateId: 7, mode: 'C', packetId: 'Z1', summary: 'Zone' },
  }

  const html = MapModule.prototype.importedPopupHtmlForFeature.call(fakeThis, feature, null)
  assert.ok(String(html).includes('Hide from map'))
  assert.ok(String(html).includes('data-kind="imported"'))
  assert.ok(String(html).includes('data-id="T7:C:Z1"'))
})

test('syncImportedOverlay shows hidden lines when Show Hidden is enabled (even if Imported is off)', () => {
  const sandbox = makeSandbox()
  const MapModule = loadMapModuleInSandbox(sandbox)

  // Hide the phase line by payload ID (markerId is not used for overlays).
  sandbox.hideTacticalMapItem('imported', 'T10:PL1', 'Phase Line')

  const setDataCalls = []
  const fakeSource = {
    setData(fc) {
      setDataCalls.push(fc)
    },
  }
  const fakeMap = {
    getSource() {
      return fakeSource
    },
  }

  const visibilityCalls = []
  const fakeThis = Object.create(MapModule.prototype)
  fakeThis.map = fakeMap
  fakeThis._importedSourceId = 'xcom-imported-src'
  fakeThis._importedEnabled = false
  fakeThis._importedLast7dOnly = false
  fakeThis._trustedModeEnabled = false
  fakeThis._showHiddenEnabled = true
  fakeThis.getHiddenItems = () => sandbox.getTacticalMapHiddenItems()
  fakeThis.getImportedOverlayFeatures = () => [
    {
      type: 'Feature',
      id: 'imported:key:phaseline',
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      properties: { templateId: 10, phaseLineId: 'PL1', status: 1, summary: 'PL' },
    },
  ]
  fakeThis.importedTemplateEnabled = () => true
  fakeThis.clearImportedMarkers = () => {}
  fakeThis.setImportedLayerVisibility = (v) => visibilityCalls.push(!!v)
  fakeThis.updateImportedLegend = () => {}
  fakeThis.syncImportedMarkers = () => {
    throw new Error('syncImportedMarkers should not run when Imported overlay is disabled')
  }

  MapModule.prototype.syncImportedOverlay.call(fakeThis)

  assert.equal(setDataCalls.length, 1)
  assert.equal(Array.isArray(setDataCalls[0]?.features), true)
  assert.equal(setDataCalls[0].features.length, 1)
  assert.equal(setDataCalls[0].features[0].properties.stroke, 'rgba(160,160,160,0.85)')
  assert.equal(visibilityCalls.at(-1), true)

  // Now disable Show Hidden: the hidden line should disappear entirely.
  fakeThis._showHiddenEnabled = false
  setDataCalls.length = 0
  visibilityCalls.length = 0

  MapModule.prototype.syncImportedOverlay.call(fakeThis)

  assert.equal(setDataCalls.length, 1)
  assert.equal(setDataCalls[0].features.length, 0)
  assert.equal(visibilityCalls.at(-1), false)
})

