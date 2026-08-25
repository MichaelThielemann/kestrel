import { describe, it, expect } from 'vitest'
import { mergeKestrelDiscovered } from '../../../src/server/utils/kestrel-discovery.js'

describe('mergeKestrelDiscovered', () => {
  it('keeps every package item when no layer item shares its name', () => {
    const pkg = [{ name: 'media' }, { name: 'pages' }]
    expect(mergeKestrelDiscovered(pkg, [], (x) => x.name)).toEqual(pkg)
  })

  it('appends layer items after package items, in order', () => {
    const pkg = [{ name: 'media' }]
    const layer = [{ name: 'posts' }, { name: 'settings' }]
    expect(mergeKestrelDiscovered(pkg, layer, (x) => x.name)).toEqual([...pkg, ...layer])
  })

  it('a layer item overriding a package item keeps the PACKAGE ITEM\'S ORIGINAL POSITION, with the layer\'s value', () => {
    // Last write wins over the whole concatenation, but a name's first occurrence fixes its position —
    // only the VALUE at that position is replaced by a later same-named entry.
    const pkg = [{ name: 'pages', src: 'package' }, { name: 'media', src: 'package' }]
    const layer = [{ name: 'pages', src: 'layer' }]
    expect(mergeKestrelDiscovered(pkg, layer, (x) => x.name)).toEqual([
      { name: 'pages', src: 'layer' },
      { name: 'media', src: 'package' },
    ])
  })

  it('exactly one survivor per name — never both a package item and its override', () => {
    const pkg = [{ name: 'redirects' }]
    const layer = [{ name: 'redirects' }]
    const merged = mergeKestrelDiscovered(pkg, layer, (x) => x.name)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(layer[0])
  })

  it('dedupes over the WHOLE concatenation — two PACKAGES contributing the same name collapse too, not only package-vs-layer', () => {
    const pkg = [{ name: 'pages', src: 'package-a' }, { name: 'pages', src: 'package-b' }]
    const merged = mergeKestrelDiscovered(pkg, [], (x) => x.name)
    expect(merged).toEqual([{ name: 'pages', src: 'package-b' }]) // later package item wins, same rule as a layer override
  })
})
