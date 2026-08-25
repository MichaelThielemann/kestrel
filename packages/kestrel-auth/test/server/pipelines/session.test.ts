import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { clearPipelines, registerPipeline } from '@kestrel/core'
import { runPipelineForEvent } from '@kestrel/access'
import { buildSessionPipelines } from '../../../src/server/pipelines/session.js'

let sessionResult: { authenticated: boolean, exp?: number }

vi.mock('../../../src/server/utils/session-cookie.js', () => ({
  getAuthSession: () => sessionResult,
}))

function eventFor(role?: string): H3Event {
  const event = createEvent(
    {
      method: 'GET',
      url: '/api/session',
      headers: { 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '203.0.113.9' },
    } as never,
    { setHeader() {} } as never,
  )
  event.context.principal = { userId: role === 'admin' ? 'admin' : null, role: role ?? 'anonymous' } as never
  return event
}

const session = (role?: string) => runPipelineForEvent(eventFor(role), { op: 'session' })

beforeEach(() => {
  clearPipelines()
  for (const def of buildSessionPipelines()) registerPipeline(def)
  sessionResult = { authenticated: false }
})
afterEach(() => clearPipelines())

describe('session pipeline', () => {
  it('is readable anonymously (public read)', () => {
    sessionResult = { authenticated: true, exp: 123 }
    expect(session()).toEqual({ authenticated: true, exp: 123 })
  })

  it('reports an unauthenticated visitor', () => {
    sessionResult = { authenticated: false }
    expect(session()).toEqual({ authenticated: false })
  })
})
