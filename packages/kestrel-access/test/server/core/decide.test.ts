import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Effect } from 'effect'
import { decide, type PolicyRow, type PolicyTable } from '../../../src/server/core/decide.js'

// PolicyTable design:
//   PolicyRow { role, action, resource }  — resource '*' matches any resource.
//   action is 'read' | 'read:all' | 'write' — 'read' is published-scope read (what
//   an anonymous visitor/renderer gets), 'read:all' is the draft/full-scope read
//   that today's `readScope: 'all'` represents. Splitting scope into its own action
//   lets `decide` stay a plain allow/deny predicate while still being askable
//   "would this principal get draft access".
// facts.publicResources is the registry-driven set of resources open to anonymous
// published-read (mirrors `publicResources` / `spec.public` in the current shell).

const ROLES = ['admin', 'renderer', 'anonymous', 'editor'] as const
const ACTIONS = ['read', 'read:all', 'write'] as const

const roleArb = fc.constantFrom(...ROLES)
const nonAdminRoleArb = fc.constantFrom(...ROLES.filter((r) => r !== 'admin'))
const actionArb = fc.constantFrom(...ACTIONS)
const resourceArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s !== '*')
const principalArb = fc.record({ userId: fc.option(fc.string(), { nil: null }), role: roleArb })
const nonAdminPrincipalArb = fc.record({ userId: fc.option(fc.string(), { nil: null }), role: nonAdminRoleArb })

const policyRowArb: fc.Arbitrary<PolicyRow> = fc.record({
  role: roleArb,
  action: actionArb,
  resource: fc.oneof(resourceArb, fc.constant('*')),
})
const policyTableArb: fc.Arbitrary<PolicyTable> = fc.array(policyRowArb, { maxLength: 8 })
const factsArb = fc.record({ publicResources: fc.array(resourceArb, { maxLength: 5 }) })

// A default table mirroring today's hardcoded POLICY (see layers/access/server/utils/policy.ts):
// admin gets everything including draft-read, renderer only published read.
const DEFAULT_TABLE: PolicyTable = [
  { role: 'admin', action: 'read', resource: '*' },
  { role: 'admin', action: 'read:all', resource: '*' },
  { role: 'admin', action: 'write', resource: '*' },
  { role: 'renderer', action: 'read', resource: '*' },
]

function runDecide(...args: Parameters<typeof decide>) {
  return Effect.runSyncExit(decide(...args))
}

describe('decide — mandatory invariant: no non-admin ever gets read:all on a non-public resource', () => {
  it('denies read:all for a non-admin on a resource outside facts.publicResources, for any table', () => {
    fc.assert(fc.property(nonAdminPrincipalArb, resourceArb, policyTableArb, (principal, resource, table) => {
      const facts = { publicResources: [] as string[] } // resource is guaranteed absent from an empty set
      const exit = runDecide(principal, 'read:all', resource, facts, table)
      expect(exit._tag).toBe('Success')
      if (exit._tag === 'Success') expect(exit.value).toBe('deny')
    }))
  })

  it('still denies even when the table explicitly grants read:all to the non-admin role for that exact resource', () => {
    fc.assert(fc.property(nonAdminPrincipalArb, resourceArb, (principal, resource) => {
      const facts = { publicResources: [] as string[] }
      const table: PolicyTable = [{ role: principal.role, action: 'read:all', resource }, { role: principal.role, action: 'read:all', resource: '*' }]
      const exit = runDecide(principal, 'read:all', resource, facts, table)
      expect(exit._tag).toBe('Success')
      if (exit._tag === 'Success') expect(exit.value).toBe('deny')
    }))
  })
})

describe('decide — default-deny', () => {
  it('an empty policy table denies every action for any non-admin principal', () => {
    fc.assert(fc.property(nonAdminPrincipalArb, actionArb, resourceArb, factsArb, (principal, action, resource, facts) => {
      // an anonymous published-read the facts explicitly grant is the one legitimate exception
      fc.pre(!(principal.role === 'anonymous' && action === 'read' && facts.publicResources.includes(resource)))
      const exit = runDecide(principal, action, resource, facts, [])
      expect(exit._tag).toBe('Success')
      if (exit._tag === 'Success') expect(exit.value).toBe('deny')
    }))
  })
})

describe('decide — admin-role totality', () => {
  it('admin is allowed read, read:all and write on any resource, given the standard default table', () => {
    fc.assert(fc.property(actionArb, resourceArb, (action, resource) => {
      const principal = { userId: 'admin-1', role: 'admin' as const }
      const exit = runDecide(principal, action, resource, { publicResources: [] }, DEFAULT_TABLE)
      expect(exit._tag).toBe('Success')
      if (exit._tag === 'Success') expect(exit.value).toBe('allow')
    }))
  })
})

