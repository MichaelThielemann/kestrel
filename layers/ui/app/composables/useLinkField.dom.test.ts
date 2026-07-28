import { describe, it, expect } from 'vitest'
import { nextTick, ref } from 'vue'
import { useLinkField } from './useLinkField'
import type { LinkValue, LinkType } from '../../../core/server/utils/defineCollection'

const ALL: LinkType[] = ['external', 'email', 'tel', 'internal']

describe('useLinkField', () => {
  it('seeds currentType from initial model', () => {
    const model = ref<LinkValue | null>({ type: 'email', email: 'a@b.com' })
    const lk = useLinkField(model, ref(ALL))
    expect(lk.currentType.value).toBe('email')
    expect(lk.email.value).toBe('a@b.com')
  })

  it('seeds currentType from first allowed type when model is null', () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(['email', 'tel'] as LinkType[]))
    expect(lk.currentType.value).toBe('email')
  })

  it('editing url builds { type: external, url } on the model', async () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    lk.url.value = 'https://example.com'
    await nextTick()
    expect(model.value).toEqual({ type: 'external', url: 'https://example.com' })
  })

  it('includes label when set', async () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    lk.url.value = 'https://example.com'
    lk.label.value = 'Example'
    await nextTick()
    expect(model.value).toEqual({ type: 'external', url: 'https://example.com', label: 'Example' })
  })

  it('clears model to null when url is cleared (label-only is not a valid value)', async () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    lk.url.value = 'https://example.com'
    lk.label.value = 'Link'
    await nextTick()
    lk.url.value = ''
    await nextTick()
    expect(model.value).toBeNull()
  })

  it('switching currentType keeps label and switches the active value', async () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    lk.url.value = 'https://example.com'
    lk.label.value = 'My link'
    await nextTick()
    lk.currentType.value = 'email'
    lk.email.value = 'a@b.com'
    await nextTick()
    expect(model.value).toEqual({ type: 'email', email: 'a@b.com', label: 'My link' })
  })

  it('drafts of other types persist when switching back', async () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    lk.url.value = 'https://example.com'
    await nextTick()
    lk.currentType.value = 'email'
    lk.email.value = 'a@b.com'
    await nextTick()
    lk.currentType.value = 'external'
    await nextTick()
    expect(lk.url.value).toBe('https://example.com')
    expect(model.value).toEqual({ type: 'external', url: 'https://example.com' })
  })

  it('internal: collection + recordId → { type: internal, collection, id }', async () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    lk.currentType.value = 'internal'
    lk.collection.value = 'posts'
    lk.recordId.value = 42
    await nextTick()
    expect(model.value).toEqual({ type: 'internal', collection: 'posts', id: 42 })
  })

  it('internal: hash is carried into the model and stripped of a leading #', async () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    lk.currentType.value = 'internal'
    lk.collection.value = 'pages'
    lk.recordId.value = 30
    lk.hash.value = '#about'
    await nextTick()
    expect(model.value).toEqual({ type: 'internal', collection: 'pages', id: 30, hash: 'about' })
  })

  it('internal: reseeding from a model with a hash seeds the hash draft', async () => {
    const model = ref<LinkValue | null>({ type: 'internal', collection: 'pages', id: 30, hash: 'history' })
    const lk = useLinkField(model, ref(ALL))
    expect(lk.hash.value).toBe('history')
  })

  it('internal without both fields → model null', async () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    lk.currentType.value = 'internal'
    lk.collection.value = 'posts'
    await nextTick()
    expect(model.value).toBeNull()
  })

  it('external model reseed updates drafts without an echo loop', async () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    // Simulate external assignment (e.g. a record loader)
    model.value = { type: 'external', url: 'https://reseeded.com', label: 'Reseeded' }
    await nextTick()
    expect(lk.url.value).toBe('https://reseeded.com')
    expect(lk.label.value).toBe('Reseeded')
    expect(lk.currentType.value).toBe('external')
    // After reseed, build() should match model — no further mutation
    const snapshot = JSON.stringify(model.value)
    await nextTick()
    expect(JSON.stringify(model.value)).toBe(snapshot)
  })

  it('resetting the model to null externally clears the value drafts', async () => {
    const model = ref<LinkValue | null>({ type: 'external', url: 'https://a.com' })
    const lk = useLinkField(model, ref(ALL))
    model.value = null
    await nextTick()
    expect(lk.url.value).toBe('') // a stale draft must not survive an external reset
    expect(lk.label.value).toBe('')
    expect(lk.currentType.value).toBe('external') // type is preserved across a null reset
    await nextTick()
    expect(model.value).toBeNull() // …nor repopulate the model
  })

  it('reseeding to a different-type model clears the previous type draft', async () => {
    const model = ref<LinkValue | null>({ type: 'external', url: 'https://a.com' })
    const lk = useLinkField(model, ref(ALL))
    model.value = { type: 'email', email: 'a@b.com' }
    await nextTick()
    expect(lk.currentType.value).toBe('email')
    expect(lk.email.value).toBe('a@b.com')
    expect(lk.url.value).toBe('')
  })

  it('does not reassign the model on setup (no spurious mount emit)', async () => {
    const model = ref<LinkValue | null>({ type: 'external', url: 'https://a.com' })
    const first = model.value
    useLinkField(model, ref(ALL))
    await nextTick()
    expect(model.value).toBe(first) // same reference — setup did not rebuild it
  })

  it('typeModel setter guards against null/falsy', () => {
    const model = ref<LinkValue | null>(null)
    const lk = useLinkField(model, ref(ALL))
    lk.typeModel.value = 'email'
    expect(lk.currentType.value).toBe('email')
    // Setting to falsy does not change the type
    lk.typeModel.value = null as unknown as LinkType
    expect(lk.currentType.value).toBe('email')
  })
})
