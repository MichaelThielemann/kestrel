import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { Schema } from 'effect'
import { buildIntrospectionPipelines, buildOpenApiDocument, buildOpenApiPipelines, buildPipelineIndex, clearPipelines, clearRegistry, definePipeline, registerCollection, registerPipeline } from '@michaelthielemann/kestrel-core'
import type { PipelineDef, PipelineDescriptor } from '@michaelthielemann/kestrel-core'
import { buildAuthPipelines } from '@michaelthielemann/kestrel-auth'
import { pagesCollection as pages } from '@michaelthielemann/kestrel-collections'
import posts from '../../server/collections/posts'
import settings from '../../server/collections/settings'
Object.assign(globalThis, {
  defineNitroPlugin: (fn: () => void) => fn,
  useRuntimeConfig: () => ({
    kestrel: { output: { driver: 'local', dir: '', publicDir: '/kestrel-no-such-public-dir', auto: true, publishOnSave: false, reconcileMinutes: 0, verbose: false, s3: {} } },
  }),
  useDb: () => drizzle(new Database(':memory:')),
  primaryLocale: () => 'en',
  prefixPrimaryLocale: () => false,
})

// `input`/`output` are not part of `PipelineDef` yet — this task's generator adds them. Casting keeps the
// excess-property check off this literal, so a missing field fails at runtime (undefined schema), not at
// the TS build step, which would otherwise block every other test in this file.
const SCRATCH_WITH_SCHEMAS = {
  name: 'openApiScratchWithSchemas',
  access: { role: 'admin' },
  steps: [{ name: 'noop', fn: () => {} }],
  input: Schema.Struct({ widgetName: Schema.String }),
  output: Schema.Struct({ widgetId: Schema.Number }),
} as PipelineDef

const SCRATCH_WITHOUT_SCHEMAS = {
  name: 'openApiScratchNoSchemas',
  access: { role: 'admin' },
  steps: [{ name: 'noop', fn: () => {} }],
} as PipelineDef

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let doc: any
let index: PipelineDescriptor[]

beforeAll(async () => {
  clearRegistry()
  registerCollection(pages)
  registerCollection(posts)
  registerCollection(settings)

  clearPipelines()
  for (const def of buildAuthPipelines()) registerPipeline(def)
  for (const def of buildIntrospectionPipelines()) registerPipeline(def)
  for (const def of buildOpenApiPipelines()) registerPipeline(def)
  registerPipeline(definePipeline(SCRATCH_WITH_SCHEMAS))
  registerPipeline(definePipeline(SCRATCH_WITHOUT_SCHEMAS))

  index = buildPipelineIndex()
  doc = buildOpenApiDocument()
})

afterAll(() => {
  clearRegistry()
  clearPipelines()
})

function stripId(url: string): string {
  return url.replace(/\/\{id\}$/, '')
}

