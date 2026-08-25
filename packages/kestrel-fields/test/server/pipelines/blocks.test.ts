import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { clearPipelines, registerPipeline } from '@kestrel/core'
import { runPipelineForEvent } from '@kestrel/access'
import { clearBlocks, registerBlock } from '../../../src/server/utils/defineBlock.js'
import { buildBlocksPipelines } from '../../../src/server/pipelines/blocks.js'

function eventFor(role: string, query: Record<string, string> = {}): H3Event {
  const qs = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const event = createEvent(
    { method: 'GET', url: `/api/blocks${qs ? `?${qs}` : ''}`, headers: {}, socket: { remoteAddress: '203.0.113.9' } } as never,
    { setHeader() {} } as never,
  )
  event.context.principal = { userId: role === 'admin' ? 'admin' : null, role } as never
  return event
}

const blocks = (role: string, query?: Record<string, string>) =>
  runPipelineForEvent(eventFor(role, query), { op: 'blocks', input: query })

beforeEach(() => {
  clearPipelines()
  clearBlocks()
  for (const def of buildBlocksPipelines()) registerPipeline(def)
  registerBlock({ name: 'hero', fields: { heading: { type: 'text', required: true } } })
  registerBlock({ name: 'prose', fields: { body: { type: 'richtext' } } })
})
afterEach(() => { clearPipelines(); clearBlocks() })

describe('blocks pipeline', () => {
  it('is admin-only and lists every registered block, serialized', () => {
    expect(() => blocks('anonymous')).toThrow(expect.objectContaining({ _tag: 'Unauthorized' }))
    const result = blocks('admin') as { data: { name: string }[] }
    expect(result.data.map((b) => b.name).sort()).toEqual(['hero', 'prose'])
  })

  it('restricts to the given ?allowed= list', () => {
    const result = blocks('admin', { allowed: 'prose' }) as { data: { name: string }[] }
    expect(result.data.map((b) => b.name)).toEqual(['prose'])
  })
})
