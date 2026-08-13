import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, getTableColumns } from 'drizzle-orm'
import { relocateMedia, duplicateMedia } from './storage-relocate'
import { createLocalDriver } from '../../../core/server/utils/storage.local'
import { create } from '../../../core/server/utils/crud'
import media, { media as mediaTable } from '../collections/media'
import { createTestDb } from '../../../../test/helpers/db'
import { registerWriteListener, clearWriteListeners, type WriteEvent } from '../../../core/server/utils/write-events'
import type { DerivativeManifest } from './record'

let db: ReturnType<typeof createTestDb>
let driver: ReturnType<typeof createLocalDriver>

async function seed(storageKey: string, folder: string, filename: string, derivs: DerivativeManifest = {}) {
  await driver.put(storageKey, Buffer.from('orig'), 'image/png')
  for (const d of Object.values(derivs)) await driver.put(d.key, Buffer.from('var'), d.mime)
  return create(db, media, { storageKey, folder, filename, mime: 'image/png', ext: 'png', size: 4, derivatives: derivs }) as { id: number }
}
const cols = () => getTableColumns(mediaTable) as Record<string, never>
const rowOf = (id: number) => db.select().from(mediaTable).where(eq(cols().id, id)).get() as { storageKey: string; folder: string | null; derivatives: DerivativeManifest }

beforeEach(() => {
  db = createTestDb()
  driver = createLocalDriver({ dir: mkdtempSync(join(tmpdir(), 'kestrel-relocate-')), baseUrl: '/uploads' })
})

