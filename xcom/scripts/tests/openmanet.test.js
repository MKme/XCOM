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
    AbortController: globalThis.AbortController,
    setTimeout,
    clearTimeout,
  }

  // Prevent real timers from keeping the process alive.
  sandbox.setInterval = () => 1
  sandbox.clearInterval = () => {}

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

async function waitFor(fn, timeoutMs = 250) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error('timeout')
}

test('OpenMANET settings persist in localStorage', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))

  assert.equal(sandbox.getOpenManetApiBaseUrl(), '')
  assert.equal(sandbox.getOpenManetRefreshMs(), 2000)

  sandbox.setOpenManetApiBaseUrl(' http://10.0.0.1:8087/ ')
  assert.equal(sandbox.getOpenManetApiBaseUrl(), 'http://10.0.0.1:8087')
  assert.equal(sandbox.localStorage.getItem('xtoc.openmanet.apiBaseUrl'), 'http://10.0.0.1:8087')

  sandbox.setOpenManetApiBaseUrl('')
  assert.equal(sandbox.getOpenManetApiBaseUrl(), '')
  assert.equal(sandbox.localStorage.getItem('xtoc.openmanet.apiBaseUrl'), null)

  sandbox.setOpenManetRefreshMs(499)
  assert.equal(sandbox.getOpenManetRefreshMs(), 2000)

  sandbox.setOpenManetRefreshMs(1500.9)
  assert.equal(sandbox.getOpenManetRefreshMs(), 1500)
  assert.equal(sandbox.localStorage.getItem('xtoc.openmanet.refreshMs'), '1500')
})

test('xcomSetMeshNodeAssignment enforces unique node-to-member mapping', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'teamRoster.js'))

  sandbox.xcomUpsertRosterMembers(
    [
      { unitId: 1, label: 'U1', meshNodeId: 'openmanet:n1' },
      { unitId: 2, label: 'U2' },
    ],
    { replace: true },
  )

  const r1 = sandbox.xcomSetMeshNodeAssignment('openmanet:n1', 2)
  assert.equal(r1.ok, true)

  const members = sandbox.xcomListRosterMembers()
  const m1 = members.find((m) => m.unitId === 1)
  const m2 = members.find((m) => m.unitId === 2)
  assert.equal(m1.meshNodeId, undefined)
  assert.equal(m2.meshNodeId, 'openmanet:n1')

  const r2 = sandbox.xcomSetMeshNodeAssignment('openmanet:n1', null)
  assert.equal(r2.ok, true)
  const members2 = sandbox.xcomListRosterMembers()
  assert.equal(members2.find((m) => m.unitId === 2).meshNodeId, undefined)
})

test('Map meshNodeKeyForNode supports openmanet driver', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'map', 'map.js'))
  const MapModule = vm.runInContext('MapModule', sandbox)

  const key = MapModule.prototype.meshNodeKeyForNode.call({}, { driver: 'openmanet', id: 'node1' })
  assert.equal(key, 'openmanet:node1')
})

test('OpenMANET polling parses nodes (direct)', async () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'map', 'map.js'))
  const MapModule = vm.runInContext('MapModule', sandbox)

  sandbox.setOpenManetApiBaseUrl('http://openmanet:8087')
  sandbox.setOpenManetRefreshMs(500)

  const calls = []
  sandbox.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/openmanet.service.v1.NodeService/ListNodes')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            nodes: [
              { hostname: 'n1', ipaddr: '10.0.0.10', position: { latitude: 1.5, longitude: -2.25 } },
              { mac: 'aa:bb', position: { lat: 7.89, lon: 0.12, alt: 10 } },
            ],
          }
        },
      }
    }
    throw new Error(`unexpected fetch url: ${String(url)}`)
  }

  const fakeThis = {
    _openmanetNodes: [],
    _openmanetTimer: null,
    _openmanetAbort: null,
    _openmanetStatusEl: { textContent: '' },
    openmanetSetStatus: MapModule.prototype.openmanetSetStatus,
    stopOpenmanetPolling: MapModule.prototype.stopOpenmanetPolling,
  }

  MapModule.prototype.restartOpenmanetPolling.call(fakeThis)
  await waitFor(() => Array.isArray(fakeThis._openmanetNodes) && fakeThis._openmanetNodes.length === 2)

  assert.equal(calls.some((u) => u.includes('/openmanet.service.v1.NodeService/ListNodes')), true)
  assert.equal(fakeThis._openmanetNodes[0].driver, 'openmanet')
  assert.equal(fakeThis._openmanetNodes[0].id, 'n1')
  assert.equal(Number.isFinite(fakeThis._openmanetNodes[0].position.lat), true)

  MapModule.prototype.stopOpenmanetPolling.call(fakeThis)
})

test('OpenMANET polling uses bridge proxy when configured', async () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'map', 'map.js'))
  const MapModule = vm.runInContext('MapModule', sandbox)

  sandbox.setOpenManetApiBaseUrl('http://openmanet:8087')
  sandbox.localStorage.setItem('xcom.halow.config.v1', JSON.stringify({ baseUrl: 'http://bridge:8095/' }))

  const calls = []
  sandbox.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).startsWith('http://bridge:8095/openmanet/nodes?base_url=')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, nodes: [{ hostname: 'n1', ipaddr: '10.0.0.10', position: { lat: 1, lon: 2 } }] }
        },
      }
    }
    throw new Error(`unexpected fetch url: ${String(url)}`)
  }

  const fakeThis = {
    _openmanetNodes: [],
    _openmanetTimer: null,
    _openmanetAbort: null,
    _openmanetStatusEl: { textContent: '' },
    openmanetSetStatus: MapModule.prototype.openmanetSetStatus,
    stopOpenmanetPolling: MapModule.prototype.stopOpenmanetPolling,
  }

  MapModule.prototype.restartOpenmanetPolling.call(fakeThis)
  await waitFor(() => Array.isArray(fakeThis._openmanetNodes) && fakeThis._openmanetNodes.length === 1)

  assert.equal(calls[0].startsWith('http://bridge:8095/openmanet/nodes?base_url='), true)
  assert.equal(fakeThis._openmanetNodes[0].id, 'n1')

  MapModule.prototype.stopOpenmanetPolling.call(fakeThis)
})

