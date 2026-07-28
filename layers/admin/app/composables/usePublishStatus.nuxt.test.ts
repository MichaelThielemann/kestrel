import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { getQuery, createError } from 'h3'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { usePublishStatus } from './usePublishStatus'

let calls: Array<{ collection: string; id: string; locale: string }> = []
const idCalls = (id: string) => calls.filter((c) => c.id === id).length
registerEndpoint('/api/publish-status', (event) => {
  const q = getQuery(event)
  const id = String(q.id ?? '')
  calls.push({ collection: String(q.collection ?? ''), id, locale: String(q.locale ?? '') })
  if (id === '7') return { route: '/about', status: 'success', error: null, updatedAt: '2026-06-25T10:00:00.000Z', target: 's3', generates: true, driver: 's3' }
  if (id === '8') return { route: '/blog/x', status: 'error', error: 'S3 PutObject 403', updatedAt: '2026-06-25T11:00:00.000Z', target: 's3', generates: true, driver: 's3' }
  // dev / static generation off: no file is ever produced in this environment → generates:false
  if (id === '77') return { route: '/dev', status: null, generates: false, driver: 'local' }
  // settles to 'success' only after a couple of "still generating" (null) polls
  if (id === '90') {
    return idCalls('90') < 3
      ? { route: '/soon', status: null, generates: true, driver: 'local' }
      : { route: '/soon', status: 'success', target: 'local', generates: true, driver: 'local', updatedAt: '2026-06-25T12:00:00.000Z' }
  }
  // never settles: always "generating" — used to prove supersede + the attempts cap
  if (id === '91') return { route: '/never', status: null, generates: true, driver: 'local' }
  // a re-save: the STALE prior success row (updatedAt 'T0') persists until the new republish rewrites it
  // ('T1'). Proves the poll waits for the row to actually CHANGE, not for any success/error to be present.
  if (id === '92') {
    return idCalls('92') < 3
      ? { route: '/re', status: 'success', target: 'local', generates: true, driver: 'local', updatedAt: 'T0' }
      : { route: '/re', status: 'error', error: 'boom', target: 'local', generates: true, driver: 'local', updatedAt: 'T1' }
  }
  if (id === '500') throw createError({ statusCode: 500, statusMessage: 'boom' })
  return { route: '/x', status: null, generates: true, driver: 'local' }
})

beforeEach(() => { calls = [] })

describe('usePublishStatus', () => {
  it('fetches and exposes a successful publish status for a pageLike record', async () => {
    const s = usePublishStatus({ collection: 'pages', id: 7, locale: 'en', enabled: true })
    await s.refresh()
    expect(s.data.value).toMatchObject({ route: '/about', status: 'success' })
    expect(calls).toEqual([{ collection: 'pages', id: '7', locale: 'en' }])
  })

  it('carries the error message for a failed publish', async () => {
    const s = usePublishStatus({ collection: 'posts', id: 8, locale: 'en', enabled: true })
    await s.refresh()
    expect(s.data.value).toMatchObject({ status: 'error', error: 'S3 PutObject 403' })
  })

  it('does not fetch when disabled (non-pageLike) or id is "new"', async () => {
    const a = usePublishStatus({ collection: 'settings', id: 1, enabled: false })
    await a.refresh()
    expect(a.data.value).toEqual({ route: null, status: null })

    const b = usePublishStatus({ collection: 'pages', id: 'new', enabled: true })
    await b.refresh()
    expect(b.data.value).toEqual({ route: null, status: null })
    expect(calls).toEqual([]) // neither one hit the endpoint
  })

  it('reads reactive id/locale getters at fetch time', async () => {
    const id = ref<number | string>(7)
    const s = usePublishStatus({ collection: () => 'pages', id: () => id.value, locale: () => 'de', enabled: () => true })
    await s.refresh()
    expect(calls.at(-1)).toMatchObject({ id: '7', locale: 'de' })
  })

  it('degrades to an empty status when the fetch fails', async () => {
    const s = usePublishStatus({ collection: 'pages', id: 500, enabled: true })
    await s.refresh()
    expect(s.data.value).toEqual({ route: null, status: null })
  })

  it('exposes the write target + environment fields (target / generates / driver)', async () => {
    const s = usePublishStatus({ collection: 'pages', id: 7, enabled: true })
    await s.refresh()
    expect(s.data.value).toMatchObject({ status: 'success', target: 's3', generates: true, driver: 's3' })
  })
})

