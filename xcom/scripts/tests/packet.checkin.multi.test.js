const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')
const { Buffer } = require('node:buffer')

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
    crypto: webcrypto,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    btoa(bin) {
      return Buffer.from(String(bin), 'binary').toString('base64')
    },
    atob(b64) {
      return Buffer.from(String(b64), 'base64').toString('binary')
    },
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

function approxEq(a, b, eps = 1e-5) {
  return Math.abs(Number(a) - Number(b)) <= eps
}

test('CHECKIN/LOC v1: single-unit payload stays v1', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const payload = { unitId: 12, lat: 35.12345, lon: -83.54321, status: 0, t: 1700000000123 }
  const b64 = sandbox.encodeCheckinLocClear(payload)
  const bytes = sandbox.decodeBase64Url(b64)

  assert.equal(bytes.length, 16)
  assert.equal(bytes[0], 1)

  const out = sandbox.decodeCheckinLocClear(b64)
  assert.equal(out.unitId, 12)
  assert.equal(out.unitIds, undefined)
  assert.equal(out.status, 0)
  assert.equal(approxEq(out.lat, 35.12345), true)
  assert.equal(approxEq(out.lon, -83.54321), true)
  assert.equal(out.t, Math.floor(payload.t / 60000) * 60000)
})

test('CHECKIN/LOC v2: multi-unit payload encodes/decodes unitIds', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const payload = { unitId: 12, unitIds: [12, 14, 12, 0, 65536], lat: 35.5, lon: -83.25, status: 2, t: 1700000000123 }
  const b64 = sandbox.encodeCheckinLocClear(payload)
  const bytes = sandbox.decodeBase64Url(b64)

  assert.equal(bytes[0], 2)
  assert.equal(bytes[1], 2)

  const out = sandbox.decodeCheckinLocClear(b64)
  assert.equal(out.unitId, 12)
  assert.deepEqual(Array.from(out.unitIds || []), [12, 14])
  assert.equal(out.status, 2)
  assert.equal(approxEq(out.lat, 35.5), true)
  assert.equal(approxEq(out.lon, -83.25), true)
  assert.equal(out.t, Math.floor(payload.t / 60000) * 60000)
})

test('SITREP: single-source payload stays compact (no srcIds)', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const payload = { src: 12, dst: 0, pri: 2, status: 0, t: 1700000000123 }
  const b64 = sandbox.encodeSitrepClear(payload)
  const bytes = sandbox.decodeBase64Url(b64)

  assert.equal(bytes.length, 12)
  assert.equal(bytes[11] & 4, 0)

  const out = sandbox.decodeSitrepClear(b64)
  assert.equal(out.src, 12)
  assert.equal(out.srcIds, undefined)
  assert.equal(out.t, Math.floor(payload.t / 60000) * 60000)
})

test('SITREP: multi-source payload encodes/decodes srcIds (IDs only)', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const payload = { src: 12, srcIds: [12, 14, 12, 0, 65536, 19], dst: 0, pri: 2, status: 0, t: 1700000000123 }
  const b64 = sandbox.encodeSitrepClear(payload)
  const bytes = sandbox.decodeBase64Url(b64)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  assert.equal(bytes[11] & 4, 4)
  assert.equal(bytes.length, 12 + 1 + 2 * 2)
  assert.equal(bytes[12], 2)
  assert.equal(dv.getUint16(13, false), 14)
  assert.equal(dv.getUint16(15, false), 19)

  const out = sandbox.decodeSitrepClear(b64)
  assert.equal(out.src, 12)
  assert.deepEqual(Array.from(out.srcIds || []), [12, 14, 19])
})

test('CONTACT: multi-source payload encodes/decodes srcIds', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const payload = { src: 12, srcIds: [12, 14], pri: 1, t: 1700000000123, typeCode: 7, count: 3, dir: 12 }
  const b64 = sandbox.encodeContactClear(payload)
  const bytes = sandbox.decodeBase64Url(b64)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  assert.equal(bytes.length, 13 + 1 + 2 * 1)
  assert.equal(bytes[12] & 4, 4)
  assert.equal(bytes[13], 1)
  assert.equal(dv.getUint16(14, false), 14)

  const out = sandbox.decodeContactClear(b64)
  assert.equal(out.src, 12)
  assert.deepEqual(Array.from(out.srcIds || []), [12, 14])
})

