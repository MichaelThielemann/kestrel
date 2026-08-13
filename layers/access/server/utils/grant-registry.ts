import type { Grant, Role } from './policy'

// A process-singleton registry of EXTRA authorization grants, contributed by layers/extensions at boot
// (server plugin) on top of the hardcoded `POLICY`. This is the seam that lets an opt-in layer deliberately
// open a narrow hole in the default-deny guard — e.g. the proofing extension granting `anonymous → write →
// proofing` for its public back-channel. Inert until something registers: with an empty registry the guard
// behaves exactly as the hardcoded policy. The map is INJECTED into the (pure) guard, not read from inside
// it (symmetric with `publicResources`), so the policy stays deterministically node-testable. Foundation
// for a future configurable Users & Roles system.
const registered: Partial<Record<Role, Grant[]>> = {}

/** Add an extra grant for a role. Deliberate + explicit — it widens what that role may do. */
export function registerAccessGrant(role: Role, grant: Grant): void {
  // Defense-in-depth: the public (anonymous) must never be handed a wildcard or draft-read through this
  // seam — a legitimate public back-channel always names ONE specific resource and reads published-only.
  // CRUCIAL: the evaluator (`resolveAccess`) defaults an OMITTED read scope to 'all' via `(scope ?? 'all')`,
  // so an unscoped anonymous read would silently resolve to draft-read. The validator must use the SAME
  // default, or a "safe"-looking `{action:'read', resource:'x'}` grant leaks drafts to anonymous visitors.
  // (Write grants carry no read scope — `resolveAccess` only upgrades readScope for read grants — so an
  // omitted scope on a write is fine, e.g. the proofing back-channel's anonymous write.)
  const anonymousDraftRead = role === 'anonymous' && grant.action === 'read' && (grant.scope ?? 'all') === 'all'
  if (role === 'anonymous' && (grant.resource === '*' || anonymousDraftRead)) {
    throw new Error(`refusing an over-broad anonymous grant (${grant.action} ${grant.resource}${grant.scope ? ` scope=${grant.scope}` : ''}): name a specific resource and grant read with an explicit scope: 'published' (never draft-read)`)
  }
  (registered[role] ??= []).push(grant)
}

/** The full role → extra-grants map, for the guard to consult alongside `POLICY`. */
export function registeredGrants(): Readonly<Partial<Record<Role, Grant[]>>> {
  return registered
}

/** Test helper: drop all registered grants (the registry is a module singleton). */
export function clearAccessGrants(): void {
  for (const role of Object.keys(registered) as Role[]) Reflect.deleteProperty(registered, role)
}