/** Locates the operation object for a descriptor, tolerating either `[/{id}]` form. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function operationFor(descriptor: PipelineDescriptor): any {
  const method = descriptor.route.method.toLowerCase()
  const bare = doc.paths[descriptor.route.url]
  if (bare?.[method]) return bare[method]
  const withId = doc.paths[`${descriptor.route.url}/{id}`]
  return withId?.[method]
}

describe('buildOpenApiDocument — shape', () => {
  it('is a valid OpenAPI 3.1 document envelope', () => {
    expect(doc.openapi).toMatch(/^3\.1/)
    expect(doc.info).toBeTypeOf('object')
    expect(doc.info.title).toBeTypeOf('string')
    expect(doc.info.version).toBeTypeOf('string')
    expect(doc.paths).toBeTypeOf('object')
  })
})

describe('buildOpenApiDocument — index parity', () => {
  it('every routable pipeline from buildPipelineIndex() has a path+verb entry', () => {
    for (const descriptor of index) {
      const op = operationFor(descriptor)
      expect(op, `${descriptor.collection ?? '(none)'}/${descriptor.name}: missing ${descriptor.route.method} ${descriptor.route.url} in the document`).toBeDefined()
    }
  })

  it('no path+verb in the document is left over from no pipeline (count equality)', () => {
    const docEntries = new Set<string>()
    for (const [url, pathItem] of Object.entries<Record<string, unknown>>(doc.paths)) {
      for (const method of ['get', 'post']) {
        if (pathItem[method]) docEntries.add(`${method.toUpperCase()} ${stripId(url)}`)
      }
    }
    const indexEntries = new Set(index.map((d) => `${d.route.method} ${d.route.url}`))
    expect(docEntries.size, 'document has entries the index does not (path with no pipeline)').toBe(indexEntries.size)
    for (const entry of indexEntries) {
      expect(docEntries.has(entry), `${entry}: pipeline has no document entry`).toBe(true)
    }
  })
})

describe('buildOpenApiDocument — verbs', () => {
  it('read pipelines are routed GET, writes POST', () => {
    for (const descriptor of index) {
      const op = operationFor(descriptor)
      expect(op, `${descriptor.name}: no operation found`).toBeDefined()
      const expectedMethod = descriptor.route.method.toLowerCase()
      const bare = doc.paths[descriptor.route.url] ?? doc.paths[`${descriptor.route.url}/{id}`]
      expect(bare[expectedMethod], `${descriptor.name}: expected verb ${expectedMethod}`).toBeDefined()
      const otherMethod = expectedMethod === 'get' ? 'post' : 'get'
      expect(bare[otherMethod], `${descriptor.name}: unexpected verb ${otherMethod} also present`).toBeUndefined()
    }
  })
})

describe('buildOpenApiDocument — security', () => {
  it('a public read (pages/readMany) carries no auth requirement', () => {
    const descriptor = index.find((d) => d.collection === 'pages' && d.name === 'readMany')!
    const op = operationFor(descriptor)
    expect(op.security === undefined || op.security.length === 0).toBe(true)
  })

  it('an admin-gated write (pages/createOne) requires a security scheme', () => {
    const descriptor = index.find((d) => d.collection === 'pages' && d.name === 'createOne')!
    const op = operationFor(descriptor)
    expect(op.security).toBeDefined()
    expect(op.security.length).toBeGreaterThan(0)
  })

  it('_pipelines is admin-gated', () => {
    const descriptor = index.find((d) => d.collection === null && d.name === '_pipelines')!
    const op = operationFor(descriptor)
    expect(op.security).toBeDefined()
    expect(op.security.length).toBeGreaterThan(0)
  })

  it('_openapi is admin-gated', () => {
    const descriptor = index.find((d) => d.collection === null && d.name === '_openapi')!
    expect(descriptor, '_openapi did not compose into a routable pipeline').toBeDefined()
    const op = operationFor(descriptor)
    expect(op.security).toBeDefined()
    expect(op.security.length).toBeGreaterThan(0)
  })
})

describe('buildOpenApiDocument — error responses', () => {
  // `assertUnique` (the slug-conflict check) throws a field-scoped 400 (ValidationFailed at the HTTP
  // edge), never 409. createOne's step list has no step that reaches 409.
  it('createOne documents 400 (validate/assertUnique), 401/403 (gate) — no conflict code', () => {
    const descriptor = index.find((d) => d.collection === 'pages' && d.name === 'createOne')!
    const responses = operationFor(descriptor).responses
    for (const code of ['400', '401', '403']) {
      expect(responses[code], `createOne: missing response ${code}`).toBeDefined()
    }
    expect(responses['409'], 'createOne: unexpectedly documents 409 — no step in its composition can throw it').toBeUndefined()
  })

  it('updateOne documents 400, 401/403, 404 (loadBefore/persist), 409 (checkConcurrency)', () => {
    const descriptor = index.find((d) => d.collection === 'pages' && d.name === 'updateOne')!
    const responses = operationFor(descriptor).responses
    for (const code of ['400', '401', '403', '404', '409']) {
      expect(responses[code], `updateOne: missing response ${code}`).toBeDefined()
    }
  })

  // `loadBeforeManyStep` (shared with deleteMany) calls `idsFromInput`, which 400s on a malformed id list
  // before any row loads. 409 stays absent: nothing in deleteOne's step list (`loadBefore`, `assertAllExist`,
  // `persist`, `emitEvents`) can throw it.
  it('deleteOne documents 400 (loadBefore/idsFromInput), 401/403, 404 (assertAllExist) — no conflict code', () => {
    const descriptor = index.find((d) => d.collection === 'pages' && d.name === 'deleteOne')!
    const responses = operationFor(descriptor).responses
    for (const code of ['400', '401', '403', '404']) {
      expect(responses[code], `deleteOne: missing response ${code}`).toBeDefined()
    }
    expect(responses['409'], 'deleteOne: unexpectedly documents 409 — no step in its composition can throw it').toBeUndefined()
  })

  it('readOne (id-taking read) documents 404', () => {
    const descriptor = index.find((d) => d.collection === 'pages' && d.name === 'readOne')!
    const responses = operationFor(descriptor).responses
    expect(responses['404'], 'readOne: missing response 404').toBeDefined()
  })
})

describe('buildOpenApiDocument — schema derivation', () => {
  it('a pipeline with declared input/output gets a schema derived via JSONSchema.make(target: openApi3.1)', () => {
    const descriptor = index.find((d) => d.collection === null && d.name === 'openApiScratchWithSchemas')!
    const op = operationFor(descriptor)

    const requestSchema = op.requestBody?.content?.['application/json']?.schema
    expect(requestSchema, 'openApiScratchWithSchemas: no requestBody schema').toBeDefined()
    expect(requestSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(requestSchema.properties?.widgetName).toBeDefined()

    const responseSchema = op.responses['200']?.content?.['application/json']?.schema
    expect(responseSchema, 'openApiScratchWithSchemas: no 200 response schema').toBeDefined()
    expect(responseSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(responseSchema.properties?.widgetId).toBeDefined()
  })

  it('a pipeline without declared input/output documents unknown/empty honestly', () => {
    const descriptor = index.find((d) => d.collection === null && d.name === 'openApiScratchNoSchemas')!
    const op = operationFor(descriptor)

    const requestSchema = op.requestBody?.content?.['application/json']?.schema
    const isUnknownOrEmpty = (s: unknown): boolean =>
      s === undefined || s === null || (typeof s === 'object' && Object.keys(s as object).length === 0)
    expect(isUnknownOrEmpty(requestSchema), `expected undefined/empty schema, got ${JSON.stringify(requestSchema)}`).toBe(true)
  })
})
