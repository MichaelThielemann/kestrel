import { describe, it, expect, vi } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { buildTable } from './buildTable'
import { defineCollection } from '../../../core/server/utils/defineCollection'

const colNames = (t: ReturnType<typeof buildTable>) => getTableConfig(t).columns.map((c) => c.name)
const cols = (t: ReturnType<typeof buildTable>) => getTableConfig(t).columns.map((c) => c.name)

describe('buildTable', () => {
  it('emits system columns + field columns for a page-like collection', () => {
    const t = buildTable(defineCollection({
      name: 'pages', mode: 'multi', translatable: true, pageLike: true,
      seo: true, blocks: { enabled: true }, status: true,
      fields: { title: { type: 'text', required: true } },
    }))
    const names = colNames(t)
    for (const c of ['id', 'locale', 'translation_group', 'path', 'status', 'seo', 'content', 'title', 'created_at', 'updated_at']) {
      expect(names).toContain(c)
    }
  })

  it('uses singleton_key for singletons and json for a json field', () => {
    const t = buildTable(defineCollection({
      name: 'settings', mode: 'single', translatable: true, fields: { data: { type: 'json' } },
    }))
    const names = colNames(t)
    expect(names).toContain('singleton_key')
    expect(names).not.toContain('translation_group')
    expect(names).toContain('data')
  })

  it('throws (fail-loud) on a field whose resolved key collides with a reserved system column', () => {
    const make = (fields: Record<string, { type: 'text' | 'number' }>) =>
      () => buildTable(defineCollection({ name: 'x', mode: 'multi', translatable: false, fields }))
    expect(make({ id: { type: 'number' } })).toThrow(/reserved/i) // always present
    expect(make({ createdAt: { type: 'text' } })).toThrow(/reserved/i) // added after the loop, still reserved
    // `status`/`content` are only reserved when their flag adds the column (gated by the SAME flags):
    expect(() => buildTable(defineCollection({ name: 'x', mode: 'multi', translatable: false, status: true, fields: { status: { type: 'text' } } }))).toThrow(/reserved/i)
    expect(() => buildTable(defineCollection({ name: 'x', mode: 'multi', translatable: false, fields: { content: { type: 'text' } } }))).not.toThrow() // no blocks → `content` is a free field name
  })

  it('throws when two fields resolve to the same column key (single-ref `cover` + sibling `coverId`)', () => {
    expect(() => buildTable(defineCollection({
      name: 'x', mode: 'multi', translatable: false,
      fields: { cover: { type: 'media' }, coverId: { type: 'text' } }, // both → jsKey `coverId`
    }))).toThrow(/collid/i)
  })

  it('throws (fail-loud) when an opt-in field index name collides with a system index', () => {
    // def.name + '_key' is also the singleton-mode system index name (on singletonKey) — a field literally
    // named "key" with `index: true` would otherwise mint a second index of the exact same name. The index
    // list is a lazily-evaluated `extraConfig` callback, so `getTableConfig` is what actually triggers it.
    const t = buildTable(defineCollection({
      name: 'globals', mode: 'single', fields: { key: { type: 'text', index: true } },
    }))
    expect(() => getTableConfig(t)).toThrow(/index/i)
  })

  it('warns (never throws) when `unique` is set on a field whose storage can never enforce it', () => {
    // A definition that ships today boots today: `unique` on a multi-valued field is an inert no-op, so
    // turning it into a build failure would break existing consumers for no functional gain.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const make = (fields: Record<string, unknown>) =>
      () => buildTable(defineCollection({ name: 'x', mode: 'multi', translatable: false, fields: fields as never }))
    for (const fields of [
      { tags: { type: 'choice', unique: true, options: { multiple: true, choices: [{ label: 'A', value: 'a' }] } } },
      { gallery: { type: 'media', unique: true, options: { multiple: true } } },
      { related: { type: 'relation', unique: true, relation: { collection: 'x', many: true } } },
      { items: { type: 'repeater', unique: true, options: { fields: {} } } },
      { data: { type: 'json', unique: true } },
    ]) {
      warn.mockClear()
      expect(make(fields)).not.toThrow()
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/enforce/i))
    }
    // the single-valued counterparts DO enforce it at the DB and must not warn:
    for (const fields of [
      { tag: { type: 'choice', unique: true, options: { multiple: false, choices: [{ label: 'A', value: 'a' }] } } },
      { cover: { type: 'media', unique: true } },
      { author: { type: 'relation', unique: true, relation: { collection: 'x' } } },
    ]) {
      warn.mockClear()
      expect(make(fields)).not.toThrow()
      expect(warn).not.toHaveBeenCalled()
    }
    warn.mockRestore()
  })

  it('names a single relation/media (single) column <name>_id', () => {
    const t = buildTable(defineCollection({
      name: 'posts', mode: 'multi', translatable: true,
      fields: { cover: { type: 'media' } },
    }))
    expect(colNames(t)).toContain('cover_id')
  })

  it('makes a conditional required field nullable (required is enforced when visible, not at the DB)', () => {
    const t = buildTable(defineCollection({
      name: 'pages', mode: 'multi', translatable: false,
      fields: {
        format: { type: 'text', required: true },
        caption: { type: 'text', required: true, condition: { field: 'format', is: 'image' } },
      },
    }))
    const byName = Object.fromEntries(getTableConfig(t).columns.map((c) => [c.name, c]))
    expect(byName.format!.notNull).toBe(true)
    expect(byName.caption!.notNull).toBe(false)
  })

  it('carries a declared default onto array-/json-backed columns (multi-choice / repeater / json)', () => {
    const t = buildTable(defineCollection({
      name: 'x', mode: 'multi', translatable: false,
      fields: {
        tags: { type: 'choice', default: ['a', 'b'], options: { multiple: true, choices: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] } },
        rows: { type: 'repeater', default: [{ k: 1 }], options: { fields: { k: { type: 'number' } } } },
        cfg: { type: 'json', default: { theme: 'dark' } },
        none: { type: 'choice', options: { multiple: true, choices: [{ label: 'A', value: 'a' }] } },
      },
    }))
    const byName = Object.fromEntries(getTableConfig(t).columns.map((c) => [c.name, c]))
    expect(byName.tags!.default).toEqual(['a', 'b'])
    expect(byName.rows!.default).toEqual([{ k: 1 }])
    expect(byName.cfg!.default).toEqual({ theme: 'dark' })
    expect(byName.none!.default).toBeDefined() // no field default → still the '[]' fallback (never undefined)
  })

  it('declares the group/locale unique index and the partial path index', () => {
    const t = buildTable(defineCollection({
      name: 'pages', mode: 'multi', translatable: true, pageLike: true, fields: {},
    }))
    const names = getTableConfig(t).indexes.map((i) => i.config.name)
    expect(names).toContain('pages_group_locale')
    expect(names).toContain('pages_path_locale')
    expect(names).toContain('pages_group')
  })
})