describe('usePublishStatus — refreshUntilSettled (poll the right lamp until Live/Error)', () => {
  it('polls until the page settles to success, then stops', async () => {
    const s = usePublishStatus({ collection: 'pages', id: 90, enabled: true })
    await s.refreshUntilSettled({ delayMs: 0 })
    expect(s.data.value).toMatchObject({ status: 'success', route: '/soon' })
    expect(idCalls('90')).toBe(3) // two "generating" polls + the settling one
  })

  it('stops after a single fetch when this environment does not generate (dev / off)', async () => {
    const s = usePublishStatus({ collection: 'pages', id: 77, enabled: true })
    await s.refreshUntilSettled({ delayMs: 0 })
    expect(s.data.value).toMatchObject({ status: null, generates: false })
    expect(idCalls('77')).toBe(1) // no point polling — nothing will ever be produced here
  })

  it('stops immediately once the outcome is an error', async () => {
    const s = usePublishStatus({ collection: 'posts', id: 8, enabled: true })
    await s.refreshUntilSettled({ delayMs: 0 })
    expect(s.data.value).toMatchObject({ status: 'error' })
    expect(idCalls('8')).toBe(1)
  })

  it('honours the attempts cap when the page never settles', async () => {
    const s = usePublishStatus({ collection: 'pages', id: 91, enabled: true })
    await s.refreshUntilSettled({ delayMs: 0, attempts: 4 })
    expect(s.data.value).toMatchObject({ status: null })
    expect(idCalls('91')).toBe(4)
  })

  it('is superseded by a newer refresh (the stale poll stops fetching)', async () => {
    const s = usePublishStatus({ collection: 'pages', id: 91, enabled: true })
    const poll = s.refreshUntilSettled({ delayMs: 5, attempts: 50 })
    await s.refresh() // bumps the poll token → the in-flight loop must bail
    await poll
    // the never-settling id would otherwise fetch ~50 times; supersede keeps it far below the cap
    expect(idCalls('91')).toBeLessThan(10)
  })

  it('does not poll an unsaved (new) record', async () => {
    const s = usePublishStatus({ collection: 'pages', id: 'new', enabled: true })
    await s.refreshUntilSettled({ delayMs: 0 })
    expect(s.data.value).toEqual({ route: null, status: null })
    expect(calls).toEqual([])
  })

  it('with no baseline (first publish), settles on the first terminal outcome', async () => {
    const s = usePublishStatus({ collection: 'pages', id: 7, enabled: true })
    await s.refreshUntilSettled({ since: null, delayMs: 0 })
    expect(s.data.value).toMatchObject({ status: 'success' })
    expect(idCalls('7')).toBe(1)
  })

  it('does NOT settle on a stale prior row — waits until updatedAt actually changes', async () => {
    // Re-saving an already-published page: the old success row (updatedAt 'T0') is still there when the
    // first poll fires (the republish is debounced). The poll must keep going until the NEW outcome lands.
    const s = usePublishStatus({ collection: 'pages', id: 92, enabled: true })
    await s.refreshUntilSettled({ since: 'T0', delayMs: 0 })
    expect(s.data.value).toMatchObject({ status: 'error', updatedAt: 'T1' }) // the fresh outcome, not the stale success
    expect(idCalls('92')).toBe(3) // two reads of the stale 'T0' row + the changed 'T1' one
  })
})
