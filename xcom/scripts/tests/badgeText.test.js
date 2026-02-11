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

test('xcomBadgeTextFromLabel: prefers tactical callsign token (keeps hyphen + digits)', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'teamRoster.js'))

  assert.equal(sandbox.xcomBadgeTextFromLabel('D-0 LORD'), 'D-0')
  assert.equal(sandbox.xcomBadgeTextFromLabel('D0 LORD'), 'D0')
  assert.equal(sandbox.xcomBadgeTextFromLabel('D-10 LORD'), 'D-10')
})

test('xcomBadgeTextFromLabel: finds callsign not in first token', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'teamRoster.js'))

  assert.equal(sandbox.xcomBadgeTextFromLabel('ASG D-0 [LORD]'), 'D-0')
})

test('xcomBadgeTextFromLabel: ignores unit tokens when callsign exists', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'teamRoster.js'))

  assert.equal(sandbox.xcomBadgeTextFromLabel('U12 (D-0 LORD)'), 'D-0')
})

test('xcomBadgeTextFromLabel: falls back to initials', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'teamRoster.js'))

  assert.equal(sandbox.xcomBadgeTextFromLabel('Eric Lord'), 'EL')
  assert.equal(sandbox.xcomBadgeTextFromLabel('LORD'), 'LO')
})

