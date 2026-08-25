import { Arbitrary, Either, Schema } from 'effect'
import { test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  Conflict,
  Forbidden,
  Locked,
  NotFound,
  Quarantined,
  Unauthorized,
  ValidationFailed,
} from '../src/errors.js'

// decode(encode(x)) must reproduce x for every generated instance — pins the codec, not just construction.
function roundTrips<A, I>(schema: Schema.Schema<A, I>) {
  const decode = Schema.decodeUnknownSync(schema)
  const encode = Schema.encodeSync(schema)
  test.prop([Arbitrary.make(schema)])('decode(encode(x)) === x', (value) => {
    expect(decode(encode(value))).toEqual(value)
  })
}

function rejectsMalformed<A, I>(schema: Schema.Schema<A, I>, malformed: unknown) {
  it('rejects malformed input with a ParseError', () => {
    const result = Schema.decodeUnknownEither(schema)(malformed)
    expect(Either.isLeft(result)).toBe(true)
  })
}

describe('NotFound', () => {
  roundTrips(NotFound)
  rejectsMalformed(NotFound, { _tag: 'NotFound', collection: 'posts', id: 'not-a-number' })
  it('carries its own _tag', () => {
    expect(new NotFound({ collection: 'posts', id: 1 })._tag).toBe('NotFound')
  })
  it('ids is optional — a single-record lookup carries none', () => {
    expect(new NotFound({ collection: 'posts', id: 1 }).ids).toBeUndefined()
  })
  it('a batch lookup carries every missing id, not just the first', () => {
    expect(new NotFound({ collection: 'posts', id: 1, ids: [1, 5, 9] }).ids).toEqual([1, 5, 9])
  })
})

describe('Forbidden', () => {
  roundTrips(Forbidden)
  rejectsMalformed(Forbidden, { _tag: 'Forbidden', reason: 42 })
  it('carries its own _tag', () => {
    expect(new Forbidden({ reason: 'nope' })._tag).toBe('Forbidden')
  })
})

describe('Conflict', () => {
  roundTrips(Conflict)
  rejectsMalformed(Conflict, { _tag: 'Conflict', field: 42, value: 'x' })
  it('carries its own _tag', () => {
    expect(new Conflict({ field: 'slug', value: 'dup' })._tag).toBe('Conflict')
  })
  it('details is optional — a plain duplicate-value conflict carries none', () => {
    expect(new Conflict({ field: 'slug', value: 'dup' }).details).toBeUndefined()
  })
  it('carries a duplicate-upload suggestion/existingId', () => {
    const err = new Conflict({ field: 'storageKey', value: 'a.png', details: { kind: 'duplicate', suggestion: 'a-2.png', existingId: 7 } })
    expect(err.details).toEqual({ kind: 'duplicate', suggestion: 'a-2.png', existingId: 7 })
  })
  it('carries a stale-write baseline mismatch', () => {
    const err = new Conflict({ field: 'updatedAt', value: '1700000000000', details: { kind: 'stale', expectedUpdatedAt: '1700000000000', actualUpdatedAt: '1700000005000' } })
    expect(err.details).toEqual({ kind: 'stale', expectedUpdatedAt: '1700000000000', actualUpdatedAt: '1700000005000' })
  })
})

describe('ValidationFailed', () => {
  roundTrips(ValidationFailed)
  rejectsMalformed(ValidationFailed, { _tag: 'ValidationFailed', issues: 'not-an-array' })
  it('carries its own _tag', () => {
    expect(new ValidationFailed({ issues: [{ path: ['title'], message: 'required' }] })._tag).toBe('ValidationFailed')
  })
  // The path is a real Zod-shaped segment array, not a joined string: numeric segments (repeater/block
  // indices) and string segments must both survive, and stay comparable one at a time.
  it('an issue path keeps mixed string/number segments as an array, not a joined string', () => {
    const err = new ValidationFailed({ issues: [{ path: ['content', 3, 'caption'], message: 'required' }] })
    expect(err.issues[0]!.path).toEqual(['content', 3, 'caption'])
  })
  it('an issue may carry an optional code alongside path/message', () => {
    const err = new ValidationFailed({ issues: [{ path: ['title'], message: 'required', code: 'invalid_type' }] })
    expect(err.issues[0]!.code).toBe('invalid_type')
  })
})

describe('Unauthorized', () => {
  roundTrips(Unauthorized)
  rejectsMalformed(Unauthorized, { _tag: 'Unauthorized', reason: 42 })
  it('carries its own _tag', () => {
    expect(new Unauthorized({ reason: 'invalid credentials' })._tag).toBe('Unauthorized')
  })
})

describe('Locked', () => {
  roundTrips(Locked)
  rejectsMalformed(Locked, { _tag: 'Locked', until: 12345 })
  it('carries its own _tag', () => {
    expect(new Locked({ until: '2026-01-01T00:00:00Z' })._tag).toBe('Locked')
  })
})

describe('Quarantined', () => {
  roundTrips(Quarantined)
  rejectsMalformed(Quarantined, { _tag: 'Quarantined', id: 'not-a-number' })
  it('carries its own _tag', () => {
    expect(new Quarantined({ id: 7 })._tag).toBe('Quarantined')
  })
})
