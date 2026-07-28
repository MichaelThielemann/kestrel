import { describe, it, expect } from 'vitest'
import { itemKey, computeRange, humanizeSize, splitPathInput, joinFolder, displayFolderPath, parentFolder, commonFolder, type LibraryItem } from './library'

const folder = (path: string): LibraryItem => ({ type: 'folder', folder: { path, name: path.split('/').pop()!, size: 0 } })
const file = (id: number): LibraryItem => ({ type: 'file', file: { id, filename: `f${id}.png`, mime: 'image/png', folder: '', size: 1, src: '/u/x' } })

describe('itemKey', () => {
  it('keys folders by path and files by id', () => {
    expect(itemKey(folder('pics/sub'))).toBe('folder:pics/sub')
    expect(itemKey(file(7))).toBe('file:7')
  })
})

describe('computeRange', () => {
  const keys = ['folder:a', 'folder:b', 'file:1', 'file:2', 'file:3']
  it('adds the inclusive range between anchor and target to the selection', () => {
    const r = computeRange(keys, 'folder:b', 'file:3', new Set(['folder:a']))
    expect([...r].sort()).toEqual(['file:1', 'file:2', 'file:3', 'folder:a', 'folder:b'].sort())
  })
  it('works when target is before anchor', () => {
    const r = computeRange(keys, 'file:3', 'folder:b', new Set())
    expect([...r].sort()).toEqual(['file:1', 'file:2', 'file:3', 'folder:b'].sort())
  })
  it('falls back to just the target when the anchor is unknown', () => {
    const r = computeRange(keys, 'missing', 'file:2', new Set())
    expect([...r]).toEqual(['file:2'])
  })
})

describe('parentFolder', () => {
  it('returns the parent path, or null at the root (never above it — no traversal)', () => {
    expect(parentFolder('')).toBeNull()
    expect(parentFolder('a')).toBe('')
    expect(parentFolder('a/b')).toBe('a')
    expect(parentFolder('a/b/c')).toBe('a/b')
  })
})

describe('humanizeSize', () => {
  it('formats bytes into B/KB/MB', () => {
    expect(humanizeSize(0)).toBe('0 B')
    expect(humanizeSize(512)).toBe('512 B')
    expect(humanizeSize(1024)).toBe('1.0 KB')
    expect(humanizeSize(1536)).toBe('1.5 KB')
    expect(humanizeSize(1048576)).toBe('1.0 MB')
  })
})

describe('splitPathInput', () => {
  it('splits a typed path into its parent and the trailing fragment', () => {
    expect(splitPathInput('pics/su')).toEqual({ parent: 'pics', fragment: 'su' })
    expect(splitPathInput('pics/sub/')).toEqual({ parent: 'pics/sub', fragment: '' })
    expect(splitPathInput('pic')).toEqual({ parent: '', fragment: 'pic' })
    expect(splitPathInput('')).toEqual({ parent: '', fragment: '' })
  })
})

describe('joinFolder', () => {
  it('joins parts and drops empty segments', () => {
    expect(joinFolder('a', 'b')).toBe('a/b')
    expect(joinFolder('', 'b')).toBe('b')
    expect(joinFolder('a/b', '', 'c')).toBe('a/b/c')
    expect(joinFolder('a', 'b/c')).toBe('a/b/c')
    expect(joinFolder('', '')).toBe('')
  })
  it('parses a typed display path back to the internal form', () => {
    expect(joinFolder('/')).toBe('')
    expect(joinFolder('/test123/')).toBe('test123')
    expect(joinFolder('/a/b/')).toBe('a/b')
  })
})

describe('displayFolderPath', () => {
  it('formats the internal folder as a slash-delimited path rooted at the media directory', () => {
    expect(displayFolderPath('')).toBe('/')
    expect(displayFolderPath('test123')).toBe('/test123/')
    expect(displayFolderPath('a/b')).toBe('/a/b/')
  })
  it('round-trips with joinFolder and tolerates stray slashes', () => {
    expect(displayFolderPath('/a/b/')).toBe('/a/b/')
    expect(joinFolder(displayFolderPath('a/b'))).toBe('a/b')
    expect(joinFolder(displayFolderPath(''))).toBe('')
  })
})

describe('commonFolder', () => {
  it('returns the longest common folder, or "" (root) when the paths diverge or none are given', () => {
    expect(commonFolder([])).toBe('')
    expect(commonFolder(['pics', 'pics'])).toBe('pics')
    expect(commonFolder(['a/b', 'a/c'])).toBe('a')
    expect(commonFolder(['a/b/c', 'a/b/d'])).toBe('a/b')
    expect(commonFolder(['', 'pics'])).toBe('')
    expect(commonFolder(['x/y'])).toBe('x/y')
    expect(commonFolder(['pics', 'docs'])).toBe('')
  })
  it('drops empty segments (stray/leading/trailing slashes) rather than emitting them', () => {
    expect(commonFolder(['/a//b/', '/a//b/'])).toBe('a/b')
    expect(commonFolder(['a/b', 'a//b'])).toBe('a/b')
  })
})
