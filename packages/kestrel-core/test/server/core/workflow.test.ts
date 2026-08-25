import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { canTransition, transitions, type GuardName, type Status } from '../../../src/server/core/workflow.js'

// Today's collection statuses are exactly 'draft' | 'published' (buildCollection.ts's
// z.enum(['draft', 'published'])); the table below expresses only the moves the running
// code actually performs. Self-pairs (draft->draft, published->published) are legal
// no-op rows, each gated by the same guard as the real transition to that target —
// see the "self-pairs" tests.
const STATUSES = ['draft', 'published'] as const satisfies readonly Status[]
const statusArb = fc.constantFrom(...STATUSES)

// All (from, to) pairs NOT present as a row in `transitions`, for the given table.
function illegalPairs(table: ReadonlyArray<{ from: Status, to: Status }>): Array<[Status, Status]> {
  const legal = new Set(table.map((r) => `${r.from}>${r.to}`))
  const out: Array<[Status, Status]> = []
  for (const from of STATUSES) for (const to of STATUSES) if (!legal.has(`${from}>${to}`)) out.push([from, to])
  return out
}

const guardResultsArb = fc.dictionary(fc.string(), fc.boolean())

describe('transitions table shape', () => {
  it('contains only rows over the closed Status union', () => {
    for (const row of transitions) {
      expect(STATUSES).toContain(row.from)
      expect(STATUSES).toContain(row.to)
    }
  })

  it('has no duplicate (from, to) row', () => {
    const seen = new Set<string>()
    for (const row of transitions) {
      const key = `${row.from}>${row.to}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
})

describe('canTransition — reachability is a chain of table rows', () => {
  it('every canTransition-approved step in a random walk corresponds to a row in `transitions`', () => {
    fc.assert(fc.property(
      statusArb,
      fc.array(fc.record({ to: statusArb, guardResults: guardResultsArb }), { maxLength: 12 }),
      (start, moves) => {
        let current = start
        for (const move of moves) {
          const approved = canTransition(current, move.to, move.guardResults as Partial<Record<GuardName, boolean>>)
          if (approved) {
            const hasRow = transitions.some((r) => r.from === current && r.to === move.to)
            expect(hasRow).toBe(true)
            current = move.to
          }
        }
      },
    ))
  })

  it('walking only rows that are actually in the table stays approved end to end, given passing guards', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...transitions), { maxLength: 10 }), (path) => {
      const passingGuards = Object.fromEntries(
        transitions.flatMap((r) => (r.guard ? [[r.guard, true]] : [])),
      ) as Partial<Record<GuardName, boolean>>
      for (const row of path) expect(canTransition(row.from, row.to, passingGuards)).toBe(true)
    }))
  })
})

describe('canTransition — illegal transitions', () => {
  // Self-pairs are legal no-op rows (see the file-header note), so with only two statuses every
  // (from, to) pair is present in `transitions` — there is no pair left for `illegalPairs` to produce.
  it('has a row for every (from, to) pair over the closed Status union — none is absent', () => {
    expect(illegalPairs(transitions)).toEqual([])
  })

  it('accepts self-pairs as legal no-ops, gated by the same guard as any other row to that target', () => {
    // published->published mirrors draft->published: still gated by conditionsValid.
    expect(canTransition('published', 'published', {})).toBe(false)
    expect(canTransition('published', 'published', { conditionsValid: true })).toBe(true)
    // draft->draft mirrors published->draft: never blocked by a guard.
    expect(canTransition('draft', 'draft', {})).toBe(true)
  })

  it('a made-up status is unrepresentable at the type level', () => {
    // @ts-expect-error 'archived' is not a member of the closed Status union
    const bogus: Status = 'archived'
    expect(canTransition('draft', bogus, {})).toBe(false)
  })
})

describe('canTransition — guards', () => {
  it('a row with a guard requires guardResults[guard] === true to approve', () => {
    const guarded = transitions.filter((r): r is typeof r & { guard: GuardName } => r.guard !== undefined)
    fc.assert(fc.property(fc.constantFrom(...guarded), guardResultsArb, (row, extra) => {
      const passing = { ...extra, [row.guard]: true }
      expect(canTransition(row.from, row.to, passing as Partial<Record<GuardName, boolean>>)).toBe(true)
    }))
  })

  it('a false or missing guard result denies the transition, never throws', () => {
    const guarded = transitions.filter((r): r is typeof r & { guard: GuardName } => r.guard !== undefined)
    for (const row of guarded) {
      expect(canTransition(row.from, row.to, { [row.guard]: false })).toBe(false)
      expect(canTransition(row.from, row.to, {})).toBe(false)
    }
  })

  it('a row without a guard is approved regardless of guardResults content', () => {
    const unguarded = transitions.filter((r) => r.guard === undefined)
    fc.assert(fc.property(fc.constantFrom(...unguarded), guardResultsArb, (row, guardResults) => {
      expect(canTransition(row.from, row.to, guardResults as Partial<Record<GuardName, boolean>>)).toBe(true)
    }))
  })
})

describe('canTransition — determinism and totality', () => {
  it('is deterministic: same inputs always give the same result', () => {
    fc.assert(fc.property(statusArb, statusArb, guardResultsArb, (from, to, guardResults) => {
      const typed = guardResults as Partial<Record<GuardName, boolean>>
      expect(canTransition(from, to, typed)).toBe(canTransition(from, to, typed))
    }))
  })

  it('never throws for arbitrary in-type inputs, including an empty or messy guardResults object', () => {
    const messyGuardResultsArb = fc.dictionary(fc.string(), fc.oneof(fc.boolean(), fc.constant(undefined)))
    fc.assert(fc.property(statusArb, statusArb, messyGuardResultsArb, (from, to, guardResults) => {
      expect(() => canTransition(from, to, guardResults as Partial<Record<GuardName, boolean>>)).not.toThrow()
    }))
  })

  it('is total over a fully empty guardResults object for every status pair', () => {
    for (const from of STATUSES) for (const to of STATUSES) {
      expect(() => canTransition(from, to, {})).not.toThrow()
    }
  })
})

// Today's real semantics, pinned as examples: each row's legality is sourced from the running code,
// not invented.
describe('canTransition — pinned examples from today\'s behavior', () => {
  it('draft -> published (publish) requires the conditions guard to pass', () => {
    expect(canTransition('draft', 'published', { conditionsValid: true })).toBe(true)
    expect(canTransition('draft', 'published', { conditionsValid: false })).toBe(false)
    expect(canTransition('draft', 'published', {})).toBe(false)
  })

  it('published -> draft (unpublish) is never blocked by a guard', () => {
    expect(canTransition('published', 'draft', {})).toBe(true)
    expect(canTransition('published', 'draft', { conditionsValid: false })).toBe(true)
  })
})
