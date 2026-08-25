import { Arbitrary, Either, Schema } from 'effect'
import { test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { EventEnvelope } from '../src/envelope.js'

function roundTrips<A, I>(schema: Schema.Schema<A, I>) {
  const decode = Schema.decodeUnknownSync(schema)
  const encode = Schema.encodeSync(schema)
  test.prop([Arbitrary.make(schema)])('decode(encode(x)) === x', (value) => {
    expect(decode(encode(value))).toEqual(value)
  })
}

function rejectsMalformed(name: string, malformed: unknown) {
  it(`rejects malformed input: ${name}`, () => {
    const result = Schema.decodeUnknownEither(EventEnvelope)(malformed)
    expect(Either.isLeft(result)).toBe(true)
  })
}

const valid = {
  id: '2f5b3e0a-6b1a-4a2a-9a3b-1c2d3e4f5a6b',
  name: 'post.published',
  version: 1,
  aggregate: { collection: 'posts', recordId: 1 },
  sequence: 1,
  correlationId: 'corr-1',
  causation: { pipeline: 'publish', op: 'update' },
  occurredAt: '2024-01-01T00:00:00.000Z',
  payload: { title: 'hello' },
}

describe('EventEnvelope', () => {
  roundTrips(EventEnvelope)

  rejectsMalformed('bad UUID', { ...valid, id: 'not-a-uuid' })
  rejectsMalformed('float version', { ...valid, version: 1.5 })
  rejectsMalformed('missing aggregate', (() => {
    const { aggregate: _aggregate, ...rest } = valid
    return rest
  })())

  it('decodes an ISO occurredAt string into DateTimeUtc', () => {
    const decoded = Schema.decodeUnknownSync(EventEnvelope)(valid)
    expect(decoded.occurredAt.pipe).toBeDefined() // DateTime.Utc value, not a raw string
  })

  it('re-encodes occurredAt stably to the same ISO string', () => {
    const decode = Schema.decodeUnknownSync(EventEnvelope)
    const encode = Schema.encodeSync(EventEnvelope)
    const decoded = decode(valid)
    const reEncoded = encode(decoded)
    expect(reEncoded.occurredAt).toBe(valid.occurredAt)
  })
})
