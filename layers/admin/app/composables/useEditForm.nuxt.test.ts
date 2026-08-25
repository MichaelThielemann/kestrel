import { describe, it, expect, beforeEach } from 'vitest'
import { useState } from '#imports'
import { createError, getQuery, getHeader, readBody } from 'h3'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { useEditForm } from './useEditForm'

const postsSchema = {
  name: 'posts', mode: 'multi', translatable: true, pageLike: false, seo: false, status: true,
  blocks: { enabled: false },
  fields: {
    title: { type: 'text', required: true, unique: false },
    body: { type: 'richtext', required: false, unique: false },
  },
}
const settingsSchema = {
  name: 'settings', mode: 'single', translatable: true, pageLike: false, seo: false, status: false,
  blocks: { enabled: false },
  fields: { data: { type: 'json', required: false, unique: false } },
}

let lastPostBody: Record<string, unknown> | null = null
let lastPatchBody: Record<string, unknown> | null = null
let lastPatchIfUnmodified: string | undefined
let lastPutBody: Record<string, unknown> | null = null
let lastPutLocale: unknown = null

// A REAL updatedAt so the editor's optimistic-concurrency baseline round-trips as a parseable timestamp.
const POST5_LOADED_AT = '2026-01-02T03:04:05.678Z'

registerEndpoint('/api/posts/readOne/5', () => ({ id: 5, title: 'Hello', body: '<p>hi</p>', status: 'draft', locale: 'en', translationGroup: 'grp-5', createdAt: 'x', updatedAt: POST5_LOADED_AT }))
registerEndpoint('/api/posts/updateOne/5', { method: 'POST', handler: async (event) => {
  lastPatchBody = await readBody(event)
  lastPatchIfUnmodified = getHeader(event, 'x-kestrel-if-unmodified-since')
  return { id: 5, title: lastPatchBody!.title ?? 'Hello', body: lastPatchBody!.body ?? null, status: 'draft', locale: 'en', createdAt: 'x', updatedAt: 'z' }
} })

registerEndpoint('/api/posts/translations/5', () => ({ en: 5, de: null }))

// The group-keyed sibling map a NEW translation resolves (it has no id of its own yet). `registerEndpoint`
// answers this URL whatever Nitro would do with it, so these tests cover only the composable's side: that
// it requests exactly this path with the group, and how it handles the answer. The handler's behaviour is
// covered by layers/core/server/api/[collection]/translations.get.test.ts. NOT covered anywhere in the unit
// suites: that Nitro routes this URL to `[collection]/translations.get.ts` rather than to `[collection]/
// [id].get.ts` with id="translations" — that needs a real server (test/e2e/api.test.ts).
const GROUP_MAP_URL = '/api/posts/translations'
let lastGroupQuery: unknown = null
registerEndpoint(GROUP_MAP_URL, (event) => {
  lastGroupQuery = getQuery(event).group
  if (lastGroupQuery === 'grp-boom') throw createError({ statusCode: 500, statusMessage: 'group lookup failed' })
  return { en: 5, de: null }
})

registerEndpoint('/api/posts/readMany', () => ({ data: [], total: 0, page: 1, perPage: 25 }))
registerEndpoint('/api/posts/createOne', { method: 'POST', handler: async (event) => {
  lastPostBody = await readBody(event)
  if (lastPostBody!.title === 'taken') {
    throw createError({ statusCode: 400, statusMessage: 'Validation failed', data: [{ path: ['title'], message: 'Already taken', code: 'custom' }] })
  }
  return { id: 1, title: lastPostBody!.title, body: lastPostBody!.body ?? null, status: 'draft', locale: 'en', createdAt: 'c', updatedAt: 'u' }
} })

