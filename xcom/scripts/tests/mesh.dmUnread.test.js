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
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
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

test('xcomMesh DM unread DB: mark + read', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'mesh', 'meshTransport.js'))

  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.xcomMesh.getDmUnreadDb())), {})

  sandbox.xcomMesh._markDmUnread('meshtastic:!deadbeef', 1000)
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.xcomMesh.getDmUnreadDb())), { 'meshtastic:!deadbeef': { ts: 1000, count: 1 } })

  // Older timestamp should not reduce ts, but should increment count.
  sandbox.xcomMesh._markDmUnread('meshtastic:!deadbeef', 900)
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.xcomMesh.getDmUnreadDb())), { 'meshtastic:!deadbeef': { ts: 1000, count: 2 } })

  // Read clears.
  sandbox.xcomMesh.markDmRead('meshtastic:!deadbeef')
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.xcomMesh.getDmUnreadDb())), {})
})