describe('decide — anonymous published-read on public resources', () => {
  it('anonymous may read any resource that facts.publicResources names, with no table rows at all', () => {
    fc.assert(fc.property(resourceArb, (resource) => {
      const principal = { userId: null, role: 'anonymous' as const }
      const exit = runDecide(principal, 'read', resource, { publicResources: [resource] }, [])
      expect(exit._tag).toBe('Success')
      if (exit._tag === 'Success') expect(exit.value).toBe('allow')
    }))
  })

  it('anonymous may never draft-read (read:all) a public resource just because it is public', () => {
    fc.assert(fc.property(resourceArb, (resource) => {
      const principal = { userId: null, role: 'anonymous' as const }
      const exit = runDecide(principal, 'read:all', resource, { publicResources: [resource] }, [])
      expect(exit._tag).toBe('Success')
      if (exit._tag === 'Success') expect(exit.value).toBe('deny')
    }))
  })

  it('a resource NOT in the public set is denied to anonymous read, absent any grant row', () => {
    fc.assert(fc.property(resourceArb, (resource) => {
      const principal = { userId: null, role: 'anonymous' as const }
      const exit = runDecide(principal, 'read', resource, { publicResources: [] }, [])
      expect(exit._tag).toBe('Success')
      if (exit._tag === 'Success') expect(exit.value).toBe('deny')
    }))
  })
})

describe('decide — monotonicity: adding a policy row never revokes an existing allow', () => {
  it('decide(..., table) === allow implies decide(..., table + extraRow) === allow', () => {
    fc.assert(fc.property(principalArb, actionArb, resourceArb, factsArb, policyTableArb, policyRowArb, (principal, action, resource, facts, table, extra) => {
      const before = runDecide(principal, action, resource, facts, table)
      const after = runDecide(principal, action, resource, facts, [...table, extra])
      fc.pre(before._tag === 'Success' && after._tag === 'Success')
      if (before._tag === 'Success' && after._tag === 'Success' && before.value === 'allow') {
        expect(after.value).toBe('allow')
      }
    }))
  })
})

describe('decide — purity / determinism', () => {
  it('called twice with the same inputs always gives the same result', () => {
    fc.assert(fc.property(principalArb, actionArb, resourceArb, factsArb, policyTableArb, (principal, action, resource, facts, table) => {
      const first = runDecide(principal, action, resource, facts, table)
      const second = runDecide(principal, action, resource, facts, table)
      expect(first).toEqual(second)
    }))
  })
})

// Deterministic characterization tests pin exact row-matching semantics that the property arbitraries
// rarely exercise (a specific non-wildcard resource, a mismatched action) so the pure core's branches are
// actually covered, not just its outcomes.
describe('decide — row matching semantics', () => {
  it('denies when the role matches but the action does not', () => {
    const table: PolicyTable = [{ role: 'admin', action: 'read', resource: 'x' }]
    const exit = runDecide({ userId: 'a', role: 'admin' }, 'write', 'x', { publicResources: [] }, table)
    expect(exit._tag).toBe('Success')
    if (exit._tag === 'Success') expect(exit.value).toBe('deny')
  })

  it('denies when the row names a different, non-wildcard resource', () => {
    const table: PolicyTable = [{ role: 'admin', action: 'write', resource: 'a' }]
    const exit = runDecide({ userId: 'a', role: 'admin' }, 'write', 'b', { publicResources: [] }, table)
    expect(exit._tag).toBe('Success')
    if (exit._tag === 'Success') expect(exit.value).toBe('deny')
  })

  it('allows when the row names the exact requested resource (no wildcard involved)', () => {
    const table: PolicyTable = [{ role: 'admin', action: 'write', resource: 'exact' }]
    const exit = runDecide({ userId: 'a', role: 'admin' }, 'write', 'exact', { publicResources: [] }, table)
    expect(exit._tag).toBe('Success')
    if (exit._tag === 'Success') expect(exit.value).toBe('allow')
  })

  it('the public-read grant applies only to the anonymous role, never another role', () => {
    const exit = runDecide({ userId: null, role: 'renderer' }, 'read', 'pub', { publicResources: ['pub'] }, [])
    expect(exit._tag).toBe('Success')
    if (exit._tag === 'Success') expect(exit.value).toBe('deny')
  })

  it('denies when the resource and action match but the row names a different role', () => {
    const table: PolicyTable = [{ role: 'editor', action: 'write', resource: 'x' }]
    const exit = runDecide({ userId: 'r', role: 'renderer' }, 'write', 'x', { publicResources: [] }, table)
    expect(exit._tag).toBe('Success')
    if (exit._tag === 'Success') expect(exit.value).toBe('deny')
  })

  it('the public-read grant applies only to the read action, never write', () => {
    const exit = runDecide({ userId: null, role: 'anonymous' }, 'write', 'pub', { publicResources: ['pub'] }, [])
    expect(exit._tag).toBe('Success')
    if (exit._tag === 'Success') expect(exit.value).toBe('deny')
  })
})

describe('decide — totality (never throws, error channel is `never`)', () => {
  const messyPrincipalArb = fc.record({
    userId: fc.oneof(fc.string(), fc.constant(null)),
    role: fc.oneof(...ROLES.map((r) => fc.constant(r)), fc.string()),
  })
  const messyResourceArb = fc.oneof(fc.string({ maxLength: 20 }), fc.constant(''), fc.constant('*'), fc.string({ maxLength: 10, unit: 'grapheme' }))

  it('never throws and always exits Success for arbitrary (within-type) inputs, including empty/wildcard resources and unknown roles', () => {
    fc.assert(fc.property(messyPrincipalArb, actionArb, messyResourceArb, factsArb, policyTableArb, (principal, action, resource, facts, table) => {
      let exit: ReturnType<typeof runDecide> | undefined
      expect(() => { exit = runDecide(principal as never, action, resource, facts, table) }).not.toThrow()
      expect(exit!._tag).toBe('Success')
    }))
  })
})
