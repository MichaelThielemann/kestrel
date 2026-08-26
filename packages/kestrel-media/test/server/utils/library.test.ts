import { describe, it, expect, beforeEach } from 'vitest'
import { listLibrary } from '../../../src/server/utils/library.js'
import { ensureFolder } from '../../../src/server/utils/folders.js'
import { create, ensureRevisionsTable, sqliteClientOf } from '@michaelthielemann/kestrel-core'
import media from '../../../src/server/collections/media.js'
import { createTestDb } from '../../../../../test/helpers/db.js'
import type { MediaDb } from '../../../src/server/db/media-db.js'

function asMediaDb(db: ReturnType<typeof createTestDb>): MediaDb {
  return db as unknown as MediaDb
}

let db: ReturnType<typeof createTestDb>
const url = (key: string) => `/uploads/${key}`

beforeEach(() => {
  db = createTestDb()
  ensureRevisionsTable(sqliteClientOf(db), 'media')
  ensureFolder(asMediaDb(db), 'a/b')
  ensureFolder(asMediaDb(db), 'a/c')
  create(db, media, { storageKey: 'a/one.png', folder: 'a', filename: 'one.png', mime: 'image/png', ext: 'png', size: 1 })
  create(db, media, { storageKey: 'a/doc.pdf', folder: 'a', filename: 'doc.pdf', mime: 'application/pdf', ext: 'pdf', size: 2 })
  create(db, media, { storageKey: 'a/b/deep.png', folder: 'a/b', filename: 'deep.png', mime: 'image/png', ext: 'png', size: 3 })
})

