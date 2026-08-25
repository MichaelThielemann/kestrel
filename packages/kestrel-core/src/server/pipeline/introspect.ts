import { JSONSchema, Schema } from 'effect'
import { allCollections, getCollection } from '../utils/registry.js'
import { defaultCollectionOps, isRoutablePipeline, tryResolveDefaultPipeline } from './defaults.js'
import { consumerPipelineTargets } from './registry.js'
import type { AccessSpec, PipelineActionUi, ResolvedPipeline } from './types.js'

/** JSON Schema (2020-12, OpenAPI 3.1-shaped) for a declared `input`/`output`, or `undefined` when the
 *  pipeline declares none — every consumer of the descriptor (the OpenAPI generator and `_pipelines`
 *  itself) reads this instead of re-resolving the registry to reach the schema. */
function jsonSchemaOf(schema: ResolvedPipeline['input']): Record<string, unknown> | undefined {
  if (!schema) return undefined
  return JSONSchema.make(Schema.encodedSchema(schema), { target: 'openApi3.1' }) as unknown as Record<string, unknown>
}

/** @public */
export interface PipelineDescriptor {
  name: string
  collection: string | null
  /** Whether the owning collection is a singleton (`mode: 'single'`) — `null` for a collection-less
   *  pipeline. A singleton's `readOne`/`updateOne` never take a path id (they resolve the one row by
   *  collection name instead), which is what the OpenAPI generator's `/{id}` path-item decision depends on. */
  singleton: boolean | null
  route: { url: string, method: 'GET' | 'POST' }
  gates: { access: AccessSpec | null, csrf: boolean, ipAllowlist: boolean }
  steps: { name: string, sync: boolean, sealed: boolean, when: string | null }[]
  after: { name: string, critical: boolean }[]
  schema: { input?: Record<string, unknown>, output?: Record<string, unknown> }
  /** Admin-action presentation, present only for a pipeline that declares one (see `PipelineActionUi`) —
   *  absent on the eight standard CRUD ops, which never surface as a generic action row. */
  ui?: PipelineActionUi
}

function describe(resolved: ResolvedPipeline): PipelineDescriptor {
  const url = resolved.collection ? `/api/${resolved.collection}/${resolved.name}` : `/api/${resolved.name}`
  return {
    name: resolved.name,
    collection: resolved.collection,
    singleton: resolved.collection ? (getCollection(resolved.collection)?.def.mode === 'single') : null,
    route: { url, method: resolved.read ? 'GET' : 'POST' },
    gates: {
      access: resolved.gates.access ?? null,
      csrf: resolved.gates.csrf ?? !resolved.read,
      ipAllowlist: resolved.gates.ipAllowlist !== false,
    },
    steps: resolved.steps.map((s) => ({ name: s.name, sync: Boolean(s.sync), sealed: Boolean(s.sealed), when: s.whenLabel ?? null })),
    after: resolved.after.map((a) => ({ name: a.step.name, critical: a.critical })),
    schema: { input: jsonSchemaOf(resolved.input), output: jsonSchemaOf(resolved.output) },
    ui: resolved.ui,
  }
}

/**
 * Every routable pipeline, composed live from the registry — never a parallel description. Enumerating
 * means composing each (collection, op) candidate, which is exactly what a request does; only safe here
 * because this runs per-request (the `_pipelines` handler), never at plugin init.
 * @public
 */
export function buildPipelineIndex(): PipelineDescriptor[] {
  const targets = new Map<string, { collection: string | null, op: string }>()
  const add = (collection: string | null, op: string): void => {
    targets.set(`${collection ?? '*'}::${op}`, { collection, op })
  }
  for (const collection of allCollections()) {
    for (const op of defaultCollectionOps()) add(collection.name, op)
  }
  for (const target of consumerPipelineTargets()) add(target.collection, target.op)

  const out: PipelineDescriptor[] = []
  for (const { collection, op } of targets.values()) {
    const resolved = tryResolveDefaultPipeline(collection, op)
    if (isRoutablePipeline(resolved)) out.push(describe(resolved))
  }
  return out.sort((a, b) => (a.collection ?? '').localeCompare(b.collection ?? '') || a.name.localeCompare(b.name))
}
