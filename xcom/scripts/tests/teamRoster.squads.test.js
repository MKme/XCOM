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

test('Team roster squads: upsertSquads stores + lists normalized squads', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'teamRoster.js'))

  assert.equal(sandbox.xcomListSquads().length, 0)

  const res = sandbox.xcomUpsertSquads(
    [
      { id: ' alpha ', name: ' Alpha ', callsign: 'A-1', primaryRadio: '146.520', leaderUnitId: 12 },
      { id: 'bad', name: '' }, // ignored
      null, // ignored
    ],
    { replace: true },
  )
  assert.equal(res.ok, true)
  assert.equal(res.total, 1)

  const squads = sandbox.xcomListSquads()
  assert.equal(squads.length, 1)
  assert.equal(squads[0].id, 'alpha')
  assert.equal(squads[0].name, 'Alpha')
  assert.equal(squads[0].callsign, 'A-1')
  assert.equal(squads[0].primaryRadio, '146.520')
  assert.equal(squads[0].leaderUnitId, 12)
})

test('Team roster squads: squads persist when upserting roster members', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'teamRoster.js'))

  sandbox.xcomUpsertSquads([{ id: 's1', name: 'Alpha' }], { replace: true })
  sandbox.xcomUpsertRosterMembers([{ unitId: 12, label: 'U12 TEST', squadId: 's1' }], { replace: true })

  const store = sandbox.xcomGetTeamRoster()
  assert.equal(Array.isArray(store.squads), true)
  assert.equal(store.squads.length, 1)
  assert.equal(store.squads[0].id, 's1')
  assert.equal(store.squads[0].name, 'Alpha')
})

test('Team roster squads: member squadId is normalized and preserved', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'teamRoster.js'))

  sandbox.xcomUpsertSquads([{ id: 's1', name: 'Alpha' }], { replace: true })
  sandbox.xcomUpsertRosterMembers([{ unitId: 12, label: 'Test', squadId: ' s1 ' }], { replace: true })

  const members = sandbox.xcomListRosterMembers()
  assert.equal(members.length, 1)
  assert.equal(members[0].unitId, 12)
  assert.equal(members[0].squadId, 's1')
})
