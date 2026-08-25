import { consumerPipelineTargets, ensureDefaultPipelines, isRoutablePipeline, resolvePipeline } from '../pipeline/registry.js'
import { STANDARD_OPS, TOOLING_READ_OPS, type ResolvedPipeline } from '../pipeline/types.js'
import type { Localized } from '@kestrel/core'

/** @public */
export interface SerializedAction {
  name: string
  route: { url: string, method: 'GET' | 'POST' }
  kind: 'bulk' | 'record' | 'both'
  label?: Localized
  icon?: string
  confirm?: boolean
}

/** Built-in ops surfaced as generic actions beyond the always-present CRUD. `updateMany` is deliberately
 *  excluded — its status-patch use stays the admin's own publish/unpublish presentation, not a schema-driven
 *  row. Both take `{ids}` and are usable from a single row or the bulk bar, hence `'both'`. */
const BUILTIN_ACTIONS: readonly string[] = ['deleteMany', 'duplicate']

/** Standard CRUD + the built-ins above + the tooling reads + `rollback` — anything a consumer def targets
 *  here is an override of an existing operation, not a new action to list. `rollback` needs a revision
 *  number a generic action button has no way to supply, so it stays introspection-only metadata (its `ui`
 *  declaration is for a future dedicated revision-picker surface, not this generic row/bulk mechanism). */
const NOT_AN_ACTION = new Set<string>([...STANDARD_OPS, ...BUILTIN_ACTIONS, ...TOOLING_READ_OPS, 'rollback'])

function describeAction(resolved: ResolvedPipeline, defaultKind: SerializedAction['kind']): SerializedAction {
  const url = resolved.collection ? `/api/${resolved.collection}/${resolved.name}` : `/api/${resolved.name}`
  const ui = resolved.ui
  const out: SerializedAction = {
    name: resolved.name,
    route: { url, method: resolved.read ? 'GET' : 'POST' },
    kind: ui?.kind ?? defaultKind,
  }
  if (ui?.label) out.label = ui.label
  if (ui?.icon) out.icon = ui.icon
  if (ui?.confirm) out.confirm = true
  return out
}

/**
 * The admin actions a collection offers beyond the always-present CRUD: the built-in bulk set
 * (`deleteMany`, `duplicate`) plus any consumer-registered custom write pipeline on that collection.
 * Read pipelines never surface here — they are navigation, not an action.
 * @public
 */
export function buildCollectionActions(collectionName: string): SerializedAction[] {
  ensureDefaultPipelines()
  const out: SerializedAction[] = []
  for (const name of BUILTIN_ACTIONS) {
    const resolved = resolvePipeline(collectionName, name)
    if (isRoutablePipeline(resolved)) out.push(describeAction(resolved, 'both'))
  }
  for (const target of consumerPipelineTargets()) {
    if (target.collection !== collectionName || NOT_AN_ACTION.has(target.op)) continue
    const resolved = resolvePipeline(target.collection, target.op)
    if (isRoutablePipeline(resolved) && !resolved.read) out.push(describeAction(resolved, 'bulk'))
  }
  return out
}
