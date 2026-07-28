import { describe, it, expect } from 'vitest'
import {
  emptyModel, encodeIndex, decodeIndex, addFile, removeFile, addFolder,
  removeFolderRecursive, renameFolder, moveFile, type WorkingModel, type WorkingFile,
} from './index-codec'
import type { SealedB64 } from './manifest'

// Reversible fake crypto: seal wraps the plaintext, open unwraps it — lets the codec round-trip be asserted
// without WebCrypto (the real seal/open are unit-tested in crypto.test.ts).
const seal = async (s: string): Promise<SealedB64> => ({ iv: 'iv', data: `enc:${s}` })
const open = async (s: SealedB64): Promise<string> => s.data.replace(/^enc:/, '')

const file = (blobId: string, name: string, dir = ''): WorkingFile => ({ blobId, ivB64: 'bv', name, mime: 'image/jpeg', size: 10, dir })

describe('index-codec encode/decode', () => {
  it('round-trips files (incl. dir + sealed alt) and folders through seal/open', async () => {
    const model: WorkingModel = {
      files: [{ ...file('b1', 'a.jpg', 'Trauung'), alt: 'a bride' }, file('b2', 'root.jpg')],
      folders: ['Trauung', 'Empty/Sub'],
    }
    const index = await encodeIndex(model, seal)
    expect(index.files[0].name).toEqual({ iv: 'iv', data: 'enc:a.jpg' })
    expect(index.files[0].dir).toEqual({ iv: 'iv', data: 'enc:Trauung' })
    expect(index.files[0].alt).toEqual({ iv: 'iv', data: 'enc:a bride' }) // alt is SEALED
    expect(index.files[1].dir).toBeUndefined() // root file carries no dir
    expect(index.files[1].alt).toBeUndefined() // no alt → no field
    expect(index.folders).toHaveLength(2)
    expect(await decodeIndex(index, open)).toEqual(model)
  })

  it('encodes an empty model', async () => {
    expect(await encodeIndex(emptyModel(), seal)).toEqual({ v: 1, files: [], folders: [] })
  })
})

describe('index-codec mutations (pure)', () => {
  it('addFile / removeFile', () => {
    let m = emptyModel()
    m = addFile(m, file('b1', 'a.jpg'))
    expect(m.files).toHaveLength(1)
    const { model, removed } = removeFile(m, 'b1')
    expect(model.files).toHaveLength(0)
    expect(removed?.blobId).toBe('b1')
  })

  it('addFolder dedupes + ignores root', () => {
    let m = addFolder(emptyModel(), 'a/b')
    m = addFolder(m, 'a/b') // dup
    m = addFolder(m, '') // root no-op
    expect(m.folders).toEqual(['a/b'])
  })

  it('removeFolderRecursive drops subtree + reports blobIds', () => {
    let m: WorkingModel = { files: [file('b1', 'x', 'Party'), file('b2', 'y', 'Party/Tag1'), file('b3', 'z', 'Other')], folders: ['Party', 'Party/Tag1', 'Other'] }
    const { model, removedBlobIds } = removeFolderRecursive(m, 'Party')
    expect(removedBlobIds.sort()).toEqual(['b1', 'b2'])
    expect(model.files.map((f) => f.blobId)).toEqual(['b3'])
    expect(model.folders).toEqual(['Other'])
  })

  it('renameFolder rewrites file dirs + folder entries under the prefix only', () => {
    const m: WorkingModel = { files: [file('b1', 'x', 'Party/Tag1'), file('b2', 'y', 'Partyy')], folders: ['Party', 'Party/Tag1', 'Partyy'] }
    const out = renameFolder(m, 'Party', 'Wedding')
    expect(out.files.find((f) => f.blobId === 'b1')?.dir).toBe('Wedding/Tag1')
    expect(out.files.find((f) => f.blobId === 'b2')?.dir).toBe('Partyy') // prefix-collision untouched
    expect(out.folders.sort()).toEqual(['Partyy', 'Wedding', 'Wedding/Tag1'])
  })

  it('renameFolder refuses to move a folder into its own descendant (no subtree corruption)', () => {
    const m: WorkingModel = { files: [file('b1', 'x', 'Party/Tag1')], folders: ['Party', 'Party/Tag1'] }
    expect(renameFolder(m, 'Party', 'Party/Tag1/Deep')).toBe(m) // unchanged
    expect(renameFolder(m, 'Party', 'Party/Sub')).toBe(m) // direct descendant target also refused
  })

  it('moveFile sets a single file dir', () => {
    const m = addFile(emptyModel(), file('b1', 'x', 'A'))
    expect(moveFile(m, 'b1', 'B/C').files[0].dir).toBe('B/C')
    expect(moveFile(m, 'b1', '').files[0].dir).toBe('') // to root
  })
})
