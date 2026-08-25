import { buildPipelineIndex, type PipelineDescriptor } from './introspect.js'

/** The three standard ops whose id travels in the URL rather than the body — the only ones that get a
 *  separate `/{id}` path item. A singleton collection's `readOne`/`updateOne` resolve their one row by
 *  collection name instead (see `PipelineDescriptor.singleton`) and never take a path id, so the suffix is
 *  skipped there even though the op name matches. A custom pipeline that also reads `ctx.id` renders
 *  without the suffix — nothing on `PipelineDef` marks "this op takes a path id" beyond the standard set. */
const ID_TAKING_OPS: ReadonlySet<string> = new Set(['readOne', 'updateOne', 'deleteOne'])

const ADMIN_SESSION_SCHEME = 'adminSession'

const NO_SCHEMA: Record<string, unknown> = {}

/**
 * Steps whose own `createError` calls are reachable from any pipeline that composes them, keyed by step
 * name alone where the step's behavior — and therefore its error codes — never varies by which op composed
 * it. Two steps share a name across compositions that DO vary (`fetch`: `fetchManyStep` never 404s,
 * `fetchOneStep` always can; `loadBefore`: the singular `loadBeforeStep` never throws, the batch
 * `loadBeforeManyStep` can 400 on a malformed id list) — those are keyed by op name in `OP_ERROR_CODES`
 * instead, rather than renamed (both names are asserted verbatim elsewhere: `defaults.test.ts`,
 * `pipeline-introspection.test.ts`, `test/nuxt/validate-out.test.ts`).
 */
const STEP_ERROR_CODES: Record<string, string[]> = {
  validate: ['400'],
  assertUnique: ['400'],
  checkConcurrency: ['409'],
  assertAllExist: ['404'],
  verifyCredentials: ['401'],
  parseQuery: ['400'],
  resolveTranslations: ['400', '404'],
  recordDeadRefs: ['400'],
  referrers: ['400'],
}

/** Per-op corrections for steps whose error codes depend on which op composed them (see the doc comment on
 *  `STEP_ERROR_CODES`). */
const OP_ERROR_CODES: Record<string, string[]> = {
  // fetchOneStep 404s on a missing/unpublished row; fetchManyStep (same step name 'fetch') never does.
  readOne: ['404'],
  // persist's own not-found path (the row vanished between loadBefore and the update) — only reachable
  // through updateOne's single-row branch, never the batch ops that share the 'persist' step name.
  updateOne: ['404'],
  // loadBeforeManyStep calls idsFromInput, which 400s on a malformed/empty id list before any row loads.
  deleteOne: ['400'],
  deleteMany: ['400'],
  updateMany: ['400'],
}

const ERROR_DESCRIPTIONS: Record<string, string> = {
  '400': 'Validation failed',
  '401': 'Authentication required',
  '403': 'Forbidden',
  '404': 'Not found',
  '409': 'Conflict',
}

function errorCodesFor(descriptor: PipelineDescriptor): Set<string> {
  const codes = new Set<string>()
  for (const step of descriptor.steps) {
    for (const code of STEP_ERROR_CODES[step.name] ?? []) codes.add(code)
  }
  for (const code of OP_ERROR_CODES[descriptor.name] ?? []) codes.add(code)
  if (descriptor.gates.access && !descriptor.gates.access.public) {
    codes.add('401')
    codes.add('403')
  }
  return codes
}

function securityFor(descriptor: PipelineDescriptor): Array<Record<string, string[]>> | undefined {
  if (!descriptor.gates.access || descriptor.gates.access.public) return undefined
  return [{ [ADMIN_SESSION_SCHEME]: [] }]
}

/** A singleton's `readOne`/`updateOne` resolve their one row by collection name — no path id exists to
 *  document (see `PipelineDescriptor.singleton`). */
function takesPathId(descriptor: PipelineDescriptor): boolean {
  return ID_TAKING_OPS.has(descriptor.name) && descriptor.singleton !== true
}

function pathKeyFor(descriptor: PipelineDescriptor): string {
  return takesPathId(descriptor) ? `${descriptor.route.url}/{id}` : descriptor.route.url
}

function operationIdFor(descriptor: PipelineDescriptor): string {
  return descriptor.collection ? `${descriptor.collection}_${descriptor.name}` : descriptor.name
}

function successCodeFor(descriptor: PipelineDescriptor): string {
  return descriptor.name === 'createOne' || descriptor.name === 'createMany' ? '201' : '200'
}

function buildOperation(descriptor: PipelineDescriptor): Record<string, unknown> {
  const hasOutputSchema = Boolean(descriptor.schema.output)
  const responses: Record<string, unknown> = {
    [successCodeFor(descriptor)]: {
      description: hasOutputSchema ? 'OK' : 'Response shape not yet declared',
      content: { 'application/json': { schema: descriptor.schema.output ?? NO_SCHEMA } },
    },
  }
  for (const code of errorCodesFor(descriptor)) {
    responses[code] = { description: ERROR_DESCRIPTIONS[code] ?? 'Error' }
  }

  const operation: Record<string, unknown> = { operationId: operationIdFor(descriptor), responses }

  const security = securityFor(descriptor)
  if (security) operation.security = security

  if (takesPathId(descriptor)) {
    operation.parameters = [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }]
  }

  // Every write gets a requestBody — an omitted `content.schema` reads as "accepts no body at all" to a
  // generated client, which is wrong for every write except `deleteOne`. Permissively shaped (`{}`) where
  // no `input` is declared, same reasoning as the response fallback above.
  if (descriptor.route.method === 'POST') {
    operation.requestBody = {
      required: Boolean(descriptor.schema.input),
      content: { 'application/json': { schema: descriptor.schema.input ?? NO_SCHEMA } },
    }
  }

  return operation
}

/**
 * The OpenAPI 3.1 document for every routable pipeline, composed live from `buildPipelineIndex()` on every
 * call — never a parallel description, and never a second registry client: everything the generator needs
 * (gates, steps, schemas) already lives on the descriptor. Cheap enough to compose per request (same
 * reasoning as `_pipelines` itself): the registry is boot-static, so nothing here invalidates a cache,
 * because there is none.
 * @public
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const descriptor of buildPipelineIndex()) {
    const key = pathKeyFor(descriptor)
    const method = descriptor.route.method.toLowerCase()
    paths[key] ??= {}
    paths[key]![method] = buildOperation(descriptor)
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Kestrel API', version: '1.0.0' },
    paths,
    components: {
      securitySchemes: {
        [ADMIN_SESSION_SCHEME]: { type: 'apiKey', in: 'cookie', name: 'kestrel_session' },
      },
    },
  }
}
