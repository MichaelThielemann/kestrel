import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '../../layers/auth/server/utils/password'

const dbPath = join(tmpdir(), `kestrel-e2e-${process.pid}.sqlite`)
const PW = 'e2e-test-password'

process.env.KESTREL_DB = dbPath
process.env.KESTREL_SESSION_SECRET = 's'.repeat(40)
process.env.KESTREL_SECURE_COOKIES = 'false'
process.env.KESTREL_ADMIN_PASSWORD_HASH = await hashPassword(PW)

describe('CRUD API (e2e)', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('../../', import.meta.url)),
    dev: true,
  })

  let cookie = ''
  beforeAll(async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PW }),
    })
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean) as string[]
    cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
    expect(cookie).toContain('kestrel_session')
  })

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix) } catch {}
    }
  })

  it('creates an en page and lists it', async () => {
    const created = await $fetch('/api/pages', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Home', path: '/home', content: [{ id: 'a', type: 'hero', props: { heading: 'Hi' } }] },
    })
    expect(created.id).toBeTypeOf('number')
    expect(created.locale).toBe('en')

    const listed = await $fetch('/api/pages', { headers: { cookie } })
    expect(listed.total).toBe(1)
    expect(listed.data[0].title).toBe('Home')
  })

  it('reaches the auto-discovered posts collection', async () => {
    const listed = await $fetch('/api/posts', { headers: { cookie } })
    expect(listed).toHaveProperty('total')
    expect(Array.isArray(listed.data)).toBe(true)
  })

  it('adds a de translation in the same group with independent content', async () => {
    const en = await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'About', path: '/about' } })
    const de = await $fetch('/api/pages', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Ueber', locale: 'de', translationGroup: en.translationGroup, path: '/ueber' },
    })
    expect(de.translationGroup).toBe(en.translationGroup)

    const map = await $fetch(`/api/pages/${en.id}/translations`, { headers: { cookie } })
    expect(map).toMatchObject({ en: en.id, de: de.id })
  })

  it('routes /translations?group= to the group route, not to [id] with id="translations"', async () => {
    const en = await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Grouped', path: '/grouped' } })
    const de = await $fetch('/api/pages', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Gruppiert', locale: 'de', translationGroup: en.translationGroup, path: '/gruppiert' },
    })

    // The whole group route rests on Nitro preferring the literal segment over the dynamic `[id]`; only a
    // real server proves it. Landing in `[id].get.ts` would 400 with `Invalid id: translations` instead.
    const map = await $fetch('/api/pages/translations', { headers: { cookie }, query: { group: en.translationGroup } })
    expect(map).toMatchObject({ en: en.id, de: de.id })

    // and an unknown group is answered by the group route's own 404, not by the id parser's 400
    const res = await fetch('/api/pages/translations?group=no-such-group', { headers: { cookie } })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ statusMessage: 'Unknown translation group: no-such-group' })
  })

  it('rejects an unauthenticated write with 401', async () => {
    await expect($fetch('/api/pages', { method: 'POST', body: { title: 'Nope' } }))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an invalid body with 400 (authenticated)', async () => {
    await expect($fetch('/api/pages', { method: 'POST', headers: { cookie }, body: {} }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('upserts and reads a singleton per locale', async () => {
    await $fetch('/api/settings', { method: 'PUT', headers: { cookie }, body: { siteName: 'Kestrel' } })
    const en = await $fetch('/api/settings', { headers: { cookie } })
    expect(en.siteName).toBe('Kestrel')
  })

  it('denies anonymous reads of non-public resources with 401', async () => {
    await expect($fetch('/api/settings')).rejects.toMatchObject({ statusCode: 401 }) // a singleton, not pageLike
    // posts pages are public (pageLike), but the per-collection tooling sub-routes stay admin-only
    await expect($fetch('/api/posts/options')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('exposes posts publicly (now pageLike) but only published rows — drafts stay hidden from anonymous', async () => {
    await $fetch('/api/posts', { method: 'POST', headers: { cookie }, body: { title: 'Draft post', path: '/draft-post' } })
    const live = await $fetch('/api/posts', { method: 'POST', headers: { cookie }, body: { title: 'Live post', path: '/live-post', status: 'published' } })

    const anon = await $fetch('/api/posts')
    const titles = anon.data.map((p: { title: string }) => p.title)
    expect(titles).toContain('Live post')
    expect(titles).not.toContain('Draft post') // a draft is never visible to anonymous

    await expect($fetch(`/api/posts/${live.id}`)).resolves.toMatchObject({ title: 'Live post' })
  })

  it('exposes publish-status admin-only, resolving a record to its route (no rows in dev → status null)', async () => {
    // admin-only: the default-deny guard rejects an anonymous read (publish-status is not a public resource)
    await expect($fetch('/api/publish-status', { query: { collection: 'pages', id: 1 } }))
      .rejects.toMatchObject({ statusCode: 401 })

    const page = await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Live state', path: '/live-state', status: 'published' } })
    // authenticated: the record resolves to its localized route; the dev server never runs the publisher,
    // so there is no status row yet → status null (handled gracefully, not an error). `generates` is false
    // in dev (the right lamp shows a calm "Not built", not a stuck "Generating").
    const res = await $fetch('/api/publish-status', { headers: { cookie }, query: { collection: 'pages', id: page.id } })
    expect(res).toMatchObject({ route: '/live-state', status: null, generates: false })

    // a non-pageLike collection (settings is a singleton with no path) → no route
    const none = await $fetch('/api/publish-status', { headers: { cookie }, query: { collection: 'settings', id: 1 } })
    expect(none).toMatchObject({ route: null, status: null })
  })

  it('drives the bulk endpoint: publish/delete all-or-nothing, duplicate returns created ids, invalid action 400s, anonymous 401s', async () => {
    const a = await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Bulk A', path: '/bulk-a' } })
    const b = await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Bulk B', path: '/bulk-b' } })

    // publish both in one call
    const pub = await $fetch('/api/pages/bulk', { method: 'POST', headers: { cookie }, body: { action: 'publish', ids: [a.id, b.id] } })
    expect(pub).toMatchObject({ action: 'publish', count: 2 })
    await expect($fetch(`/api/pages/${a.id}`, { headers: { cookie } })).resolves.toMatchObject({ status: 'published' })

    // all-or-nothing: one unknown id → 404 and NO partial write (b stays published)
    await expect($fetch('/api/pages/bulk', { method: 'POST', headers: { cookie }, body: { action: 'unpublish', ids: [b.id, 999999] } }))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect($fetch(`/api/pages/${b.id}`, { headers: { cookie } })).resolves.toMatchObject({ status: 'published' })

    // duplicate returns the CREATED ids; the copy is a draft with a de-duped path
    const dup = await $fetch('/api/pages/bulk', { method: 'POST', headers: { cookie }, body: { action: 'duplicate', ids: [a.id] } })
    expect(dup.action).toBe('duplicate')
    expect(dup.ids).toHaveLength(1)
    const copy = await $fetch(`/api/pages/${dup.ids[0]}`, { headers: { cookie } })
    expect(copy.status).toBe('draft')
    expect(copy.path).not.toBe('/bulk-a')

    // invalid action / anonymous caller
    await expect($fetch('/api/pages/bulk', { method: 'POST', headers: { cookie }, body: { action: 'nope', ids: [a.id] } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect($fetch('/api/pages/bulk', { method: 'POST', body: { action: 'delete', ids: [a.id] } }))
      .rejects.toMatchObject({ statusCode: 401 })

    // bulk delete cleans up
    const del = await $fetch('/api/pages/bulk', { method: 'POST', headers: { cookie }, body: { action: 'delete', ids: [a.id, b.id, dup.ids[0]] } })
    expect(del).toMatchObject({ action: 'delete', count: 3 })
    await expect($fetch(`/api/pages/${a.id}`, { headers: { cookie } })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('optimistic concurrency: a PATCH with a stale If-Unmodified-Since 409s; the matching one saves', async () => {
    const created = await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Concurrent', path: '/concurrent' } }) as { id: number; updatedAt: string }
    const baseline = new Date(created.updatedAt).getTime()

    // a stale baseline (as if another tab already saved) is refused, and the row is untouched
    await expect($fetch(`/api/pages/${created.id}`, {
      method: 'PATCH', headers: { cookie, 'x-kestrel-if-unmodified-since': String(baseline - 5000) }, body: { title: 'Stale' },
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect($fetch(`/api/pages/${created.id}`, { headers: { cookie } })).resolves.toMatchObject({ title: 'Concurrent' })

    // the matching baseline saves
    await expect($fetch(`/api/pages/${created.id}`, {
      method: 'PATCH', headers: { cookie, 'x-kestrel-if-unmodified-since': String(baseline) }, body: { title: 'Fresh' },
    })).resolves.toMatchObject({ title: 'Fresh' })

    // no header → unconditional (a plain API client that doesn't opt in)
    await expect($fetch(`/api/pages/${created.id}`, { method: 'PATCH', headers: { cookie }, body: { title: 'Uncond' } }))
      .resolves.toMatchObject({ title: 'Uncond' })
  })

  it('parses operator-aware filters over the wire (filter[field][op]) and 400s unknown ops/fields', async () => {
    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Opera Alpha', path: '/opera-alpha' } })
    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Opera Beta', path: '/opera-beta' } })

    const contains = await $fetch('/api/pages', { headers: { cookie }, query: { 'filter[title][contains]': 'Opera' } })
    expect(contains.data.length).toBe(2)

    const eq = await $fetch('/api/pages', { headers: { cookie }, query: { 'filter[title][eq]': 'Opera Alpha' } })
    expect(eq.data.map((p: { title: string }) => p.title)).toEqual(['Opera Alpha'])

    const ne = await $fetch('/api/pages', { headers: { cookie }, query: { 'filter[title][ne]': 'Opera Alpha', 'filter[title][contains]': 'Opera' } })
    expect(ne.data.map((p: { title: string }) => p.title)).toEqual(['Opera Beta'])

    // unknown operator and unknown/unfilterable field → clean 400s, not silent matches
    await expect($fetch('/api/pages', { headers: { cookie }, query: { 'filter[title][regex]': 'x' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect($fetch('/api/pages', { headers: { cookie }, query: { 'filter[nosuchfield][eq]': 'x' } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('allows anonymous reads of pages but only published rows, and blocks tooling sub-routes', async () => {
    await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Secret draft', path: '/secret-draft' } })
    const live = await $fetch('/api/pages', { method: 'POST', headers: { cookie }, body: { title: 'Public live', path: '/public-live', status: 'published' } })

    const anon = await $fetch('/api/pages', { query: { 'filter[path]': '/public-live' } })
    expect(anon.data.map((p: { title: string }) => p.title)).toContain('Public live')

    const draft = await $fetch('/api/pages', { query: { 'filter[path]': '/secret-draft' } })
    expect(draft.data.length).toBe(0) // draft hidden from anonymous

    await expect($fetch(`/api/pages/${live.id}`)).resolves.toMatchObject({ title: 'Public live' })

    // tooling sub-routes are admin-only even for the public pages collection
    await expect($fetch('/api/pages/options')).rejects.toMatchObject({ statusCode: 401 })
    await expect($fetch(`/api/pages/${live.id}/translations`)).rejects.toMatchObject({ statusCode: 401 })
  })
})
