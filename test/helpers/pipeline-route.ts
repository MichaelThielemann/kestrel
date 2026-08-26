import { vi } from 'vitest'
import { createError, createEvent, getMethod, getQuery, type H3Event } from 'h3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
// Harness for the pipeline catch-all route. `runPipelineForEventAuto`/`resolveEventPrincipal` and
// `useDb`/`parseFilter`/`getCollectionOr404`/`parsePipelineRoute`/`readIfUnmodifiedSince` are all EXPLICIT
// imports in the route file, so overriding one needs a real module mock, not a
// global — see the `vi.mock` below. Only `defineEventHandler`/`createError`/`getQuery`/`getMethod`/
// `setResponseStatus`/`readBody` remain real Nuxt/Nitro auto-imports, faked below as plain globals.

const bodies = new WeakMap<H3Event, unknown>()
const preconditions = new WeakMap<H3Event, number | undefined>()
const statuses = new WeakMap<H3Event, number>()

let db: BetterSQLite3Database | null = null

/** Point the handler's `useDb()` at this test's database. */
export function usePipelineRouteDb(next: BetterSQLite3Database): void {
  db = next
}

vi.mock('@michaelthielemann/kestrel-core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDb: () => db,
  readIfUnmodifiedSince: (event: H3Event) => preconditions.get(event),
}))

Object.assign(globalThis, {
  defineEventHandler: (handler: unknown) => handler,
  createError,
  getQuery,
  getMethod,
  setResponseStatus: (event: H3Event, status: number) => { statuses.set(event, status) },
  readBody: (event: H3Event) => Promise.resolve(bodies.get(event)),
})

// tsc's NodeNext resolver mis-parses the bracketed Nuxt catch-all filename "[...path]" as having a
// ".path]" extension and fails to resolve it, even though Node/Vite resolve the same specifier fine at
// runtime. The specifier must stay a literal string (Vite needs it for static import analysis), so the
// false positive is suppressed here instead of worked around.
// @ts-expect-error -- tsc misresolves the bracketed filename "[...path]"; see comment above
const handler = (await import('../../layers/core/server/api/[...path]')).default as unknown as (event: H3Event) => Promise<unknown>

export interface RequestOptions {
  body?: unknown
  role?: string
  /** Defaults to `same-origin`, so a write is not refused by the CSRF gate before the test's own subject. */
  secFetchSite?: string
  expectedUpdatedAt?: number
}

export function pipelineEvent(method: string, path: string, options: RequestOptions = {}): H3Event {
  const event = createEvent(
    {
      method,
      url: path,
      headers: {
        'sec-fetch-site': options.secFetchSite ?? 'same-origin',
        // What a real client declares (0 for a bodyless request) — the router's body cap runs against it.
        'content-length': String(options.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(options.body))),
      },
      socket: { remoteAddress: '203.0.113.1' },
    } as never,
    { setHeader() {} } as never,
  )
  if (options.role) event.context.principal = { userId: options.role === 'admin' ? 'admin' : null, role: options.role } as never
  bodies.set(event, options.body)
  preconditions.set(event, options.expectedUpdatedAt)
  return event
}

/** Run the catch-all against one request. */
export function callPipelineRoute(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
  return handler(pipelineEvent(method, path, options))
}

/** Response status the handler set, if it set one. */
export function statusOf(event: H3Event): number | undefined {
  return statuses.get(event)
}

export { handler as pipelineRouteHandler }
