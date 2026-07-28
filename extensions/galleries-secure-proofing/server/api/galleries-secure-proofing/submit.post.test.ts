import { describe, it, expect, beforeEach } from 'vitest'
import { createError } from 'h3'
import { throttleKey } from '../../../../../layers/auth/server/utils/client-ip'
import { rateLimit, clearRateLimits } from '../../utils/rate-limit'
import {
  parseSubmission, exceedsGalleryQuota, exceedsGlobalQuota, newCustomerRateKey,
  MAX_NEW_CUSTOMERS_PER_IP_PER_SLUG, NEW_CUSTOMER_WINDOW_MS, MAX_TOTAL_ROWS,
} from '../../utils/proofing-submission'

interface FakeEvent { headers?: Record<string, string>; ip?: string; node: { req: unknown } }

// The handler is a Nitro route: its auto-imported helpers are plain globals in a node test. Only the ingress
// path is exercised here (the flood guard runs before the body is read), so the body reader is stubbed to
// return garbage — every request that clears the guard fails at JSON.parse with a 400, which is exactly the
// "cheap garbage flood" the guard exists to bound. The limiter itself is the real production module.
Object.assign(globalThis, {
  defineEventHandler: (h: unknown) => h,
  getRequestHeader: (event: FakeEvent, name: string) => event.headers?.[name],
  createError,
  clientIp: (event: FakeEvent) => event.ip ?? '203.0.113.9',
  throttleKey,
  rateLimit,
  readCappedBody: async () => Buffer.from('not json'),
  parseSubmission,
  exceedsGalleryQuota,
  exceedsGlobalQuota,
  newCustomerRateKey,
  MAX_NEW_CUSTOMERS_PER_IP_PER_SLUG,
  NEW_CUSTOMER_WINDOW_MS,
  MAX_TOTAL_ROWS,
})

const handler = (await import('./submit.post')).default as unknown as (event: FakeEvent) => Promise<unknown>

const ev = (ip: string): FakeEvent => ({ headers: {}, ip, node: { req: {} } })

beforeEach(() => { clearRateLimits() })

describe('POST /api/galleries-secure-proofing/submit — anonymous flood guard', () => {
  it('holds a strict per-IP rate: a garbage flood from one address runs into 429 within the first minute', async () => {
    for (let i = 0; i < 30; i++) {
      await expect(handler(ev('203.0.113.9'))).rejects.toMatchObject({ statusCode: 400 })
    }
    await expect(handler(ev('203.0.113.9'))).rejects.toMatchObject({ statusCode: 429 })
  })

  it('buckets IPv6 by /64 like the login throttle, so rotating source addresses gets no fresh budget', async () => {
    for (let i = 0; i < 30; i++) {
      await expect(handler(ev(`2001:db8:1:2::${i + 1}`))).rejects.toMatchObject({ statusCode: 400 })
    }
    await expect(handler(ev('2001:db8:1:2::ff'))).rejects.toMatchObject({ statusCode: 429 })
    // a genuinely different customer prefix is unaffected
    await expect(handler(ev('2001:db8:9:9::1'))).rejects.toMatchObject({ statusCode: 400 })
  })
})
