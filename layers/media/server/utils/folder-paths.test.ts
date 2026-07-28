import { describe, it, expect } from 'vitest'
import { parentOf, ancestorsOf, selfAndAncestors, isImmediateChild, childName, isUnder, rewritePrefix } from './folder-paths'

describe('folder-paths', () => {
  it('parentOf returns the parent path or null at the root', () => {
    expect(parentOf('pages/home/gallery')).toBe('pages/home')
    expect(parentOf('pages')).toBe('')
    expect(parentOf('')).toBe(null)
  })
  it('ancestorsOf lists every ancestor (excluding self, excluding root)', () => {
    expect(ancestorsOf('pages/home/gallery')).toEqual(['pages', 'pages/home'])
    expect(ancestorsOf('pages')).toEqual([])
    expect(ancestorsOf('')).toEqual([])
  })
  it('selfAndAncestors includes the path itself', () => {
    expect(selfAndAncestors('pages/home')).toEqual(['pages', 'pages/home'])
    expect(selfAndAncestors('')).toEqual([])
  })
  it('isImmediateChild is true only one level below the parent', () => {
    expect(isImmediateChild('pages', 'pages/home')).toBe(true)
    expect(isImmediateChild('pages', 'pages/home/x')).toBe(false)
    expect(isImmediateChild('', 'pages')).toBe(true)
    expect(isImmediateChild('', 'pages/home')).toBe(false)
    expect(isImmediateChild('pages', 'pages-archive')).toBe(false)
  })
  it('childName returns the last segment', () => {
    expect(childName('pages/home')).toBe('home')
    expect(childName('pages')).toBe('pages')
  })
  it('isUnder matches a folder and its descendants, but not sibling-prefixes', () => {
    expect(isUnder('pages', 'pages')).toBe(true)
    expect(isUnder('pages', 'pages/home')).toBe(true)
    expect(isUnder('pages', 'pages/home/x')).toBe(true)
    expect(isUnder('pages', 'pages-archive')).toBe(false)
    expect(isUnder('pages', 'other')).toBe(false)
  })
  it('rewritePrefix re-bases a path from one subtree to another', () => {
    expect(rewritePrefix('pages/home/hero.jpg', 'pages', 'archive')).toBe('archive/home/hero.jpg')
    expect(rewritePrefix('pages', 'pages', 'archive')).toBe('archive')
    expect(rewritePrefix('pages-archive/x', 'pages', 'archive')).toBe('pages-archive/x')
  })
})
