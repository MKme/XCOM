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

function makeElement(tagName = 'div') {
  const el = {
    tagName: String(tagName).toUpperCase(),
    dataset: {},
    className: '',
    style: {},
    title: '',
    children: [],
    appendChild(child) {
      this.children.push(child)
      return child
    },
    addEventListener() {},
    removeAttribute() {},
    querySelector() {
      return null
    },
    removeChild(child) {
      const idx = this.children.indexOf(child)
      if (idx >= 0) this.children.splice(idx, 1)
    },
    get firstChild() {
      return this.children.length ? this.children[0] : null
    },
  }
  return el
}

class StubMarker {
  constructor(opts = {}) {
    this._el = opts.element || makeElement('div')
    this._lngLat = null
    this._removed = false
  }
  setLngLat(ll) {
    this._lngLat = ll
    return this
  }
  addTo(map) {
    this._map = map
    return this
  }
  getElement() {
    return this._el
  }
  getLngLat() {
    if (!Array.isArray(this._lngLat)) return null
    return { lng: this._lngLat[0], lat: this._lngLat[1] }
  }
  setPopup(p) {
    this._popup = p
    return this
  }
  remove() {
    this._removed = true
  }
}

class StubPopup {
  setHTML(html) {
    this._html = html
    return this
  }
}

test('Hidden items helpers persist in localStorage', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))

  assert.equal(Array.isArray(sandbox.getTacticalMapHiddenItems()), true)
  assert.equal(sandbox.getTacticalMapHiddenItems().length, 0)

  sandbox.hideTacticalMapItem('imported', 'm1', 'Marker 1')
  const items = sandbox.getTacticalMapHiddenItems()
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'imported')
  assert.equal(items[0].id, 'm1')
  assert.equal(items[0].label, 'Marker 1')

  sandbox.unhideTacticalMapItem('imported', 'm1')
  assert.equal(sandbox.getTacticalMapHiddenItems().length, 0)
  assert.equal(sandbox.localStorage.getItem('xtoc.tacticalMap.hiddenItems.v1'), null)
})

test('Map Imported markers skip hidden ids', () => {
  const sandbox = makeSandbox()

  sandbox.document = {
    createElement(tag) {
      return makeElement(tag)
    },
  }
  sandbox.maplibregl = { Marker: StubMarker, Popup: StubPopup }

  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'map', 'map.js'))

  // Hide one imported marker id.
  sandbox.hideTacticalMapItem('imported', 'm1', 'Hidden Marker')

  const MapModule = vm.runInContext('MapModule', sandbox)

  const fakeThis = {
    map: {},
    _importedMarkerById: new Map(),
    _importedMarkerFeatureById: new Map(),
    getRosterSafeLabelByUnitId: () => new Map(),
    importedTimestampMs: () => 0,
    importedMarkerIconKind: () => 'file',
    setImportedMarkerClasses: () => {},
    createMarkerIconSvg: () => ({}),
    withRosterLabels: (s) => String(s),
    syncImportedTeamMarkerBadge: () => {},
    getHiddenItems: () => sandbox.getTacticalMapHiddenItems(),
    openImportedPopup: () => {},
  }

  const f1 = { type: 'Feature', id: 'm1', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { templateId: 1, summary: 'one' } }
  const f2 = { type: 'Feature', id: 'm2', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { templateId: 1, summary: 'two' } }

  MapModule.prototype.syncImportedMarkers.call(fakeThis, [f1, f2])
  assert.equal(fakeThis._importedMarkerById.has('m1'), false)
  assert.equal(fakeThis._importedMarkerById.has('m2'), true)
})

test('Map Mesh nodes skip hidden keys', () => {
  const sandbox = makeSandbox()

  sandbox.document = {
    createElement(tag) {
      return makeElement(tag)
    },
  }
  sandbox.maplibregl = { Marker: StubMarker, Popup: StubPopup }

  sandbox.xcomMesh = {
    getState() {
      return {
        nodes: [
          { key: 'k1', driver: 'meshtastic', id: '!00000001', position: { lat: 1, lon: 2, ts: 1 } },
          { key: 'k2', driver: 'meshtastic', id: '!00000002', position: { lat: 3, lon: 4, ts: 2 } },
        ],
      }
    },
  }

  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'map', 'map.js'))

  sandbox.hideTacticalMapItem('mesh', 'k1', 'Hidden Node')

  const MapModule = vm.runInContext('MapModule', sandbox)

  const fakeThis = {
    map: {},
    _meshNodesEnabled: true,
    _openmanetNodes: [],
    _meshMarkerByKey: new Map(),
    _meshPopupByKey: new Map(),
    meshAssignedLabelByNodeKey: () => new Map(),
    meshNodePopupHtml: () => '',
    meshNodeKeyForNode: (n) => String(n?.key || '').trim(),
    createMarkerIconSvg: () => ({}),
    updateMeshLegend: () => {},
    getHiddenItems: () => sandbox.getTacticalMapHiddenItems(),
    escapeHtml: (s) => String(s),
  }

  MapModule.prototype.syncMeshNodesOverlay.call(fakeThis)
  assert.equal(fakeThis._meshMarkerByKey.has('k1'), false)
  assert.equal(fakeThis._meshMarkerByKey.has('k2'), true)
})
