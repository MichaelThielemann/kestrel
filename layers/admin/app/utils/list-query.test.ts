import { describe, it, expect } from 'vitest'
import { toQuery, toggleSort, sortDirection, parseListQuery, type ListState } from './list-query'
import type { ListColumn } from './list-columns'
import { clampPerPage } from '@michaelthielemann/kestrel-core'

describe('toQuery', () => {
  it('serializes sort, page, perPage and an eq filter as a bare filter[field] key (back-compat)', () => {
    expect(toQuery({ sort: '-createdAt', page: 2, perPage: 25, filter: { status: { op: 'eq', value: 'published' } } }))
      .toEqual({ sort: '-createdAt', page: 2, perPage: 25, 'filter[status]': 'published' })
  })

  it('serializes a non-eq operator as filter[field][op]', () => {
    expect(toQuery({ sort: null, page: 1, perPage: 25, filter: { createdAt: { op: 'gte', value: '2026-01-01' }, title: { op: 'contains', value: 'foo' } } }))
      .toEqual({ page: 1, perPage: 25, 'filter[createdAt][gte]': '2026-01-01', 'filter[title][contains]': 'foo' })
  })

  it('clamps perPage to the max and omits empty-valued filters and a null sort', () => {
    expect(toQuery({ sort: null, page: 1, perPage: 999, filter: { status: { op: 'eq', value: '' } } }))
      .toEqual({ page: 1, perPage: 500 })
  })
})

describe('clampPerPage (imported from the shared list-limits module — toQuery clamps through it)', () => {
  it('bounds to [1, 500] and defaults NaN to 25', () => {
    expect(clampPerPage(50)).toBe(50)
    expect(clampPerPage(0)).toBe(1)
    expect(clampPerPage(600)).toBe(500)
    expect(clampPerPage(Number.NaN)).toBe(25)
  })
})

describe('toggleSort', () => {
  it('cycles ascending <-> descending and resets on a new field', () => {
    expect(toggleSort(null, 'title')).toBe('title')
    expect(toggleSort('title', 'title')).toBe('-title')
    expect(toggleSort('-title', 'title')).toBe('title')
    expect(toggleSort('other', 'title')).toBe('title')
  })
})

describe('sortDirection', () => {
  it('reports the active column direction', () => {
    expect(sortDirection('title', 'title')).toBe('asc')
    expect(sortDirection('-title', 'title')).toBe('desc')
    expect(sortDirection('-title', 'other')).toBe(null)
    expect(sortDirection(null, 'title')).toBe(null)
  })
})

describe('parseListQuery (the pure inverse of toQuery — degrades to defaults, never throws)', () => {
  const cols: ListColumn[] = [
    { key: 'title', type: 'field', name: 'title', sortable: true, filterable: true, filterKind: 'text' },
    { key: 'createdAt', type: 'meta', labelKey: 'list.col.createdAt', sortable: true, filterable: true, filterKind: 'datetime' },
    { key: 'status', type: 'meta', labelKey: 'list.col.status', sortable: true, filterable: true, filterKind: 'enum' },
    { key: 'body', type: 'field', name: 'body', sortable: false, filterable: true, filterKind: 'richtext' },
  ]

  it('reads a bare filter[field] as eq and a [op] suffix as that operator', () => {
    expect(parseListQuery({ 'filter[title]': 'x' }, cols).filter).toEqual({ title: { op: 'eq', value: 'x' } })
    expect(parseListQuery({ 'filter[createdAt][gte]': '2026-01-01' }, cols).filter)
      .toEqual({ createdAt: { op: 'gte', value: '2026-01-01' } })
  })

  it('drops an unknown column, a disallowed op for the kind, and an unknown operator token', () => {
    expect(parseListQuery({ 'filter[nope]': '1' }, cols).filter).toBeUndefined() // unknown/unfilterable column
    expect(parseListQuery({ 'filter[status][lt]': '1' }, cols).filter).toBeUndefined() // enum allows only eq/ne
    expect(parseListQuery({ 'filter[title][bogus]': '1' }, cols).filter).toBeUndefined() // unknown operator token
  })

  it('drops an empty value and takes the first of a repeated key (one clause per column)', () => {
    expect(parseListQuery({ 'filter[title]': '' }, cols).filter).toBeUndefined()
    expect(parseListQuery({ 'filter[title]': ['a', 'b'] }, cols).filter).toEqual({ title: { op: 'eq', value: 'a' } })
  })

  it('omits a junk page/perPage (so the caller default / cookie applies) and clamps a valid perPage', () => {
    expect(parseListQuery({ page: 'abc' }, cols).page).toBeUndefined()
    expect(parseListQuery({ page: '-5' }, cols).page).toBeUndefined()
    expect(parseListQuery({ page: '4' }, cols).page).toBe(4)
    expect(parseListQuery({ perPage: 'abc' }, cols).perPage).toBeUndefined()
    expect(parseListQuery({ perPage: '999' }, cols).perPage).toBe(500) // clamped to the max
  })

  it('keeps a known sortable sort field (with direction) and omits an unknown or non-sortable one', () => {
    expect(parseListQuery({ sort: '-title' }, cols).sort).toBe('-title')
    expect(parseListQuery({ sort: 'bogus' }, cols).sort).toBeUndefined() // unknown field
    expect(parseListQuery({ sort: 'body' }, cols).sort).toBeUndefined() // known but not sortable
  })

  it('round-trips a representative state through toQuery → parseListQuery', () => {
    const state: ListState = {
      sort: '-title', page: 3, perPage: 50,
      filter: { title: { op: 'contains', value: 'foo' }, createdAt: { op: 'gte', value: '2026-01-01' } },
    }
    expect(parseListQuery(toQuery(state) as Record<string, unknown>, cols)).toEqual({
      sort: '-title', page: 3, perPage: 50,
      filter: { title: { op: 'contains', value: 'foo' }, createdAt: { op: 'gte', value: '2026-01-01' } },
    })
  })
})
