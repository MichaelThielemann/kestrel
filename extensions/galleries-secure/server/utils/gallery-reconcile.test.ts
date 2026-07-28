import { describe, it, expect } from 'vitest'
import { orphanBlobKeys, stalePruneKeys } from './gallery-reconcile'

const A = '11111111-1111-1111-1111-111111111111.bin'
const B = '22222222-2222-2222-2222-222222222222.bin'
const C = '33333333-3333-3333-3333-333333333333.bin'
const ns = 'galleries-secure/ns'

describe('orphanBlobKeys — strays the index no longer references', () => {
  it('returns .bin keys whose filename is not in the live set', () => {
    const keys = [`${ns}/${A}`, `${ns}/${B}`, `${ns}/${C}`]
    expect(orphanBlobKeys(keys, [A, C])).toEqual([`${ns}/${B}`]) // B abandoned
  })

  it('never deletes index.json or non-.bin keys', () => {
    const keys = [`${ns}/index.json`, `${ns}/notes.txt`, `${ns}/${A}`]
    expect(orphanBlobKeys(keys, [])).toEqual([`${ns}/${A}`]) // only the stray blob, not index.json/notes.txt
  })

  it('returns nothing when every blob is live', () => {
    expect(orphanBlobKeys([`${ns}/${A}`, `${ns}/${B}`], [A, B])).toEqual([])
  })

  it('matches by filename, tolerating live ids passed with or without path noise', () => {
    expect(orphanBlobKeys([`${ns}/${A}`], [A])).toEqual([])
    expect(orphanBlobKeys([`${ns}/${A}`], [])).toEqual([`${ns}/${A}`])
  })
})

describe('stalePruneKeys — only prune orphans older than the grace window', () => {
  const now = 10_000_000
  const grace = 60 * 60 * 1000 // 1h
  it('spares a freshly-uploaded (not-yet-indexed) blob from a racing reconcile', () => {
    const cands = [
      { key: `${ns}/${A}`, mtimeMs: now - 5_000 },        // just uploaded → keep
      { key: `${ns}/${B}`, mtimeMs: now - grace - 1 },     // old orphan → prune
    ]
    expect(stalePruneKeys(cands, now, grace)).toEqual([`${ns}/${B}`])
  })
  it('keeps a candidate whose age is unknown (stat returned null)', () => {
    expect(stalePruneKeys([{ key: `${ns}/${A}`, mtimeMs: null }], now, grace)).toEqual([])
  })
})