describe('listLibrary', () => {
  it('returns immediate child folders and files of a folder, resolved for rendering', () => {
    const r = listLibrary(asMediaDb(db), { folder: 'a' }, url)
    expect(r.folders.map((f) => f.path).sort()).toEqual(['a/b', 'a/c'])
    expect(r.folders.find((f) => f.path === 'a/b')!.name).toBe('b')
    expect(r.files.map((f) => f.filename).sort()).toEqual(['doc.pdf', 'one.png'])
    const one = r.files.find((f) => f.filename === 'one.png')!
    expect(one).toMatchObject({ folder: 'a', mime: 'image/png', src: '/uploads/a/one.png' })
    expect(r.total).toBe(2)
  })
  it('tolerates non-numeric page/perPage (NaN) instead of 500ing the listing', () => {
    const r = listLibrary(asMediaDb(db), { folder: 'a', page: NaN, perPage: NaN }, url)
    expect(r.page).toBe(1)
    expect(r.perPage).toBe(60)
    expect(r.files.length).toBe(2) // still returns the folder's files
  })
  it('root lists top-level folders and root files (folder stored NULL by the uploader)', () => {
    // the upload endpoint stores root files with folder NULL (buildMediaValues: '' || null)
    create(db, media, { storageKey: 'root.png', filename: 'root.png', mime: 'image/png', ext: 'png', size: 1 })
    const r = listLibrary(asMediaDb(db), { folder: '' }, url)
    expect(r.folders.map((f) => f.path)).toEqual(['a'])
    expect(r.files.map((f) => f.filename)).toEqual(['root.png'])
    expect(r.total).toBe(1)
  })
  it('reports each file\'s updatedAt so a client can send it back as an If-Unmodified-Since precondition', () => {
    const r = listLibrary(asMediaDb(db), { folder: 'a' }, url)
    const one = r.files.find((f) => f.filename === 'one.png')!
    expect(one.updatedAt).toBeTruthy()
  })
  it("resolves a file's alt text from its translations in the primary locale", () => {
    create(db, media, { storageKey: 'a/alt.png', folder: 'a', filename: 'alt.png', mime: 'image/png', ext: 'png', size: 1, translations: { en: { alt: 'a kitten' } } })
    expect(listLibrary(asMediaDb(db), { folder: 'a' }, url).files.find((x) => x.filename === 'alt.png')!.alt).toBe('a kitten')
  })
  it("carries a file's EU AI Act disclosure into the listing (null when unset)", () => {
    create(db, media, { storageKey: 'a/ai.png', folder: 'a', filename: 'ai.png', mime: 'image/png', ext: 'png', size: 1, aiSourceType: 'trainedAlgorithmicMedia', aiNote: 'Midjourney v7' })
    const files = listLibrary(asMediaDb(db), { folder: 'a' }, url).files
    expect(files.find((x) => x.filename === 'ai.png')!.aiDisclosure).toEqual({ sourceType: 'trainedAlgorithmicMedia', note: 'Midjourney v7' })
    expect(files.find((x) => x.filename === 'one.png')!.aiDisclosure).toBeNull()
  })
  it('reports the recursive byte size of each child folder', () => {
    // root → folder 'a' holds one.png(1) + doc.pdf(2) at 'a' plus deep.png(3) at 'a/b' = 6
    expect(listLibrary(asMediaDb(db), { folder: '' }, url).folders.find((f) => f.path === 'a')!.size).toBe(6)
    const a = listLibrary(asMediaDb(db), { folder: 'a' }, url)
    expect(a.folders.find((f) => f.path === 'a/b')!.size).toBe(3)
    expect(a.folders.find((f) => f.path === 'a/c')!.size).toBe(0)
  })
  it('reports folder existence: the root and registered folders exist, unknown paths do not', () => {
    expect(listLibrary(asMediaDb(db), { folder: '' }, url).exists).toBe(true)
    expect(listLibrary(asMediaDb(db), { folder: 'a' }, url).exists).toBe(true)
    expect(listLibrary(asMediaDb(db), { folder: 'a/b' }, url).exists).toBe(true)
    expect(listLibrary(asMediaDb(db), { folder: 'nope' }, url).exists).toBe(false)
    expect(listLibrary(asMediaDb(db), { folder: 'a/x' }, url).exists).toBe(false)
  })
  it('sorts files and child folders by the chosen column + direction', () => {
    // folder 'a' files: one.png (size 1), doc.pdf (size 2)
    expect(listLibrary(asMediaDb(db), { folder: 'a', sort: 'size' }, url).files.map((f) => f.filename)).toEqual(['one.png', 'doc.pdf'])
    expect(listLibrary(asMediaDb(db), { folder: 'a', sort: '-size' }, url).files.map((f) => f.filename)).toEqual(['doc.pdf', 'one.png'])
    expect(listLibrary(asMediaDb(db), { folder: 'a', sort: '-name' }, url).files.map((f) => f.filename)).toEqual(['one.png', 'doc.pdf'])
    // child folders: a/b (size 3), a/c (size 0)
    expect(listLibrary(asMediaDb(db), { folder: 'a', sort: 'size' }, url).folders.map((f) => f.path)).toEqual(['a/c', 'a/b'])
    expect(listLibrary(asMediaDb(db), { folder: 'a', sort: '-size' }, url).folders.map((f) => f.path)).toEqual(['a/b', 'a/c'])
  })
  it('search filters files by filename; type filters to images', () => {
    expect(listLibrary(asMediaDb(db), { folder: 'a', search: 'doc' }, url).files.map((f) => f.filename)).toEqual(['doc.pdf'])
    expect(listLibrary(asMediaDb(db), { folder: 'a', type: 'image' }, url).files.map((f) => f.filename)).toEqual(['one.png'])
  })
  it('serializes srcset to an <img> string for images with derivatives; undefined otherwise (never an array)', () => {
    create(db, media, {
      storageKey: 'a/img.png', folder: 'a', filename: 'img.png', mime: 'image/png', ext: 'png', size: 9,
      derivatives: {
        w320: { key: 'a/img-320.webp', width: 320, mime: 'image/webp' },
        w640: { key: 'a/img-640.webp', width: 640, mime: 'image/webp' },
      },
    })
    const r = listLibrary(asMediaDb(db), { folder: 'a' }, url)
    const img = r.files.find((f) => f.filename === 'img.png')!
    expect(img.srcset).toBe('/uploads/a/img-320.webp 320w, /uploads/a/img-640.webp 640w')
    // a pdf has no derivatives → undefined srcset so the grid renders its ext badge, not a broken <img>
    const pdf = r.files.find((f) => f.filename === 'doc.pdf')!
    expect(pdf.srcset).toBeUndefined()
    expect(Array.isArray(img.srcset)).toBe(false)
  })
})
