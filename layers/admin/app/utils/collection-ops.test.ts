import { describe, it, expect } from 'vitest'
import { buildDeleteReport } from './collection-ops'

describe('buildDeleteReport', () => {
  it('counts the deletion and flags only the referenced rows, in input order', () => {
    const report = buildDeleteReport([3, 1, 2], { '1': 2, '3': 0, '2': 5 }, true)
    expect(report.count).toBe(3)
    expect(report.referencedCount).toBe(2)
    expect(report.referenced).toEqual([{ id: 1, referrers: 2 }, { id: 2, referrers: 5 }])
  })

  it('reports zero referenced when the counts map is empty or all zero', () => {
    expect(buildDeleteReport([1, 2], {}, true)).toEqual({ count: 2, referencedCount: 0, referenced: [], checked: true })
    expect(buildDeleteReport([1, 2], { '1': 0, '2': 0 }, true)).toEqual({ count: 2, referencedCount: 0, referenced: [], checked: true })
  })

  it('handles an empty selection', () => {
    expect(buildDeleteReport([], { '9': 3 }, true)).toEqual({ count: 0, referencedCount: 0, referenced: [], checked: true })
  })

  it('carries the lookup outcome through instead of asserting the check ran', () => {
    // The dialog distinguishes "checked, nothing links here" from "could not check", so an empty counts map
    // from a FAILED lookup must stay flagged unverified rather than read as a verified-safe delete.
    expect(buildDeleteReport([1, 2], {}, false).checked).toBe(false)
    expect(buildDeleteReport([1, 2], {}, true).checked).toBe(true)
  })
})
