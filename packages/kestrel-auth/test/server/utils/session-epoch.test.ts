import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentSessionEpoch, bumpSessionEpoch, _resetSessionEpochCache } from '../../../src/server/utils/session-epoch.js'
import { getResolvedKestrelConfig, setResolvedKestrelConfig } from '@michaelthielemann/kestrel-core'

let dir: string
const ORIG = { ...process.env }
const ORIG_CONFIG = getResolvedKestrelConfig()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kestrel-epoch-'))
  process.env = { ...ORIG }
  _resetSessionEpochCache()
})
afterEach(() => {
  process.env = { ...ORIG }
  setResolvedKestrelConfig(ORIG_CONFIG)
  _resetSessionEpochCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('readEpoch — corrupted / malformed file (L12 branches)', () => {
  const cases: Array<[string, string]> = [
    ['empty file', ''],
    ['whitespace only', '   \n'],
    ['non-numeric', 'not-a-number'],
    ['negative', '-5'],
    ['NaN literal', 'NaN'],
  ]
  for (const [label, content] of cases) {
    it(`falls back to the baseline 0 for a ${label}`, () => {
      const file = join(dir, 'e')
      writeFileSync(file, content, 'utf8')
      process.env.KESTREL_SESSION_EPOCH_FILE = file
      _resetSessionEpochCache()
      expect(currentSessionEpoch()).toBe(0)
    })
  }

  it('parses a valid trailing-whitespace value', () => {
    const file = join(dir, 'e')
    writeFileSync(file, ' 42\n', 'utf8')
    process.env.KESTREL_SESSION_EPOCH_FILE = file
    _resetSessionEpochCache()
    expect(currentSessionEpoch()).toBe(42)
  })
})

describe('epochPath — derivation (L12)', () => {
  it('an in-memory DB with no override → no persistence, epoch stays in-process only', () => {
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: ':memory:' })
    delete process.env.KESTREL_SESSION_EPOCH_FILE
    _resetSessionEpochCache()
    expect(currentSessionEpoch()).toBe(0)
    bumpSessionEpoch()
    expect(currentSessionEpoch()).toBe(1) // in-process bump works with no file
  })

  it('persists beside the resolved config\'s dbPath', () => {
    const consumerDir = join(dir, 'consumer')
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: join(consumerDir, 'site.sqlite') })
    delete process.env.KESTREL_SESSION_EPOCH_FILE
    _resetSessionEpochCache()

    bumpSessionEpoch()

    expect(readFileSync(join(consumerDir, '.kestrel-session-epoch'), 'utf8')).toBe('1')
  })

  it('the explicit override file wins over the DB-derived path', () => {
    const file = join(dir, 'override')
    writeFileSync(file, '7', 'utf8')
    setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), dbPath: join(dir, 'app.sqlite') }) // would derive .kestrel-session-epoch beside it
    process.env.KESTREL_SESSION_EPOCH_FILE = file
    _resetSessionEpochCache()
    expect(currentSessionEpoch()).toBe(7) // read the override, not the (absent) beside-DB file
  })
})

describe('readEpoch — does not regress a higher in-process epoch on a corrupted/unreadable file', () => {
  it('keeps the last known epoch when the file becomes non-numeric after a bump (e.g. a crash mid-write)', () => {
    const file = join(dir, 'e')
    process.env.KESTREL_SESSION_EPOCH_FILE = file
    _resetSessionEpochCache()
    writeFileSync(file, '5', 'utf8')
    expect(currentSessionEpoch()).toBe(5)

    writeFileSync(file, 'not-a-number', 'utf8')
    const future = Date.now() / 1000 + 5
    utimesSync(file, future, future)

    expect(currentSessionEpoch()).toBe(5) // must not silently drop back to 0
  })

  it('keeps the last known epoch when the file goes empty after a bump (a truncate-then-write crash)', () => {
    const file = join(dir, 'e')
    process.env.KESTREL_SESSION_EPOCH_FILE = file
    _resetSessionEpochCache()
    writeFileSync(file, '3', 'utf8')
    expect(currentSessionEpoch()).toBe(3)

    writeFileSync(file, '', 'utf8')
    const future = Date.now() / 1000 + 5
    utimesSync(file, future, future)

    expect(currentSessionEpoch()).toBe(3)
  })
})

describe('cross-process reread (mtime-validated cache)', () => {
  it('observes a sibling process\'s bump on the next call (no restart needed)', () => {
    const file = join(dir, 'e')
    process.env.KESTREL_SESSION_EPOCH_FILE = file
    _resetSessionEpochCache()
    expect(currentSessionEpoch()).toBe(0) // absent → 0, cached

    // a SIBLING process writes a higher epoch (bump this file's mtime forward to be unambiguous)
    writeFileSync(file, '9', 'utf8')
    const future = Date.now() / 1000 + 5
    utimesSync(file, future, future)

    expect(currentSessionEpoch()).toBe(9) // re-read because the mtime moved — not the stale cached 0
  })

  it('does not adopt a content change that leaves the mtime unchanged (mtime is the invalidation signal)', () => {
    const file = join(dir, 'e')
    const stamp = Date.now() / 1000 - 100
    writeFileSync(file, '3', 'utf8')
    utimesSync(file, stamp, stamp)
    process.env.KESTREL_SESSION_EPOCH_FILE = file
    _resetSessionEpochCache()
    expect(currentSessionEpoch()).toBe(3) // caches value 3 at mtime `stamp`

    // rewrite the content but restore the SAME mtime → the cache treats the file as unchanged
    writeFileSync(file, '999', 'utf8')
    utimesSync(file, stamp, stamp)
    expect(currentSessionEpoch()).toBe(3) // still the cached 3, not the rewritten 999
  })
})
