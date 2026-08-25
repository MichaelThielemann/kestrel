import type { Grant, Role } from './policy.js'

// A process-singleton registry of EXTRA authorization grants, contributed by layers/extensions at boot
// (server plugin) on top of the hardcoded `POLICY`. This is the seam that lets an opt-in layer deliberately
// open a narrow hole in the default-deny guard — e.g. the proofing extension granting `anonymous → write →
// proofing` for its public back-channel. Inert until something registers: with an empty registry the guard
// behaves exactly as the hardcoded policy. The map is INJECTED into the (pure) guard, not read from inside
// it (symmetric with `publicResources`), so the policy stays deterministically node-testable. Foundation
// for a future configurable Users & Roles system.
const registered: Partial<Record<Role, Grant[]>> = {}

/** Add an extra grant for a role. Deliberate + explicit — it widens what that role may do.
 * @public
 */
export function registerAccessGrant(role: Role, grant: Grant): void {
  // Defense-in-depth: the public (anonymous) must never be handed a wildcard through this seam — a
  // legitimate public back-channel always names ONE specific resource.
  if (role === 'anonymous' && grant.resource === '*') {
    throw new Error(`refusing an over-broad anonymous grant (${grant.action} ${grant.resource}): name a specific resource`)
  }
  // The evaluator (`decide`) hard-limits EVERY non-admin role's read:all to deny, unconditionally — no
  // policy row, explicit scope, or omitted scope can widen it. So a non-admin read grant must set
  // `scope: 'published'` explicitly: an omitted scope or an explicit 'all' would silently mean 'published'
  // instead of what it looks like.
  if (role !== 'admin' && grant.action === 'read' && (grant.scope ?? 'all') === 'all') {
    throw new Error(`refusing a non-admin read grant for role "${role}" without an explicit scope: 'published' (${grant.action} ${grant.resource}${grant.scope ? ` scope=${grant.scope}` : ''}): every non-admin role is read-limited to published content, so an omitted or 'all' scope would silently mean something other than what it says`)
  }
  (registered[role] ??= []).push(grant)
}

/** The full role → extra-grants map, for the guard to consult alongside `POLICY`.
 * @public
 */
export function registeredGrants(): Readonly<Partial<Record<Role, Grant[]>>> {
  return registered
}

/** Test helper: drop all registered grants (the registry is a module singleton).
 * @public
 */
export function clearAccessGrants(): void {
  for (const role of Object.keys(registered) as Role[]) Reflect.deleteProperty(registered, role)
}
