import { Effect } from 'effect'

/** An access action `decide` resolves against a `PolicyTable`.
 * @public
 */
export type PolicyAction = 'read' | 'read:all' | 'write'
/** One grant row: `role` may `action` on `resource` (or `'*'` for any resource).
 * @public
 */
export interface PolicyRow { role: string, action: PolicyAction, resource: string }
/** The flattened grant table `decide` matches against.
 * @public
 */
export type PolicyTable = readonly PolicyRow[]
/** The data-driven facts `decide` needs beyond the policy table itself (the public resource set).
 * @public
 */
export interface DecideFacts { publicResources: readonly string[] }
/** The minimal principal shape `decide` needs to resolve a decision.
 * @public
 */
export interface DecidePrincipal { userId: string | null, role: string }

function rowMatches(row: PolicyRow, principal: DecidePrincipal, action: PolicyAction, resource: string): boolean {
  return row.role === principal.role && row.action === action && (row.resource === '*' || row.resource === resource)
}

/**
 * Pure access decision: no I/O, no defaults baked in — `policies` is the flattened table the shell builds
 * from today's hardcoded role policy plus the grant registry.
 */
export function decide(
  principal: DecidePrincipal,
  action: PolicyAction,
  resource: string,
  facts: DecideFacts,
  policies: PolicyTable,
): Effect.Effect<'allow' | 'deny', never> {
  return Effect.sync(() => {
    // Draft-read is a hard override, independent of table content: only 'admin' may ever resolve
    // 'read:all'. No policy row can widen this — the invariant demands an unrevokable override, so a
    // future role that needs draft-read requires a change to this core, never a new row.
    if (action === 'read:all' && principal.role !== 'admin') return 'deny'
    if (policies.some((row) => rowMatches(row, principal, action, resource))) return 'allow'
    // Anonymous published-read is data-driven from the registry-supplied public set, not a policy row.
    if (principal.role === 'anonymous' && action === 'read' && facts.publicResources.includes(resource)) return 'allow'
    return 'deny'
  })
}
