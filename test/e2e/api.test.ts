import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setup, $fetch, fetch } from '@nuxt/test-utils/e2e'
import { hashPassword } from '@kestrel/auth'

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
    const res = await fetch('/api/login', {
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

  // A real boot is the only thing that can catch a repeat of the bundler-tree-shaking regression this
  // pins: `fields/server/field-registry/index.ts`'s `seedBuiltinFieldTypes(...)` call is what makes
  // `getFieldType('text')` resolve at all — a page create against a `text` field 500s with "unknown field
  // type" if that seed never ran (Nitro's dev bundler once tree-shook it silently). The assertion message
  // names the seed directly so a failure here points straight at it, not at CRUD/pipeline internals.
  it('the built-in field-type registry seed ran before boot (getFieldType("text") resolves)', async () => {
    const res = await fetch('/api/pages/createOne', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Seed check', path: '/seed-check' }),
    })
    expect(
      res.status,
      'a 500 here means the built-in field-type registry seed (fields/server/field-registry/index.ts\'s '
      + 'seedBuiltinFieldTypes call) did not run before this boot',
    ).toBe(201)
    // Clean up — this suite's later tests assert exact row counts against a shared db.
    const created = await res.json() as { id: number }
    await $fetch('/api/pages/deleteOne/' + created.id, { method: 'POST', headers: { cookie } })
  })

  it('creates an en page and lists it', async () => {
    const created = await $fetch('/api/pages/createOne', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Home', path: '/home', content: [{ id: 'a', type: 'hero', props: { heading: 'Hi' } }] },
    })
    expect(created.id).toBeTypeOf('number')
    expect(created.locale).toBe('en')

    const listed = await $fetch('/api/pages/readMany', { headers: { cookie } })
    expect(listed.total).toBe(1)
    expect(listed.data[0].title).toBe('Home')
  })

  it('reaches the auto-discovered posts collection', async () => {
    const listed = await $fetch('/api/posts/readMany', { headers: { cookie } })
    expect(listed).toHaveProperty('total')
    expect(Array.isArray(listed.data)).toBe(true)
  })

  it('adds a de translation in the same group with independent content', async () => {
    const en = await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'About', path: '/about' } })
    const de = await $fetch('/api/pages/createOne', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Ueber', locale: 'de', translationGroup: en.translationGroup, path: '/ueber' },
    })
    expect(de.translationGroup).toBe(en.translationGroup)

    const map = await $fetch(`/api/pages/translations/${en.id}`, { headers: { cookie } })
    expect(map).toMatchObject({ en: en.id, de: de.id })
  })

  it('tells the group form of /translations from the per-record one — only a real server proves the routing', async () => {
    const en = await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Grouped', path: '/grouped' } })
    const de = await $fetch('/api/pages/createOne', {
      method: 'POST',
      headers: { cookie },
      body: { title: 'Gruppiert', locale: 'de', translationGroup: en.translationGroup, path: '/gruppiert' },
    })

    const map = await $fetch('/api/pages/translations', { headers: { cookie }, query: { group: en.translationGroup } })
    expect(map).toMatchObject({ en: en.id, de: de.id })
    await expect($fetch(`/api/pages/translations/${en.id}`, { headers: { cookie } })).resolves.toMatchObject(map)

    const res = await fetch('/api/pages/translations?group=no-such-group', { headers: { cookie } })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ statusMessage: 'Unknown translation group: no-such-group' })
  })

  it('rejects an unauthenticated write with 401', async () => {
    await expect($fetch('/api/pages/createOne', { method: 'POST', body: { title: 'Nope' } }))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an invalid body with 400 (authenticated)', async () => {
    await expect($fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: {} }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('upserts and reads a singleton per locale', async () => {
    await $fetch('/api/settings/updateOne', { method: 'POST', headers: { cookie }, body: { siteName: 'Kestrel' } })
    const en = await $fetch('/api/settings/readOne', { headers: { cookie } })
    expect(en.siteName).toBe('Kestrel')
  })

  it('denies anonymous reads of non-public resources with 401', async () => {
    await expect($fetch('/api/settings/readOne')).rejects.toMatchObject({ statusCode: 401 }) // a singleton, not pageLike
    // posts pages are public (pageLike), but the per-collection tooling sub-routes stay admin-only
    await expect($fetch('/api/posts/options')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('exposes posts publicly (now pageLike) but only published rows — drafts stay hidden from anonymous', async () => {
    await $fetch('/api/posts/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Draft post', path: '/draft-post' } })
    const live = await $fetch('/api/posts/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Live post', path: '/live-post', status: 'published' } })

    const anon = await $fetch('/api/posts/readMany')
    const titles = anon.data.map((p: { title: string }) => p.title)
    expect(titles).toContain('Live post')
    expect(titles).not.toContain('Draft post') // a draft is never visible to anonymous

    await expect($fetch(`/api/posts/readOne/${live.id}`)).resolves.toMatchObject({ title: 'Live post' })
  })

  it('exposes publish-status admin-only, resolving a record to its route (no rows in dev → status null)', async () => {
    // admin-only: the default-deny guard rejects an anonymous read (publish-status is not a public resource)
    await expect($fetch('/api/publishStatus', { query: { collection: 'pages', id: 1 } }))
      .rejects.toMatchObject({ statusCode: 401 })

    const page = await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Live state', path: '/live-state', status: 'published' } })
    // authenticated: the record resolves to its localized route; the dev server never runs the publisher,
    // so there is no status row yet → status null (handled gracefully, not an error). `generates` is false
    // in dev (the right lamp shows a calm "Not built", not a stuck "Generating").
    const res = await $fetch('/api/publishStatus', { headers: { cookie }, query: { collection: 'pages', id: page.id } })
    expect(res).toMatchObject({ route: '/live-state', status: null, generates: false })

    // a non-pageLike collection (settings is a singleton with no path) → no route
    const none = await $fetch('/api/publishStatus', { headers: { cookie }, query: { collection: 'settings', id: 1 } })
    expect(none).toMatchObject({ route: null, status: null })
  })

  it('drives the batch pipelines: updateMany/deleteMany all-or-nothing, duplicate returns the created rows, anonymous 401s', async () => {
    const a = await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Bulk A', path: '/bulk-a' } })
    const b = await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Bulk B', path: '/bulk-b' } })

    // publish both in one call
    const pub = await $fetch('/api/pages/updateMany', { method: 'POST', headers: { cookie }, body: { ids: [a.id, b.id], patch: { status: 'published' } } })
    expect(pub).toMatchObject({ count: 2 })
    await expect($fetch(`/api/pages/readOne/${a.id}`, { headers: { cookie } })).resolves.toMatchObject({ status: 'published' })

    // all-or-nothing: one unknown id → 404 and NO partial write (b stays published)
    await expect($fetch('/api/pages/updateMany', { method: 'POST', headers: { cookie }, body: { ids: [b.id, 999999], patch: { status: 'draft' } } }))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect($fetch(`/api/pages/readOne/${b.id}`, { headers: { cookie } })).resolves.toMatchObject({ status: 'published' })

    // duplicate answers with the CREATED rows; the copy is a draft with a de-duped path
    const dup = await $fetch('/api/pages/duplicate', { method: 'POST', headers: { cookie }, body: { ids: [a.id] } })
    expect(dup).toHaveLength(1)
    const copy = await $fetch(`/api/pages/readOne/${dup[0].id}`, { headers: { cookie } })
    expect(copy.status).toBe('draft')
    expect(copy.path).not.toBe('/bulk-a')

    // a malformed id list / an anonymous caller
    await expect($fetch('/api/pages/deleteMany', { method: 'POST', headers: { cookie }, body: { ids: ['nope'] } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect($fetch('/api/pages/deleteMany', { method: 'POST', body: { ids: [a.id] } }))
      .rejects.toMatchObject({ statusCode: 401 })

    // batch delete cleans up
    const del = await $fetch('/api/pages/deleteMany', { method: 'POST', headers: { cookie }, body: { ids: [a.id, b.id, dup[0].id] } })
    expect(del).toMatchObject({ count: 3 })
    await expect($fetch(`/api/pages/readOne/${a.id}`, { headers: { cookie } })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('optimistic concurrency: an updateOne with a stale If-Unmodified-Since 409s; the matching one saves', async () => {
    const created = await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Concurrent', path: '/concurrent' } }) as { id: number; updatedAt: string }
    const baseline = new Date(created.updatedAt).getTime()

    // a stale baseline (as if another tab already saved) is refused, and the row is untouched
    await expect($fetch(`/api/pages/updateOne/${created.id}`, {
      method: 'POST', headers: { cookie, 'x-kestrel-if-unmodified-since': String(baseline - 5000) }, body: { title: 'Stale' },
    })).rejects.toMatchObject({ statusCode: 409 })
    await expect($fetch(`/api/pages/readOne/${created.id}`, { headers: { cookie } })).resolves.toMatchObject({ title: 'Concurrent' })

    // the matching baseline saves
    await expect($fetch(`/api/pages/updateOne/${created.id}`, {
      method: 'POST', headers: { cookie, 'x-kestrel-if-unmodified-since': String(baseline) }, body: { title: 'Fresh' },
    })).resolves.toMatchObject({ title: 'Fresh' })

    // no header → unconditional (a plain API client that doesn't opt in)
    await expect($fetch(`/api/pages/updateOne/${created.id}`, { method: 'POST', headers: { cookie }, body: { title: 'Uncond' } }))
      .resolves.toMatchObject({ title: 'Uncond' })
  })

  it('parses operator-aware filters over the wire (filter[field][op]) and 400s unknown ops/fields', async () => {
    await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Opera Alpha', path: '/opera-alpha' } })
    await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Opera Beta', path: '/opera-beta' } })

    const contains = await $fetch('/api/pages/readMany', { headers: { cookie }, query: { 'filter[title][contains]': 'Opera' } })
    expect(contains.data.length).toBe(2)

    const eq = await $fetch('/api/pages/readMany', { headers: { cookie }, query: { 'filter[title][eq]': 'Opera Alpha' } })
    expect(eq.data.map((p: { title: string }) => p.title)).toEqual(['Opera Alpha'])

    const ne = await $fetch('/api/pages/readMany', { headers: { cookie }, query: { 'filter[title][ne]': 'Opera Alpha', 'filter[title][contains]': 'Opera' } })
    expect(ne.data.map((p: { title: string }) => p.title)).toEqual(['Opera Beta'])

    // unknown operator and unknown/unfilterable field → clean 400s, not silent matches
    await expect($fetch('/api/pages/readMany', { headers: { cookie }, query: { 'filter[title][regex]': 'x' } }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect($fetch('/api/pages/readMany', { headers: { cookie }, query: { 'filter[nosuchfield][eq]': 'x' } }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('allows anonymous reads of pages but only published rows, and blocks tooling sub-routes', async () => {
    await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Secret draft', path: '/secret-draft' } })
    const live = await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Public live', path: '/public-live', status: 'published' } })

    const anon = await $fetch('/api/pages/readMany', { query: { 'filter[path]': '/public-live' } })
    expect(anon.data.map((p: { title: string }) => p.title)).toContain('Public live')

    const draft = await $fetch('/api/pages/readMany', { query: { 'filter[path]': '/secret-draft' } })
    expect(draft.data.length).toBe(0) // draft hidden from anonymous

    await expect($fetch(`/api/pages/readOne/${live.id}`)).resolves.toMatchObject({ title: 'Public live' })

    // the tooling reads are admin-only even for the public pages collection
    await expect($fetch('/api/pages/options')).rejects.toMatchObject({ statusCode: 401 })
    await expect($fetch(`/api/pages/translations/${live.id}`)).rejects.toMatchObject({ statusCode: 401 })
    await expect($fetch(`/api/pages/deadRefs/${live.id}`)).rejects.toMatchObject({ statusCode: 401 })
  })

  // The URL grammar is only provable on a real server: one catch-all now serves every endpoint, so a bare
  // id must never read as a pipeline and a collection-less pipeline must not answer under a collection.
  it('resolves the URL grammar across both pipeline forms', async () => {
    const page = await $fetch('/api/pages/createOne', { method: 'POST', headers: { cookie }, body: { title: 'Grammar', path: '/grammar' } })

    // the pre-4.0 REST URLs are gone
    expect((await fetch(`/api/pages/${page.id}`, { headers: { cookie } })).status).toBe(404)
    expect((await fetch('/api/pages', { headers: { cookie } })).status).toBe(404)

    // wrong verb for the pipeline's kind
    expect((await fetch('/api/pages/readMany', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(405)

    // unknown collection vs unknown pipeline
    expect((await fetch('/api/nope/readMany', { headers: { cookie } })).status).toBe(404)
    expect((await fetch('/api/pages/nonsense', { headers: { cookie } })).status).toBe(404)

    // a collection-less pipeline answers at /api/<name> and nowhere else
    await expect($fetch('/api/collections', { headers: { cookie } })).resolves.toHaveProperty('data')
    await expect($fetch('/api/session', { headers: { cookie } })).resolves.toMatchObject({ authenticated: true })
    expect((await fetch('/api/pages/session', { headers: { cookie } })).status).toBe(404)

    // a collection pipeline contributed by another layer resolves through the same grammar
    await expect($fetch('/api/media/library', { headers: { cookie } })).resolves.toHaveProperty('folders')

    // nothing claims this path: anonymous gets the same 401 as a claimed-but-denied pipeline (no
    // existence oracle), while an authenticated non-admin gets the plain default-deny 403
    expect((await fetch('/api/pages/nonsense')).status).toBe(401)

    await $fetch('/api/pages/deleteOne/' + page.id, { method: 'POST', headers: { cookie } })
  })
})
