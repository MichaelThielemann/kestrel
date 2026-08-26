import { describe, it, expect, vi, afterEach } from 'vitest'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { buildCollection, clearRegistry, defineCollection, registerCollection  } from '@michaelthielemann/kestrel-core'
import { isPubliclyLinkable, resolveInternalHref } from '../../../../src/server/utils/content/link-resolve.js'

describe('isPubliclyLinkable — status-gate internal link targets (no draft slug leak)', () => {
  it('rejects a missing target', () => {
    expect(isPubliclyLinkable(undefined, true)).toBe(false)
  })
  it('rejects a DRAFT/unpublished target when the collection has a status column', () => {
    expect(isPubliclyLinkable({ status: 'draft', path: '/secret' }, true)).toBe(false)
    expect(isPubliclyLinkable({ status: undefined, path: '/x' }, true)).toBe(false)
  })
  it('accepts a PUBLISHED target', () => {
    expect(isPubliclyLinkable({ status: 'published', path: '/about' }, true)).toBe(true)
  })
  it('accepts any existing target when the collection has no status column (nothing to gate)', () => {
    expect(isPubliclyLinkable({ path: '/x' }, false)).toBe(true)
    expect(isPubliclyLinkable({ status: 'draft', path: '/x' }, false)).toBe(true) // no status column → ignore the field
  })
})

describe('resolveInternalHref — an unreadable target', () => {
  afterEach(() => { clearRegistry() })

  it('logs the target it could not read before falling back to the not-linkable null', () => {
    registerCollection(buildCollection(defineCollection({
      name: 'pages', mode: 'multi', translatable: false, pageLike: true, status: true, fields: { title: { type: 'text' } },
    })))
    const db = { select: () => { throw new Error('no such table: pages') } } as unknown as BetterSQLite3Database
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(resolveInternalHref('pages', 7, db)).toBeNull()
      expect(error).toHaveBeenCalledWith(expect.stringContaining('resolveInternalHref: pages:7 unreadable'), expect.anything())
    } finally {
      error.mockRestore()
    }
  })
})
