import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCoverage } from '../../scripts/lib/coverage-model.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cov-'))
  mkdirSync(join(root, 'reports/coverage'), { recursive: true })
  const report = {
    [join(root, 'packages/kestrel-core/src/a.ts')]: {
      path: join(root, 'packages/kestrel-core/src/a.ts'),
      statementMap: {},
      s: {},
      fnMap: {
        0: { name: 'ran', decl: { start: { line: 10 } }, loc: { start: { line: 10 } } },
        1: { name: 'never', decl: { start: { line: 20 } }, loc: { start: { line: 20 } } },
      },
      f: { 0: 3, 1: 0 },
      branchMap: {
        0: { type: 'if', line: 11, locations: [{ start: { line: 11 } }, { start: { line: 13 } }] },
      },
      b: { 0: [3, 0] },
    },
  }
  writeFileSync(join(root, 'reports/coverage/coverage-final.json'), JSON.stringify(report))
  return root
}

describe('coverage-model', () => {
  it('returns null when the report is absent', () => {
    expect(loadCoverage(mkdtempSync(join(tmpdir(), 'empty-')))).toBeNull()
  })

  it('reports the line of a branch arm that was never taken', () => {
    const cov = loadCoverage(fixture())
    const file = 'packages/kestrel-core/src/a.ts'
    expect(cov.has(file)).toBe(true)
    expect([...cov.missedBranchLines(file)]).toEqual([13])
    expect(cov.branchMissCount(file)).toBe(1)
  })

  it('reports only the functions that actually ran', () => {
    const cov = loadCoverage(fixture())
    const file = 'packages/kestrel-core/src/a.ts'
    expect([...cov.ranFunctionLines(file)]).toEqual([10])
  })

  it('keys files relative to the repo root', () => {
    const cov = loadCoverage(fixture())
    expect(cov.files).toEqual(['packages/kestrel-core/src/a.ts'])
  })
})
