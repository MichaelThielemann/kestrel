import { Arbitrary, Either, Schema } from 'effect'
import { test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import {
  EscapedHtml,
  PublishedSnapshot,
  ResolvedSlug,
  SanitizedRichtext,
  ValidatedInput,
} from '../src/brands.js'

// `__proto__` as a data key is indistinguishable from setting the prototype once spread through a plain
// object, so any generated value carrying it as an own property is excluded — a JS object-literal quirk,
// not something the schema's codec is responsible for preserving.
function ownsProtoKey(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, '__proto__')
}

function roundTrips<A, I>(name: string, schema: Schema.Schema<A, I>) {
  const decode = Schema.decodeUnknownSync(schema)
  const encode = Schema.encodeSync(schema)
  const arbitrary = Arbitrary.make(schema).filter((value) => !ownsProtoKey(value))
  test.prop([arbitrary])(`${name}: decode(encode(x)) === x`, (value) => {
    expect(decode(encode(value))).toEqual(value)
  })
}

function rejectsMalformed<A, I>(schema: Schema.Schema<A, I>, malformed: unknown) {
  it('rejects malformed input with a ParseError', () => {
    const result = Schema.decodeUnknownEither(schema)(malformed)
    expect(Either.isLeft(result)).toBe(true)
  })
}

describe('SanitizedRichtext', () => {
  roundTrips('SanitizedRichtext', SanitizedRichtext)
  rejectsMalformed(SanitizedRichtext, 42)
})

describe('EscapedHtml', () => {
  roundTrips('EscapedHtml', EscapedHtml)
  rejectsMalformed(EscapedHtml, 42)
})

describe('ResolvedSlug', () => {
  roundTrips('ResolvedSlug', ResolvedSlug)
  rejectsMalformed(ResolvedSlug, 42)
})

describe('ValidatedInput', () => {
  roundTrips('ValidatedInput', ValidatedInput)
  // The underlying struct shape is implementation-chosen; any non-object input must fail regardless.
  rejectsMalformed(ValidatedInput, null)
})

describe('PublishedSnapshot', () => {
  roundTrips('PublishedSnapshot', PublishedSnapshot)
  // Any struct-based schema rejects `null` regardless of its fields.
  rejectsMalformed(PublishedSnapshot, null)
})