describe('buildTable — honest translatable', () => {
  it('multi + translatable:false omits locale and translation_group', () => {
    const t = buildTable(defineCollection({ name: 'media', mode: 'multi', translatable: false, fields: { storageKey: { type: 'text', required: true, unique: true } } }))
    const names = cols(t)
    expect(names).toContain('storage_key')
    expect(names).not.toContain('locale')
    expect(names).not.toContain('translation_group')
  })
  it('single + translatable:false keeps singleton_key, omits locale; index is key-only', () => {
    const t = buildTable(defineCollection({ name: 'globals', mode: 'single', translatable: false, fields: {} }))
    expect(cols(t)).toContain('singleton_key')
    expect(cols(t)).not.toContain('locale')
    const idx = getTableConfig(t).indexes.map((i) => i.config.name)
    expect(idx).toContain('globals_key')
    expect(idx).not.toContain('globals_key_locale')
  })
  it('multi + translatable:true is unchanged (locale + translation_group + group indexes)', () => {
    const t = buildTable(defineCollection({ name: 'posts', mode: 'multi', translatable: true, fields: { title: { type: 'text', required: true } } }))
    const names = cols(t)
    expect(names).toEqual(expect.arrayContaining(['locale', 'translation_group', 'title']))
    const idx = getTableConfig(t).indexes.map((i) => i.config.name)
    expect(idx).toEqual(expect.arrayContaining(['posts_group_locale', 'posts_group']))
  })
})

describe('buildTable — the pageLike layout column', () => {
  const pageLike = (fields = {}) => defineCollection({
    name: 'pages', mode: 'multi', translatable: true, pageLike: true, fields,
  })

  it('emits a nullable `layout` column for a pageLike collection', () => {
    const col = getTableConfig(buildTable(pageLike())).columns.find((c) => c.name === 'layout')
    expect(col).toBeDefined()
    // Nullable with no default: an unset layout must stay unset, so the render-time fallback is the one
    // and only place `default` is decided.
    expect(col!.notNull).toBe(false)
    expect(col!.hasDefault).toBe(false)
  })

  it('emits no `layout` column for a collection that is not pageLike', () => {
    const t = buildTable(defineCollection({ name: 'notes', mode: 'multi', fields: { body: { type: 'text' } } }))
    expect(getTableConfig(t).columns.map((c) => c.name)).not.toContain('layout')
  })

  it('refuses a field that would clobber the system column', () => {
    expect(() => buildTable(pageLike({ layout: { type: 'text' } })))
      .toThrow(/resolves to the reserved system column "layout"/)
  })

  it('still allows a field named `layout` where no system column exists', () => {
    const t = buildTable(defineCollection({ name: 'notes', mode: 'multi', fields: { layout: { type: 'text' } } }))
    expect(getTableConfig(t).columns.map((c) => c.name)).toContain('layout')
  })
})