test('TASK: multi-source payload encodes/decodes srcIds', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const payload = { src: 12, srcIds: [12, 14, 19], dst: 0, pri: 2, t: 1700000000123, actionCode: 4, dueMins: 60 }
  const b64 = sandbox.encodeTaskClear(payload)
  const bytes = sandbox.decodeBase64Url(b64)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  assert.equal(bytes.length, 14 + 1 + 2 * 2)
  assert.equal(bytes[13] & 4, 4)
  assert.equal(bytes[14], 2)
  assert.equal(dv.getUint16(15, false), 14)
  assert.equal(dv.getUint16(17, false), 19)

  const out = sandbox.decodeTaskClear(b64)
  assert.equal(out.src, 12)
  assert.deepEqual(Array.from(out.srcIds || []), [12, 14, 19])
})

test('RESOURCE: multi-source payload encodes/decodes srcIds', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const payload = { src: 12, srcIds: [12, 14, 19], pri: 2, t: 1700000000123, itemCode: 9, qty: 2 }
  const b64 = sandbox.encodeResourceClear(payload)
  const bytes = sandbox.decodeBase64Url(b64)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  assert.equal(bytes.length, 12 + 1 + 2 * 2)
  assert.equal(bytes[11] & 4, 4)
  assert.equal(bytes[12], 2)
  assert.equal(dv.getUint16(13, false), 14)
  assert.equal(dv.getUint16(15, false), 19)

  const out = sandbox.decodeResourceClear(b64)
  assert.equal(out.src, 12)
  assert.deepEqual(Array.from(out.srcIds || []), [12, 14, 19])
})

test('ASSET: multi-source payload encodes/decodes srcIds', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const payload = { src: 12, srcIds: [12, 14], condition: 0, t: 1700000000123, typeCode: 9 }
  const b64 = sandbox.encodeAssetClear(payload)
  const bytes = sandbox.decodeBase64Url(b64)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  assert.equal(bytes.length, 10 + 1 + 2 * 1)
  assert.equal(bytes[9] & 8, 8)
  assert.equal(bytes[10], 1)
  assert.equal(dv.getUint16(11, false), 14)

  const out = sandbox.decodeAssetClear(b64)
  assert.equal(out.src, 12)
  assert.deepEqual(Array.from(out.srcIds || []), [12, 14])
})

test('ZONE: multi-source payload encodes/decodes srcIds', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const payload = {
    src: 12,
    srcIds: [12, 14, 19],
    t: 1700000000123,
    threat: 0,
    meaningCode: 1,
    shape: { kind: 'circle', centerLat: 35.5, centerLon: -83.25, radiusM: 150 },
  }
  const b64 = sandbox.encodeZoneClear(payload)
  const bytes = sandbox.decodeBase64Url(b64)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  assert.equal(bytes.length, 10 + 10 + 1 + 2 * 2)
  assert.equal(bytes[9] & 8, 8)
  assert.equal(bytes[20], 2)
  assert.equal(dv.getUint16(21, false), 14)
  assert.equal(dv.getUint16(23, false), 19)

  const out = sandbox.decodeZoneClear(b64)
  assert.equal(out.src, 12)
  assert.deepEqual(Array.from(out.srcIds || []), [12, 14, 19])
})

test('srcIds: caps multi-source tagging to 32 unit IDs', () => {
  const sandbox = makeSandbox()
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'base64url.js'))
  runScriptFile(sandbox, fromRepoRoot('modules', 'shared', 'xtoc', 'packet.js'))

  const srcIds = [12, ...Array.from({ length: 100 }, (_, i) => i + 1)]
  const payload = { src: 12, srcIds, dst: 0, pri: 2, status: 0, t: 1700000000123 }
  const out = sandbox.decodeSitrepClear(sandbox.encodeSitrepClear(payload))
  assert.equal(out.src, 12)
  assert.equal(Array.from(out.srcIds || []).length, 32)
  assert.equal(Array.from(out.srcIds || [])[0], 12)
})
