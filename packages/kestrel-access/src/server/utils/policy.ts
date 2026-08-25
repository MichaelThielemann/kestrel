import { Effect } from 'effect'
import { decide, type PolicyRow, type PolicyTable } from '../core/decide.js'

/** A request principal's role.
 * @public
 */
export type Role = 'admin' | 'renderer' | 'anonymous'
/** Whether an access check is for reading or writing.
 * @public
 */
export type Action = 'read' | 'write'
/** Who a request runs as — the guard's output and every access check's input.
 * @public
 */
export interface Principal { userId: string | null; role: Role }
/** One extra grant contributed to a role, beyond the hardcoded `POLICY` table.
 * @public
 */
export interface Grant { action: Action; resource: string; scope?: 'published' | 'all' }
/** The outcome of `resolveAccess`: whether the action is allowed, and the read scope it implies.
 * @public
 */
export interface AccessResult { allowed: boolean; readScope: 'published' | 'all' }

/** Hardcoded authorization policy. Role -\> grants. `resource: '*'` matches any.
 * @public
 */
export const POLICY: Record<Role, Grant[]> = {
  admin: [{ action: 'write', resource: '*' }, { action: 'read', resource: '*' }],
  // The renderer is ONLY ever the build-time prerender or the runtime publisher; both produce the
  // public static site, which is published-only by definition. Scope its read to 'published' so the
  // generic /api/<collection> reads never leak drafts into the generated HTML (admin live preview is
  // unaffected — it renders under the admin principal, scope 'all').
  renderer: [{ action: 'read', resource: '*', scope: 'published' }],
  // Anonymous published-read is data-driven from the registry (every page-like collection), not a
  // literal allow-list — see the `publicResources` branch in `decide`.
  anonymous: [],
}

/** Flattens one role's grants into `decide`'s row shape: a read grant always contributes a plain 'read'
 *  row, and one with `(scope ?? 'all') === 'all'` also contributes the 'read:all' (draft-read) row. */
function grantRows(role: string, grants: readonly Grant[]): PolicyRow[] {
  const rows: PolicyRow[] = []
  for (const g of grants) {
    if (g.action === 'write') { rows.push({ role, action: 'write', resource: g.resource }); continue }
    rows.push({ role, action: 'read', resource: g.resource })
    if ((g.scope ?? 'all') === 'all') rows.push({ role, action: 'read:all', resource: g.resource })
  }
  return rows
}

/** The full table `decide` judges against: the hardcoded `POLICY` for every role, plus `extraGrants` for
 *  this one role (the registry seam — only the acting principal's own extra grants can matter to a single
 *  decision). The single place this repo builds a `PolicyTable`; every access decision routes through it. */
function buildPolicyTable(role: Role, extraGrants: readonly Grant[]): PolicyTable {
  const rows = Object.entries(POLICY).flatMap(([r, grants]) => grantRows(r, grants))
  rows.push(...grantRows(role, extraGrants))
  return rows
}

/** Resolves whether `principal` may `action` on `resource`, and the read scope that implies.
 * @public
 */
export function resolveAccess(principal: Principal, action: Action, resource: string, publicResources: readonly string[] = [], extraGrants: readonly Grant[] = []): AccessResult {
  const table = buildPolicyTable(principal.role, extraGrants)
  const facts = { publicResources }
  const allowed = Effect.runSync(decide(principal, action, resource, facts, table)) === 'allow'
  // readScope reflects the principal's READ permission for this resource, INDEPENDENT of the requested
  // action: a granted WRITE must never silently confer draft-read. 'all' only for the (admin-only) explicit
  // read:all decision — see decide.ts's hard override.
  const readScope = Effect.runSync(decide(principal, 'read:all', resource, facts, table)) === 'allow' ? 'all' : 'published'
  return { allowed, readScope }
}

/**
 * Whether an anonymous visitor may read a collection — i.e. whether its pages are publicly reachable.
 * The single source of truth for "what belongs in a public sitemap": a sitemap must list only URLs an
 * unauthenticated crawler can actually fetch, so the sitemap filters pageLike collections through this.
 * @public
 */
export function isPubliclyReadable(resource: string, publicResources: readonly string[] = []): boolean {
  return resolveAccess({ userId: null, role: 'anonymous' }, 'read', resource, publicResources).allowed
}

/**
 * Whether a read at this `readScope` must be limited to published rows. Fail-CLOSED: only the explicit
 * `'all'` scope (admin / live preview) sees drafts; anything else — `'published'`, an unexpected value,
 * or a missing scope (a guard regression) — stays published-only. Mirrors the public render path so the
 * two read entry points can't drift to opposite defaults.
 * @public
 */
export function publishedOnlyForScope(readScope: string | undefined): boolean {
  return readScope !== 'all'
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** Maps an HTTP method to the access `Action` it represents (GET/HEAD/OPTIONS read, everything else write).
 * @public
 */
export function actionForMethod(method: string): Action {
  return SAFE_METHODS.has(method.toUpperCase()) ? 'read' : 'write'
}

