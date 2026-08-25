import { describe, it, expect } from 'vitest'
import { mergeCoverage } from '../../scripts/coverage-all.mjs'

const part = (path: string, s: Record<string, number>, f: Record<string, number>) => ({
  [path]: {
    path,
    statementMap: Object.fromEntries(Object.keys(s).map((k) => [k, { start: { line: Number(k) + 1 } }])),
    fnMap: Object.fromEntries(Object.keys(f).map((k) => [k, { decl: { start: { line: Number(k) + 10 } } }])),
    branchMap: {},
    s, f, b: {},
  },
})

describe('mergeCoverage', () => {
  it('takes an entry present in only one part', () => {
    const out = mergeCoverage([part('/a.ts', { 0: 1 }, { 0: 2 })])
    expect(out['/a.ts'].f).toEqual({ 0: 2 })
  })

  it('sums counters when the maps agree', () => {
    const out = mergeCoverage([part('/a.ts', { 0: 1 }, { 0: 2 }), part('/a.ts', { 0: 3 }, { 0: 4 })])
    expect(out['/a.ts'].s).toEqual({ 0: 4 })
    expect(out['/a.ts'].f).toEqual({ 0: 6 })
  })

  it('keeps the richer entry and records a conflict when the maps disagree', () => {
    const a = part('/a.ts', { 0: 1 }, { 0: 0 })
    const b = part('/a.ts', { 0: 1, 1: 1 }, { 0: 5 })
    const conflicts: string[] = []
    const out = mergeCoverage([a, b], conflicts)
    expect(out['/a.ts'].f).toEqual({ 0: 5 })
    expect(conflicts).toEqual(['/a.ts'])
  })

  it('never mutates its input parts', () => {
    const a = part('/a.ts', { 0: 1 }, { 0: 2 })
    mergeCoverage([a, part('/a.ts', { 0: 3 }, { 0: 4 })])
    expect(a['/a.ts'].s).toEqual({ 0: 1 })
  })
})
