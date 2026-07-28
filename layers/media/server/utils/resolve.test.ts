import { describe, it, expect } from 'vitest'
import { resolveMedia, orderById } from './resolve'

const row = {
  id: 7, folder: 'pics', storageKey: 'a/hero.jpg', mime: 'image/jpeg', width: 800, height: 600, thumbhash: 'TH',
  derivatives: {
    'w320.webp': { key: 'a/hero.jpg-w320.webp', width: 320, height: 240, mime: 'image/webp' },
    'w320.jpeg': { key: 'a/hero.jpg-w320.jpeg', width: 320, height: 240, mime: 'image/jpeg' },
    'w640.webp': { key: 'a/hero.jpg-w640.webp', width: 640, height: 480, mime: 'image/webp' },
  },
  translations: { en: { alt: 'Cat' }, de: { alt: 'Katze' } },
}
const publicUrl = (k: string) => `/uploads/${k}`

describe('resolveMedia', () => {
  it('localizes alt + builds a sorted WEBP-ONLY srcset (admin) + original src', () => {
    const r = resolveMedia(row as never, 'de', publicUrl)
    expect(r.id).toBe(7)
    expect(r.alt).toBe('Katze')
    expect(r.src).toBe('/uploads/a/hero.jpg')
    expect(r.srcset).toEqual([
      { url: '/uploads/a/hero.jpg-w320.webp', width: 320 },
      { url: '/uploads/a/hero.jpg-w640.webp', width: 640 },
    ])
    expect(r.width).toBe(800)
    expect(r.thumbhash).toBe('TH')
  })

  it('exposes every derivative as a name+format-tagged variant (the <picture> source)', () => {
    const r = resolveMedia(row as never, 'en', publicUrl)
    expect(r.variants).toHaveLength(3)
    expect(r.variants).toContainEqual({ name: 'w320', format: 'webp', url: '/uploads/a/hero.jpg-w320.webp', width: 320, height: 240 })
    expect(r.variants).toContainEqual({ name: 'w320', format: 'jpeg', url: '/uploads/a/hero.jpg-w320.jpeg', width: 320, height: 240 })
    expect(r.variants.find((v) => v.name === 'w640')!.format).toBe('webp')
  })
  it('falls back to the primary locale when the requested one is missing', () => {
    expect(resolveMedia(row as never, 'fr', publicUrl).alt).toBe('Cat') // primary = en
  })
  it('falls back PER FIELD: a locale with only title still gets the primary alt (not suppressed)', () => {
    const partial = { ...row, translations: { en: { alt: 'Cat', title: 'EN title' }, de: { title: 'DE Titel' } } }
    const r = resolveMedia(partial as never, 'de', publicUrl)
    expect(r.title).toBe('DE Titel') // present in de → kept
    expect(r.alt).toBe('Cat') // absent in de → falls back to primary (en), not null
  })
  it('handles a row with no derivatives/translations', () => {
    const r = resolveMedia({ id: 1, folder: null, storageKey: 'x.pdf', mime: 'application/pdf', width: null, height: null, thumbhash: null, derivatives: null, translations: null } as never, 'en', publicUrl)
    expect(r.srcset).toEqual([])
    expect(r.variants).toEqual([])
    expect(r.alt).toBeNull()
  })
  it('exposes the storage folder, defaulting to "" when the row folder is null', () => {
    expect(resolveMedia(row as never, 'en', publicUrl).folder).toBe('pics')
    expect(resolveMedia({ id: 2, folder: null, storageKey: 'y.png', mime: 'image/png', width: null, height: null, thumbhash: null, derivatives: null, translations: null } as never, 'en', publicUrl).folder).toBe('')
  })
})

describe('orderById', () => {
  it('returns rows in the input id order and skips missing ids', () => {
    const rows = [{ id: 2, x: 'b' }, { id: 1, x: 'a' }, { id: 5, x: 'e' }]
    expect(orderById([1, 5, 2], rows)).toEqual([{ id: 1, x: 'a' }, { id: 5, x: 'e' }, { id: 2, x: 'b' }])
    expect(orderById([3, 1], rows)).toEqual([{ id: 1, x: 'a' }])
    expect(orderById([], rows)).toEqual([])
  })
})