describe('relocateMedia', () => {
  it('moves the object + derivatives to the new folder, updates the row, deletes the old objects', async () => {
    const m = await seed('pics/hero.png', 'pics', 'hero.png', {
      '320.webp': { key: 'pics/hero.png-320.webp', width: 320, height: 240, mime: 'image/webp' },
    })
    await relocateMedia(db, driver, m.id, { folder: 'archive' })
    const row = rowOf(m.id)
    expect(row.storageKey).toBe('archive/hero.png')
    expect(row.folder).toBe('archive')
    expect(row.derivatives['320.webp'].key).toBe('archive/hero.png-320.webp')
    expect(await driver.exists!('archive/hero.png')).toBe(true)
    expect(await driver.exists!('archive/hero.png-320.webp')).toBe(true)
    expect(await driver.exists!('pics/hero.png')).toBe(false)
    expect(await driver.exists!('pics/hero.png-320.webp')).toBe(false)
  })
  it('renames in place (new filename, same folder)', async () => {
    const m = await seed('docs/a.pdf', 'docs', 'a.pdf')
    await relocateMedia(db, driver, m.id, { filename: 'b.pdf' })
    expect(rowOf(m.id).storageKey).toBe('docs/b.pdf')
    expect(await driver.exists!('docs/b.pdf')).toBe(true)
    expect(await driver.exists!('docs/a.pdf')).toBe(false)
  })
  it('rejects moving onto an existing derivative file (no media row) instead of clobbering it', async () => {
    await seed('pics/logo.png', 'pics', 'logo.png', {
      '320.webp': { key: 'pics/logo-320.webp', width: 320, height: 240, mime: 'image/webp' },
    })
    const m2 = await seed('pics/other.webp', 'pics', 'other.webp')
    await expect(relocateMedia(db, driver, m2.id, { filename: 'logo-320.webp' })).rejects.toThrow()
    expect(await driver.exists!('pics/logo-320.webp')).toBe(true) // derivative untouched
    expect(await driver.exists!('pics/other.webp')).toBe(true) // source untouched
    expect(rowOf(m2.id).storageKey).toBe('pics/other.webp') // row untouched
  })
  it('compensates on a destination collision: source intact, occupant untouched', async () => {
    await seed('archive/hero.png', 'archive', 'hero.png') // occupies the target storageKey
    const m = await seed('pics/hero.png', 'pics', 'hero.png')
    await expect(relocateMedia(db, driver, m.id, { folder: 'archive' })).rejects.toThrow()
    expect(await driver.exists!('pics/hero.png')).toBe(true)        // source untouched
    expect(rowOf(m.id).storageKey).toBe('pics/hero.png')           // row untouched
    expect(await driver.exists!('archive/hero.png')).toBe(true)     // occupant untouched (no copy happened)
  })

  it('two concurrent relocates onto the SAME destination key serialize: one wins cleanly, the other 409s with nothing lost', async () => {
    const a = await seed('x/pic.png', 'x', 'pic.png')
    const b = await seed('y/pic.png', 'y', 'pic.png')
    // Every copy yields a tick first — enough for two in-flight relocates to interleave their
    // (otherwise unlocked) clash-check/copy/update steps against each other.
    const realCopy = driver.copy.bind(driver)
    const slow = { ...driver, copy: async (src: string, dst: string) => { await new Promise((r) => setTimeout(r, 5)); return realCopy(src, dst) } }
    const results = await Promise.allSettled([
      relocateMedia(db, slow, a.id, { folder: 'd' }),
      relocateMedia(db, slow, b.id, { folder: 'd' }),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const failed = results.filter((r) => r.status === 'rejected').length
    expect(ok).toBe(1)
    expect(failed).toBe(1)
    // whichever one landed at d/pic.png must still actually be there — the loser's compensation must
    // never delete the WINNER's blob out from under it (a shared-key race, unlocked, can do exactly that)
    const winnerId = rowOf(a.id).storageKey === 'd/pic.png' ? a.id : b.id
    const loserId = winnerId === a.id ? b.id : a.id
    expect(rowOf(winnerId).storageKey).toBe('d/pic.png')
    expect(await driver.exists!('d/pic.png')).toBe(true)
    // the loser's row + source object are untouched (still exactly where it started)
    const loserKey = loserId === a.id ? 'x/pic.png' : 'y/pic.png'
    expect(rowOf(loserId).storageKey).toBe(loserKey)
    expect(await driver.exists!(loserKey)).toBe(true)
  })

  it('emits a media write event so the publisher re-renders pages that embed the moved media', async () => {
    const events: WriteEvent[] = []
    registerWriteListener((e) => events.push(e))
    try {
      const m = await seed('pics/hero.png', 'pics', 'hero.png')
      events.length = 0 // ignore the seed create
      await relocateMedia(db, driver, m.id, { folder: 'archive' })
      const relocate = events.find((e) => e.def.name === 'media' && e.before && e.after)
      expect(relocate).toBeTruthy()
      expect((relocate!.after as { id: number }).id).toBe(m.id)
    } finally {
      clearWriteListeners()
    }
  })
})

describe('duplicateMedia', () => {
  it('copies the object + derivatives to a new key and inserts a new row (source intact)', async () => {
    const m = await seed('pics/hero.png', 'pics', 'hero.png', {
      '320.webp': { key: 'pics/hero.png-320.webp', width: 320, height: 240, mime: 'image/webp' },
    })
    const dup = await duplicateMedia(db, driver, m.id, { folder: 'pics', filename: 'hero-copy.png' })

    expect(dup.id).not.toBe(m.id)
    const row = rowOf(dup.id)
    expect(row.storageKey).toBe('pics/hero-copy.png')
    expect(row.derivatives['320.webp'].key).toBe('pics/hero-copy.png-320.webp')
    expect(await driver.exists!('pics/hero-copy.png')).toBe(true)
    expect(await driver.exists!('pics/hero-copy.png-320.webp')).toBe(true)
    expect(await driver.exists!('pics/hero.png')).toBe(true)        // source intact
    expect(rowOf(m.id).storageKey).toBe('pics/hero.png')
  })
  it('rejects 409 when the duplicate target key is already taken', async () => {
    const m = await seed('pics/hero.png', 'pics', 'hero.png')
    await seed('pics/taken.png', 'pics', 'taken.png')
    await expect(duplicateMedia(db, driver, m.id, { filename: 'taken.png' })).rejects.toThrow()
  })
  it('rejects copying onto an existing derivative file (no media row)', async () => {
    await seed('pics/logo.png', 'pics', 'logo.png', {
      '320.webp': { key: 'pics/logo-320.webp', width: 320, height: 240, mime: 'image/webp' },
    })
    const m = await seed('pics/other.webp', 'pics', 'other.webp')
    await expect(duplicateMedia(db, driver, m.id, { filename: 'logo-320.webp' })).rejects.toThrow()
    expect(await driver.exists!('pics/logo-320.webp')).toBe(true) // derivative untouched
  })
})
