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
    location: { href: 'https://xcom.local/', origin: 'https://xcom.local' },
    URL,
    Request,
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

test('Forced Offline setting persists in localStorage', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))

  assert.equal(sandbox.getForcedOfflineEnabled(), false)

  sandbox.setForcedOfflineEnabled(true)
  assert.equal(sandbox.getForcedOfflineEnabled(), true)
  assert.equal(sandbox.localStorage.getItem('xtoc.forcedOffline'), '1')

  sandbox.setForcedOfflineEnabled(false)
  assert.equal(sandbox.getForcedOfflineEnabled(), false)
  assert.equal(sandbox.localStorage.getItem('xtoc.forcedOffline'), null)
})

test('Forced Offline guard blocks external fetch calls (cache-only)', async () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'settings.js'))

  const calls = []
  sandbox.fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
    calls.push(url)
    return { ok: true, url }
  }

  sandbox.caches = {
    async match(req) {
      if (String(req && req.url) === 'https://cached.example.com/') return { ok: true, cached: true }
      return undefined
    },
  }

  sandbox.installForcedOfflineNetworkGuards()

  sandbox.setForcedOfflineEnabled(false)
  await sandbox.fetch('https://example.com/ok')
  assert.equal(calls.length, 1)

  sandbox.setForcedOfflineEnabled(true)

  const cached = await sandbox.fetch('https://cached.example.com/')
  assert.deepEqual(cached, { ok: true, cached: true })

  await assert.rejects(() => sandbox.fetch('https://example.com/blocked'), /Forced offline/i)
  assert.equal(calls.some((u) => u.includes('/blocked')), false)

  await sandbox.fetch('/api/status')
  assert.equal(calls.some((u) => u === '/api/status'), true)
})

