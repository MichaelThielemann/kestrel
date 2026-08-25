import { describe, it, expect } from 'vitest'
import { resolveAccess, actionForMethod, isPubliclyReadable, publishedOnlyForScope, type Principal } from '../../../src/server/utils/policy.js'

const admin: Principal = { userId: 'admin', role: 'admin' }
const renderer: Principal = { userId: 'renderer', role: 'renderer' }
const anon: Principal = { userId: null, role: 'anonymous' }

describe('resolveAccess', () => {
  it('admin may read and write any resource (scope all)', () => {
    expect(resolveAccess(admin, 'write', 'pages')).toEqual({ allowed: true, readScope: 'all' })
    expect(resolveAccess(admin, 'read', 'settings')).toEqual({ allowed: true, readScope: 'all' })
  })
  it('renderer reads PUBLISHED-only (drafts never reach the static site) and never writes', () => {
    // The renderer principal is only ever the build-time prerender or the runtime publisher, both of
    // which produce the public, published-only static site — so an unscoped 'read *' must NOT widen to
    // drafts via the generic /api/<collection> reads.
    expect(resolveAccess(renderer, 'read', 'posts')).toEqual({ allowed: true, readScope: 'published' })
    expect(resolveAccess(renderer, 'read', 'pages')).toEqual({ allowed: true, readScope: 'published' })
    expect(resolveAccess(renderer, 'write', 'pages').allowed).toBe(false)
  })
  it('anonymous may read ANY pageLike collection in the public set (published only), nothing else', () => {
    const pub = ['pages', 'posts'] // registry-driven set of pageLike collections
    expect(resolveAccess(anon, 'read', 'pages', pub)).toEqual({ allowed: true, readScope: 'published' })
    expect(resolveAccess(anon, 'read', 'posts', pub)).toEqual({ allowed: true, readScope: 'published' }) // generic — not just `pages`
    expect(resolveAccess(anon, 'read', 'settings', pub).allowed).toBe(false)
    expect(resolveAccess(anon, 'read', 'media', pub).allowed).toBe(false)
    expect(resolveAccess(anon, 'write', 'pages', pub).allowed).toBe(false)
    expect(resolveAccess(anon, 'read', 'pages/options', pub).allowed).toBe(false)
    expect(resolveAccess(anon, 'read', 'pages/translations', pub).allowed).toBe(false)
    expect(resolveAccess(anon, 'read', 'pages/dead-refs', pub).allowed).toBe(false) // per-record tooling, not public
    expect(resolveAccess(anon, 'read', 'references', pub).allowed).toBe(false) // the reverse-report resource is admin-only
    expect(resolveAccess(anon, 'read', 'pages', []).allowed).toBe(false) // empty public set → nothing readable
  })
  it('honours injected extra grants (the registry seam) — additive, resource-scoped, never widening default-deny', () => {
    const grant = [{ action: 'write', resource: 'proofing' } as const]
    expect(resolveAccess(anon, 'write', 'proofing').allowed).toBe(false) // no grant → default-deny
    // granted write is allowed BUT stays published-scoped — a write grant must never confer draft-read
    expect(resolveAccess(anon, 'write', 'proofing', [], grant)).toEqual({ allowed: true, readScope: 'published' })
    expect(resolveAccess(anon, 'write', 'other', [], grant).allowed).toBe(false) // scoped to the resource
    expect(resolveAccess(anon, 'read', 'proofing', [], grant).allowed).toBe(false) // scoped to the action
  })
})

describe('isPubliclyReadable — the collections a public sitemap may list', () => {
  it('is true exactly for the collections in the public (pageLike) set', () => {
    const pub = ['pages', 'posts']
    expect(isPubliclyReadable('pages', pub)).toBe(true)
    expect(isPubliclyReadable('posts', pub)).toBe(true)
    expect(isPubliclyReadable('settings', pub)).toBe(false)
    expect(isPubliclyReadable('media', pub)).toBe(false)
    expect(isPubliclyReadable('pages', [])).toBe(false)
  })
})

describe('publishedOnlyForScope — fail-closed read gating', () => {
  it('is published-only for anything that is not explicitly the full "all" scope', () => {
    expect(publishedOnlyForScope('all')).toBe(false) // the ONLY scope that sees drafts
    expect(publishedOnlyForScope('published')).toBe(true)
    expect(publishedOnlyForScope(undefined)).toBe(true) // fail-closed: a missing scope never leaks drafts
    expect(publishedOnlyForScope('whatever')).toBe(true)
  })
})

describe('actionForMethod', () => {
  it('maps safe methods to read, the rest to write', () => {
    expect(actionForMethod('GET')).toBe('read')
    expect(actionForMethod('head')).toBe('read')
    expect(actionForMethod('POST')).toBe('write')
    expect(actionForMethod('DELETE')).toBe('write')
  })
})

describe('a public collection grant', () => {
  it('covers only that collection, never a neighbour', () => {
    const pub = ['pages']
    expect(resolveAccess(anon, 'read', 'pages', pub).allowed).toBe(true)
    expect(resolveAccess(anon, 'read', 'secrets', pub).allowed).toBe(false)
    expect(resolveAccess(admin, 'read', 'secrets', pub).allowed).toBe(true)
  })
})