const relSchema = {
  name: 'withrel', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false },
  fields: {
    title: { type: 'text', required: false, unique: false },
    author: { type: 'relation', required: false, unique: false, single: true, relation: { collection: 'users', many: false } },
  },
}
const pagesSchema = {
  name: 'pages', mode: 'multi', translatable: true, pageLike: true, seo: true, status: true,
  blocks: { enabled: true, allowed: ['hero', 'prose'] },
  fields: { title: { type: 'text', required: true, unique: false } },
}
const formsSchema = {
  name: 'forms', mode: 'multi', translatable: false, pageLike: false, seo: false, status: false,
  blocks: { enabled: false },
  fields: {
    format: { type: 'choice', required: false, unique: false, options: { choices: [{ label: 'Image', value: 'image' }, { label: 'Text', value: 'text' }] } },
    caption: { type: 'text', required: true, unique: false, condition: { field: 'format', is: 'image' } },
  },
}
let lastRelBody: Record<string, unknown> | null = null
let lastPagesBody: Record<string, unknown> | null = null
registerEndpoint('/api/collections', () => ({ data: [postsSchema, settingsSchema, relSchema, pagesSchema, formsSchema] }))
registerEndpoint('/api/forms/readMany', () => ({ data: [], total: 0, page: 1, perPage: 25 }))
registerEndpoint('/api/forms/createOne', { method: 'POST', handler: async (event) => ({ id: 1, format: (await readBody(event)).format ?? null, caption: null, createdAt: 'c', updatedAt: 'u' }) })
registerEndpoint('/api/pages/readOne/7', () => ({ id: 7, title: 'P', path: '/about', seo: { title: 'Meta T', description: 'Meta D' }, content: [{ id: 'b1', type: 'prose', props: { body: '<p>hi</p>' } }], status: 'draft', createdAt: 'x', updatedAt: 'y' }))
registerEndpoint('/api/pages/updateOne/7', { method: 'POST', handler: async (event) => {
  lastPagesBody = await readBody(event)
  const content = lastPagesBody!.content as { type: string; props?: { heading?: string } }[] | undefined
  if (content?.some((b) => b.type === 'hero' && !b.props?.heading)) {
    throw createError({ statusCode: 400, statusMessage: 'Validation failed', data: [{ path: ['content', 0, 'props', 'heading'], message: 'Required' }] })
  }
  if (lastPagesBody!.path === 'taken-slug') {
    throw createError({ statusCode: 400, statusMessage: 'Validation failed', data: [{ path: ['path'], message: 'Already in use' }] })
  }
  return { id: 7, title: lastPagesBody!.title ?? 'P', path: lastPagesBody!.path ?? '/about', seo: lastPagesBody!.seo ?? {}, content: lastPagesBody!.content ?? [], status: lastPagesBody!.status ?? 'draft', createdAt: 'x', updatedAt: 'z' }
} })
registerEndpoint('/api/pages/readMany', () => ({ data: [], total: 0, page: 1, perPage: 25 }))
registerEndpoint('/api/pages/createOne', { method: 'POST', handler: async (event) => {
  lastPagesBody = await readBody(event)
  return { id: 8, title: lastPagesBody!.title ?? 'P', path: lastPagesBody!.path ?? null, content: lastPagesBody!.content ?? [], status: 'draft', createdAt: 'c', updatedAt: 'u' }
} })
registerEndpoint('/api/withrel/readOne/9', () => ({ id: 9, title: 'X', authorId: 3, createdAt: 'x', updatedAt: 'y' }))
registerEndpoint('/api/withrel/updateOne/9', { method: 'POST', handler: async (event) => {
  lastRelBody = await readBody(event)
  return { id: 9, title: lastRelBody!.title ?? 'X', authorId: lastRelBody!.authorId ?? null, createdAt: 'x', updatedAt: 'z' }
} })

registerEndpoint('/api/settings/readOne', () => null)
registerEndpoint('/api/settings/updateOne', { method: 'POST', handler: async (event) => {
  lastPutBody = await readBody(event)
  lastPutLocale = getQuery(event).locale ?? null
  return { id: 1, data: lastPutBody!.data, locale: lastPutLocale ?? 'en', createdAt: 'c', updatedAt: 'u' }
} })

