import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { clearPipelines, registerPipeline } from '@michaelthielemann/kestrel-core'
import { runPipelineForEventAsync } from '@michaelthielemann/kestrel-access'
import { clearRateLimits } from '../utils/rate-limit'
import { proofingSubmitPipeline } from './submit'

// Only the ingress path is exercised here (the flood guard runs before the body is read), so the body
// reader is stubbed to return garbage — every request that clears the guard fails at JSON.parse with a
// 400, which is exactly the "cheap garbage flood" the guard exists to bound. The limiter itself is the
// real production module.
vi.mock('../utils/read-capped-body', () => ({ readCappedBody: async () => Buffer.from('not json') }))

function eventFor(ip: string): H3Event {
  const event = createEvent(
    {
      method: 'POST',
      url: '/api/proofingSubmit',
      headers: { 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: ip },
    } as never,
    { setHeader() {} } as never,
  )
  event.context.principal = { userId: null, role: 'anonymous' } as never
  return event
}

const run = (ip: string) => runPipelineForEventAsync(eventFor(ip), { op: 'proofingSubmit' })

beforeAll(() => {
  clearPipelines()
  registerPipeline(proofingSubmitPipeline)
})

beforeEach(() => { clearRateLimits() })

describe('proofingSubmit pipeline — anonymous flood guard', () => {
  it('holds a strict per-IP rate: a garbage flood from one address runs into 429 within the first minute', async () => {
    for (let i = 0; i < 30; i++) {
      await expect(run('203.0.113.9')).rejects.toMatchObject({ statusCode: 400 })
    }
    await expect(run('203.0.113.9')).rejects.toMatchObject({ statusCode: 429 })
  })

  it('buckets IPv6 by /64 like the login throttle, so rotating source addresses gets no fresh budget', async () => {
    for (let i = 0; i < 30; i++) {
      await expect(run(`2001:db8:1:2::${i + 1}`)).rejects.toMatchObject({ statusCode: 400 })
    }
    await expect(run('2001:db8:1:2::ff')).rejects.toMatchObject({ statusCode: 429 })
    // a genuinely different customer prefix is unaffected
    await expect(run('2001:db8:9:9::1')).rejects.toMatchObject({ statusCode: 400 })
  })
})
