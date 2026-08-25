import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { DEFAULT_IMAGE_POLICY, createPipelineContext, getResolvedKestrelConfig, setResolvedKestrelConfig } from '@kestrel/core'
import type { PipelineDef } from '@kestrel/core'
import { runStepAsync } from '../../../../../test/helpers/run-effect.js'
import { buildMediaPipelines } from '../../../src/server/pipelines/index.js'

Object.assign(globalThis, {
  // `runRelocation` reads the request body through Nitro's auto-import.
  readBody: async () => ({}),
})

const defs = buildMediaPipelines()

// The pipeline names this suite is known to cover. Enumerating them is the completeness half of the
// property: adding a media pipeline without a gate has to fail here.
const COVERED = [
  'library', 'resolve', 'usages', 'upload', 'updateAsset', 'deleteAsset',
  'move', 'copy', 'rename', 'delete', 'folders', 'backfill',
]

function fakeEvent(): H3Event {
  return createEvent(
    { method: 'POST', url: '/api/media/x', headers: {}, socket: { remoteAddress: '203.0.113.1' } } as never,
    { setHeader() {} } as never,
  )
}

// `env.db` stays null: reaching for it means the gate did not run, and `dbOf` throws a plain error rather
// than a 404 — with the built-in disabled the `media` table does not exist, so any query is the 500 the
// gate exists to prevent.
async function callFirstStep(def: PipelineDef): Promise<{ statusCode?: number } | undefined> {
  const ctx = createPipelineContext({ op: def.name, id: 1, input: {}, db: null, event: fakeEvent() })
  try {
    await runStepAsync(def.steps![0]!.fn(ctx))
    return undefined
  } catch (error) {
    return error as { statusCode?: number }
  }
}

const ORIG_CONFIG = getResolvedKestrelConfig()

beforeEach(() => {
  setResolvedKestrelConfig({
    ...ORIG_CONFIG,
    media: { dir: '/tmp', baseUrl: '/uploads', driver: 'local', maxUploadBytes: 10_000_000, allowedMimes: '', s3: { bucket: '', region: '', endpoint: '', prefix: '', publicBaseUrl: '' }, imagePolicy: DEFAULT_IMAGE_POLICY },
    collections: { pages: true, media: true },
  })
})
afterEach(() => { setResolvedKestrelConfig(ORIG_CONFIG) })

describe('the media built-in gate covers every media pipeline', () => {
  it('knows about every pipeline the media layer registers', () => {
    expect(defs.map((d) => d.name).sort()).toEqual([...COVERED].sort())
  })

  for (const def of defs) {
    it(`${def.name} 404s instead of querying a missing table when the built-in is disabled`, async () => {
      setResolvedKestrelConfig({ ...getResolvedKestrelConfig(), collections: { pages: true, media: false } })
      expect(await callFirstStep(def)).toMatchObject({ statusCode: 404 })
    })

    it(`${def.name} does not 404 while the built-in is enabled`, async () => {
      expect((await callFirstStep(def))?.statusCode).not.toBe(404)
    })
  }
})
