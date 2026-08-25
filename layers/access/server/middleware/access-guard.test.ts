import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createEvent, createError, getMethod, type H3Event } from 'h3'
import { clearPipelines, clearRegistry } from '@kestrel/core'
// access-guard.ts is Nitro middleware: `getMethod`/`createError`/`defineEventHandler` resolve as
// auto-imported globals, stubbed below as plain globals. `resolveEventPrincipal` (`@kestrel/access`) and
// `refreshAuthSession` (`@kestrel/auth`) are EXPLICIT imports, so overriding them needs real module mocks.
let principal: { userId: string | null; role: string }

Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  getMethod,
  createError,
})

vi.mock('@kestrel/access', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveEventPrincipal: () => principal,
}))

vi.mock('@kestrel/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshAuthSession: () => {},
}))

const handler = (await import('./access-guard')).default as unknown as (event: H3Event) => void

function eventFor(path: string): H3Event {
  return createEvent(
    { method: 'GET', url: path, headers: {}, socket: { remoteAddress: '203.0.113.1' } } as never,
    { setHeader() {} } as never,
  )
}

beforeEach(() => {
  clearRegistry()
  clearPipelines()
})
afterEach(() => { clearRegistry(); clearPipelines() })

describe('access-guard middleware — default-deny status/message, unchanged by the channel conversion', () => {
  it('an anonymous caller against an unclaimed route gets 401 "Authentication required" (unprefixed)', () => {
    principal = { userId: null, role: 'anonymous' }
    expect(() => handler(eventFor('/api/nope'))).toThrowError(
      expect.objectContaining({ statusCode: 401, statusMessage: 'Authentication required' }),
    )
  })

  it('a non-admin authenticated caller against an unclaimed route gets 403 "Forbidden" (unprefixed)', () => {
    principal = { userId: 'u1', role: 'editor' }
    expect(() => handler(eventFor('/api/nope'))).toThrowError(
      expect.objectContaining({ statusCode: 403, statusMessage: 'Forbidden' }),
    )
  })
})