beforeEach(() => {
  useState('kestrel-collections').value = null
  lastPostBody = null
  lastPatchBody = null
  lastPutBody = null
  lastPutLocale = null
  lastRelBody = null
  lastPagesBody = null
  lastGroupQuery = null
})

describe('useEditForm', () => {
  it('create mode: initializes from defaults, dirty stays false until a value changes', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    expect(f.mode.value).toBe('multi')
    expect(f.values.title).toBe('')
    expect(f.values.body).toBe(null)
    expect(f.dirty.value).toBe(false)
    f.setField('title', 'My Post')
    expect(f.values.title).toBe('My Post')
    expect(f.dirty.value).toBe(true)
  })

  it('savedStatus tracks the last SAVED status, not the live (unsaved) dropdown value', async () => {
    const f = useEditForm({ collection: 'posts', id: 5 })
    await f.ready
    expect(f.savedStatus.value).toBe('draft') // the loaded/saved status
    f.setField('status', 'published') // switch the dropdown without saving
    expect(f.values.status).toBe('published') // live value changed
    expect(f.savedStatus.value).toBe('draft') // baseline unchanged until a save re-baselines
  })

  it('savedStatus is empty for a statusless collection', async () => {
    const f = useEditForm({ collection: 'forms', id: 'new' })
    await f.ready
    expect(f.savedStatus.value).toBe('')
  })

  it('runs advisory validation on setField', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    f.setField('title', '')
    expect(f.errors.title).toBe('This field is required.')
    f.setField('title', 'ok')
    expect(f.errors.title).toBe('')
  })

  it('conditional field: advisory validation skips it while hidden, enforces it once its condition is met', async () => {
    const f = useEditForm({ collection: 'forms', id: 'new' })
    await f.ready
    // format defaults to null => caption (condition format=image) is hidden => not required
    f.setField('format', 'text')
    expect(f.errors.caption ?? '').toBe('')
    expect(f.validateAll()).toBe(true)
    // matching the condition shows caption; empty => now required
    f.setField('format', 'image')
    expect(f.validateAll()).toBe(false)
    expect(f.errors.caption).toBe('This field is required.')
    // filling it makes the form valid again
    f.setField('caption', 'A cat')
    expect(f.validateAll()).toBe(true)
  })

  it('conditional field: hiding a field with a standing error clears that error', async () => {
    const f = useEditForm({ collection: 'forms', id: 'new' })
    await f.ready
    f.setField('format', 'image')
    f.validateAll()
    expect(f.errors.caption).toBe('This field is required.')
    f.setField('format', 'text') // re-hides caption
    expect(f.errors.caption).toBe('')
  })

  it('create submit: posts the field body, returns the record, resets dirty', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    f.setField('title', 'My Post')
    f.setField('body', '<p>x</p>')
    const res = await f.submit()
    expect(res.ok).toBe(true)
    expect(lastPostBody).toMatchObject({ title: 'My Post', body: '<p>x</p>' })
    expect(res.ok && res.record).toMatchObject({ id: 1, title: 'My Post' })
    expect(f.dirty.value).toBe(false)
  })

  it('maps a server 400 to per-field errors', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    f.setField('title', 'taken')
    const res = await f.submit()
    expect(res.ok).toBe(false)
    expect(f.errors.title).toBe('Already taken')
    // also raise a banner so a field-only 400 is never silent when the field's pane is unmounted
    expect(f.formError.value).toContain('highlighted page fields')
  })

  it('clears a stale system-column error (path) once a later save succeeds', async () => {
    const f = useEditForm({ collection: 'pages', id: '7' })
    await f.ready
    f.setField('path', 'taken-slug')
    const bad = await f.submit()
    expect(bad.ok).toBe(false)
    expect(f.errors.path).toBe('Already in use')
    f.setField('path', 'free-slug')
    const good = await f.submit()
    expect(good.ok).toBe(true)
    expect(f.errors.path).toBeFalsy()
  })

  it('blocks submit on client-side validation without calling the server', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    const res = await f.submit()
    expect(res.ok).toBe(false)
    expect(f.errors.title).toBe('This field is required.')
    expect(lastPostBody).toBe(null)
    // never silent: a client-validation failure raises the same banner as the server path, so the
    // error is visible even when the offending field's pane is unmounted (blocks-enabled editor).
    expect(f.formError.value).toContain('highlighted page fields')
  })

  it('edit mode: loads the row and posts changes to updateOne', async () => {
    const f = useEditForm({ collection: 'posts', id: '5' })
    await f.ready
    expect(f.values.title).toBe('Hello')
    expect(f.values.body).toBe('<p>hi</p>')
    expect(f.dirty.value).toBe(false)
    f.setField('title', 'Edited')
    expect(f.dirty.value).toBe(true)
    const res = await f.submit()
    expect(res.ok).toBe(true)
    expect(lastPatchBody).toMatchObject({ title: 'Edited' })
    expect(f.dirty.value).toBe(false)
  })

  it('edit mode: sends the loaded updatedAt as the If-Unmodified-Since precondition (optimistic concurrency)', async () => {
    lastPatchIfUnmodified = undefined
    const f = useEditForm({ collection: 'posts', id: '5' })
    await f.ready
    f.setField('title', 'Edited')
    await f.submit()
    expect(lastPatchIfUnmodified).toBe(String(new Date(POST5_LOADED_AT).getTime())) // epoch ms of the loaded baseline
  })

  it('maps a single relation value to its jsKey column (author <-> authorId)', async () => {
    const f = useEditForm({ collection: 'withrel', id: '9' })
    await f.ready
    expect(f.values.author).toBe(3) // rebaseline read row.authorId into values.author
    expect(f.dirty.value).toBe(false)
    f.setField('author', 7)
    const res = await f.submit()
    expect(res.ok).toBe(true)
    expect(lastRelBody).toMatchObject({ authorId: 7 })
    expect(lastRelBody!.author).toBeUndefined()
  })

  it('round-trips blocks content for a blocks-enabled collection', async () => {
    const f = useEditForm({ collection: 'pages', id: '7' })
    await f.ready
    expect(f.blocksEnabled.value).toBe(true)
    expect(f.blocksAllowed.value).toEqual(['hero', 'prose'])
    expect(f.values.content).toEqual([{ id: 'b1', type: 'prose', props: { body: '<p>hi</p>' } }])
    expect(f.dirty.value).toBe(false)
    f.setField('content', [{ id: 'b1', type: 'prose', props: { body: '<p>edited</p>' } }])
    expect(f.dirty.value).toBe(true)
    const res = await f.submit()
    expect(res.ok).toBe(true)
    expect(lastPagesBody!.content).toEqual([{ id: 'b1', type: 'prose', props: { body: '<p>edited</p>' } }])
    expect(f.dirty.value).toBe(false)
  })

  it('initializes blocks content to [] on create', async () => {
    const f = useEditForm({ collection: 'pages', id: 'new' })
    await f.ready
    expect(f.values.content).toEqual([])
  })

  it('pageLike: loads the page path and round-trips it in the update body', async () => {
    const f = useEditForm({ collection: 'pages', id: '7' })
    await f.ready
    expect(f.pageLike.value).toBe(true)
    expect(f.values.path).toBe('/about')
    expect(f.dirty.value).toBe(false)
    f.setField('path', '/about-us')
    expect(f.dirty.value).toBe(true)
    const res = await f.submit()
    expect(res.ok).toBe(true)
    expect(lastPagesBody).toMatchObject({ path: '/about-us' })
  })

  it('pageLike: round-trips the layout, and sends null rather than "" for the fallback', async () => {
    const f = useEditForm({ collection: 'pages', id: '7' })
    await f.ready
    // '' is the select's "no override" form; the stored value is NULL, so the two must not be confused.
    expect(f.values.layout).toBe('')
    f.setField('layout', 'alt')
    expect(f.dirty.value).toBe(true)
    await f.submit()
    expect(lastPagesBody).toMatchObject({ layout: 'alt' })
    f.setField('layout', '')
    await f.submit()
    expect(lastPagesBody).toHaveProperty('layout', null)
  })

  it('does not add a layout to a non-pageLike collection', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    f.setField('title', 'X')
    await f.submit()
    expect(lastPostBody).not.toHaveProperty('layout')
  })

  it('pageLike: a new page initializes an empty path and sends null when left blank', async () => {
    const f = useEditForm({ collection: 'pages', id: 'new' })
    await f.ready
    expect(f.values.path).toBe('')
    f.setField('title', 'Fresh')
    await f.submit()
    expect(lastPagesBody).toHaveProperty('path', null)
  })

  it('does not add a path to a non-pageLike collection', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    expect(f.pageLike.value).toBe(false)
    expect('path' in f.values).toBe(false)
    f.setField('title', 'P')
    await f.submit()
    expect(lastPostBody).not.toHaveProperty('path')
  })

  it('seo: loads seo meta and round-trips it in the update body', async () => {
    const f = useEditForm({ collection: 'pages', id: '7' })
    await f.ready
    expect(f.hasSeo.value).toBe(true)
    expect(f.values.seo).toEqual({ title: 'Meta T', description: 'Meta D' })
    f.setField('seo', { title: 'Meta T', description: 'Meta D', noindex: true })
    expect(f.dirty.value).toBe(true)
    await f.submit()
    expect(lastPagesBody!.seo).toMatchObject({ title: 'Meta T', noindex: true })
  })

  it('seo: a new page initializes seo to an empty object', async () => {
    const f = useEditForm({ collection: 'pages', id: 'new' })
    await f.ready
    expect(f.values.seo).toEqual({})
  })

  it('does not add seo to a collection without seo enabled', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    expect(f.hasSeo.value).toBe(false)
    expect('seo' in f.values).toBe(false)
  })

  it('status: loads the page status and round-trips it in the update body', async () => {
    const f = useEditForm({ collection: 'pages', id: '7' })
    await f.ready
    expect(f.hasStatus.value).toBe(true)
    expect(f.values.status).toBe('draft')
    expect(f.dirty.value).toBe(false)
    f.setField('status', 'published')
    expect(f.dirty.value).toBe(true)
    const res = await f.submit()
    expect(res.ok).toBe(true)
    expect(lastPagesBody).toMatchObject({ status: 'published' })
  })

  it('status: a new page initializes status to draft and sends it on create', async () => {
    const f = useEditForm({ collection: 'pages', id: 'new' })
    await f.ready
    expect(f.values.status).toBe('draft')
    f.setField('title', 'Fresh')
    await f.submit()
    expect(lastPagesBody).toMatchObject({ status: 'draft' })
  })

  it('does not add status to a collection without status enabled', async () => {
    const f = useEditForm({ collection: 'forms', id: 'new' })
    await f.ready
    expect(f.hasStatus.value).toBe(false)
    expect('status' in f.values).toBe(false)
  })

  it('undo/redo: steps through edits across fields and re-applies them', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    expect(f.canUndo.value).toBe(false)
    f.setField('title', 'One')
    f.setField('body', 'Two')
    expect(f.canUndo.value).toBe(true)
    f.undo()
    expect(f.values.body).toBe(null) // body reverts to its initial empty
    expect(f.values.title).toBe('One')
    f.undo()
    expect(f.values.title).toBe('') // title reverts to its initial empty
    expect(f.canUndo.value).toBe(false)
    expect(f.canRedo.value).toBe(true)
    f.redo()
    expect(f.values.title).toBe('One')
    f.redo()
    expect(f.values.body).toBe('Two')
    expect(f.canRedo.value).toBe(false)
  })

  it('undo/redo: coalesces a rapid burst of edits to the same field into one step', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    f.setField('title', 'A')
    f.setField('title', 'AB')
    f.setField('title', 'ABC')
    f.undo()
    expect(f.values.title).toBe('') // the whole typing burst is one undo step
    expect(f.canUndo.value).toBe(false)
  })

  it('undo/redo: a distinct coalesceAs forces its own step even under the same field name (block-tree ops)', async () => {
    // Simulates typing into block A's field (bursts under the default 'content' key) followed within the
    // coalesce window by a structural op on block B (e.g. delete) that must NOT merge into that burst.
    const f = useEditForm({ collection: 'pages', id: 'new' })
    await f.ready
    f.setField('content', ['typed-1'])
    f.setField('content', ['typed-2']) // same burst, coalesces (no separate step)
    f.setField('content', ['typed-2', 'deleted'], 'content:remove:b') // distinct op, own step
    f.undo()
    expect(f.values.content).toEqual(['typed-2']) // only the structural op is undone…
    expect(f.canUndo.value).toBe(true)
    f.undo()
    expect(f.values.content).toEqual([]) // …then the whole typing burst as one further step
    expect(f.canUndo.value).toBe(false)
  })

  it('undo/redo: a new edit clears the redo stack', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    f.setField('title', 'One')
    f.undo()
    expect(f.canRedo.value).toBe(true)
    f.setField('body', 'fork')
    expect(f.canRedo.value).toBe(false)
  })

  it('undo/redo: history resets after a save (cannot undo across a save)', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new' })
    await f.ready
    f.setField('title', 'Saved title')
    expect(f.canUndo.value).toBe(true)
    await f.submit()
    expect(f.canUndo.value).toBe(false)
  })

  it('surfaces a nested block-content 400 as a form-level error', async () => {
    const f = useEditForm({ collection: 'pages', id: '7' })
    await f.ready
    f.setField('content', [{ id: 'h', type: 'hero', props: { heading: '' } }])
    const res = await f.submit()
    expect(res.ok).toBe(false)
    expect(f.formError.value).toContain('block content')
    expect(f.blockErrors.value).toEqual({ h: { heading: 'Required' } })
  })

  it('keeps a block-content error attached to its block id across a reorder, and clears it on edit', async () => {
    const f = useEditForm({ collection: 'pages', id: '7' })
    await f.ready
    const hero = { id: 'h', type: 'hero', props: { heading: '' } }
    const prose = { id: 'p', type: 'prose', props: { body: '<p>ok</p>' } }
    f.setField('content', [hero, prose]) // server reports content[0] (the hero) invalid
    expect((await f.submit()).ok).toBe(false)
    expect(f.blockErrors.value).toEqual({ h: { heading: 'Required' } })
    // reorder the hero to the back — the error must follow id 'h', not stay on index 0
    f.setField('content', [prose, hero])
    expect(f.blockErrors.value).toEqual({ h: { heading: 'Required' } })
    // editing the offending block clears its stale inline error
    f.setField('content', [prose, { id: 'h', type: 'hero', props: { heading: 'Now set' } }])
    expect(f.blockErrors.value).toEqual({})
  })

  it('singleton mode: initializes from a null GET and upserts via updateOne with the locale', async () => {
    const f = useEditForm({ collection: 'settings', id: 'new' })
    await f.ready
    expect(f.mode.value).toBe('single')
    expect(f.values.data).toBe(null)
    f.setField('data', { hello: 'world' })
    expect(f.dirty.value).toBe(true)
    const res = await f.submit()
    expect(res.ok).toBe(true)
    expect(lastPutBody).toMatchObject({ data: { hello: 'world' } })
    expect(lastPutLocale).toBe('en')
    expect(f.dirty.value).toBe(false)
  })

  it('edit mode (translatable multi): active locale comes from the row, with its sibling translations', async () => {
    const f = useEditForm({ collection: 'posts', id: '5' })
    await f.ready
    expect(f.locale.value).toBe('en')
    expect(f.translations.value).toEqual({ en: 5, de: null })
  })

  it('new translation: posts the requested locale and the linking translationGroup', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new', locale: 'de', group: 'grp1' })
    await f.ready
    expect(f.locale.value).toBe('de')
    f.setField('title', 'Hallo')
    const res = await f.submit()
    expect(res.ok).toBe(true)
    expect(lastPostBody).toMatchObject({ title: 'Hallo', locale: 'de', translationGroup: 'grp1' })
  })

  it('new translation: resolves the GROUP\'s sibling map, so an occupied locale offers edit/copy instead of create', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new', locale: 'de', group: 'grp-5' })
    await f.ready
    expect(lastGroupQuery).toBe('grp-5')
    // Without this map the LocaleBar renders EN as a "+" create link: no copy-from, and following it
    // saves a second EN row in the group → a duplicate-locale 409 the user can never resolve.
    expect(f.translations.value).toEqual({ en: 5, de: null })
    expect(f.locale.value).toBe('de')
  })

  it('new record without a group: no sibling lookup at all', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new', locale: 'de' })
    await f.ready
    expect(lastGroupQuery).toBe(null)
    expect(f.translations.value).toEqual({})
  })

  it('a failing group lookup never blocks the new-translation editor', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new', locale: 'de', group: 'grp-boom' })
    await f.ready
    expect(f.translations.value).toEqual({})
    expect(f.values.title).toBe('')
  })

  it('singleton with a locale param: GETs and PUTs that locale', async () => {
    const f = useEditForm({ collection: 'settings', id: 'new', locale: 'de' })
    await f.ready
    expect(f.locale.value).toBe('de')
    f.setField('data', { x: 1 })
    await f.submit()
    expect(lastPutLocale).toBe('de')
  })

  it('exposes the translationGroup: the row group for an existing record, the requested group for a new one', async () => {
    const existing = useEditForm({ collection: 'posts', id: '5' })
    await existing.ready
    expect(existing.translationGroup.value).toBe('grp-5')
    const fresh = useEditForm({ collection: 'posts', id: 'new', locale: 'de', group: 'grp-x' })
    await fresh.ready
    expect(fresh.translationGroup.value).toBe('grp-x')
  })

  it("applyFrom copies another locale's values into the form and marks it dirty", async () => {
    const f = useEditForm({ collection: 'posts', id: '5' })
    await f.ready
    expect(f.dirty.value).toBe(false)
    f.applyFrom({ title: 'Kopie', body: '<p>de</p>' })
    expect(f.values.title).toBe('Kopie')
    expect(f.values.body).toBe('<p>de</p>')
    expect(f.dirty.value).toBe(true)
  })

  it('applyFrom copies block content too, for a blocks-enabled collection', async () => {
    const f = useEditForm({ collection: 'pages', id: '7' })
    await f.ready
    expect(f.dirty.value).toBe(false)
    f.applyFrom({ title: 'Kopie', content: [{ id: 'x', type: 'prose', props: { body: '<p>copied</p>' } }] })
    expect(f.values.title).toBe('Kopie')
    expect(f.values.content).toEqual([{ id: 'x', type: 'prose', props: { body: '<p>copied</p>' } }])
    expect(f.dirty.value).toBe(true)
  })

  it('trims a whitespace-padded group before linking a new translation', async () => {
    const f = useEditForm({ collection: 'posts', id: 'new', locale: 'de', group: '  grp-pad  ' })
    await f.ready
    expect(f.translationGroup.value).toBe('grp-pad')
    f.setField('title', 'X')
    await f.submit()
    expect(lastPostBody).toMatchObject({ translationGroup: 'grp-pad' })
  })
})
