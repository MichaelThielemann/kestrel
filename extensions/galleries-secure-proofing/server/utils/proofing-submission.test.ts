import { describe, it, expect } from 'vitest'
import {
  parseSubmission, exceedsGalleryQuota, MAX_SEALED_B64, MAX_CUSTOMERS_PER_GALLERY,
  exceedsGlobalQuota, MAX_TOTAL_ROWS, newCustomerRateKey, MAX_NEW_CUSTOMERS_PER_IP_PER_SLUG,
} from './proofing-submission'

const ok = { gallerySlug: '/hochzeit-mueller', customerId: 'abc123', sealed: { iv: 'aXY=', data: 'ZGF0YQ==' }, writeSecret: 'wsecret-123' }

describe('parseSubmission — public back-channel guard', () => {
  it('accepts a well-formed submission', () => {
    expect(parseSubmission(ok)).toEqual(ok)
  })

  it('rejects non-objects and missing fields', () => {
    expect(parseSubmission(null)).toBeNull()
    expect(parseSubmission('x')).toBeNull()
    expect(parseSubmission({ ...ok, gallerySlug: '' })).toBeNull()
    expect(parseSubmission({ ...ok, customerId: undefined })).toBeNull()
    expect(parseSubmission({ ...ok, sealed: undefined })).toBeNull()
    expect(parseSubmission({ ...ok, sealed: { iv: 'x' } })).toBeNull()
    expect(parseSubmission({ ...ok, sealed: { iv: 1, data: 2 } })).toBeNull()
    expect(parseSubmission({ ...ok, writeSecret: undefined })).toBeNull() // required possession credential
    expect(parseSubmission({ ...ok, writeSecret: '' })).toBeNull()
  })

  it('rejects oversized slug / customerId / ciphertext / writeSecret', () => {
    expect(parseSubmission({ ...ok, gallerySlug: 'x'.repeat(301) })).toBeNull()
    expect(parseSubmission({ ...ok, customerId: 'x'.repeat(101) })).toBeNull()
    expect(parseSubmission({ ...ok, sealed: { iv: 'a', data: 'x'.repeat(MAX_SEALED_B64) } })).toBeNull()
    expect(parseSubmission({ ...ok, writeSecret: 'x'.repeat(129) })).toBeNull()
  })

  it('strips extra fields (returns only the narrowed shape)', () => {
    expect(parseSubmission({ ...ok, evil: 'drop me', sealed: { ...ok.sealed, extra: 'x' } })).toEqual(ok)
  })
})

describe('exceedsGalleryQuota — cap distinct customer rows per gallery', () => {
  it('allows a new customer while the gallery is below the cap', () => {
    expect(exceedsGalleryQuota(0, true)).toBe(false)
    expect(exceedsGalleryQuota(MAX_CUSTOMERS_PER_GALLERY - 1, true)).toBe(false)
  })

  it('rejects a NEW customer once the gallery is at/over the cap', () => {
    expect(exceedsGalleryQuota(MAX_CUSTOMERS_PER_GALLERY, true)).toBe(true)
    expect(exceedsGalleryQuota(MAX_CUSTOMERS_PER_GALLERY + 5, true)).toBe(true)
  })

  it('always allows an UPDATE to an existing customer (not a new row), even at the cap', () => {
    expect(exceedsGalleryQuota(MAX_CUSTOMERS_PER_GALLERY, false)).toBe(false)
    expect(exceedsGalleryQuota(MAX_CUSTOMERS_PER_GALLERY + 100, false)).toBe(false)
  })

  it('the cap is generous vs any real proofing audience', () => {
    expect(MAX_CUSTOMERS_PER_GALLERY).toBeGreaterThanOrEqual(100)
  })
})

describe('exceedsGlobalQuota — absolute backstop the attacker-controlled slug cannot sidestep', () => {
  it('rejects a new row once the whole table is at/over the global cap', () => {
    expect(exceedsGlobalQuota(0)).toBe(false)
    expect(exceedsGlobalQuota(MAX_TOTAL_ROWS - 1)).toBe(false)
    expect(exceedsGlobalQuota(MAX_TOTAL_ROWS)).toBe(true)
    expect(exceedsGlobalQuota(MAX_TOTAL_ROWS + 1000)).toBe(true)
  })
  it('the global cap dwarfs a single gallery so it never blocks legitimate multi-gallery use', () => {
    expect(MAX_TOTAL_ROWS).toBeGreaterThan(MAX_CUSTOMERS_PER_GALLERY * 10)
  })
})

describe('newCustomerRateKey — per-IP-per-slug budget key (blunts a targeted lockout)', () => {
  it('is namespaced and distinct per IP and per slug', () => {
    expect(newCustomerRateKey('203.0.113.9', '/hochzeit')).toBe('newcust:203.0.113.9:/hochzeit')
    expect(newCustomerRateKey('a', 'g')).not.toBe(newCustomerRateKey('a', 'h'))
    expect(newCustomerRateKey('a', 'g')).not.toBe(newCustomerRateKey('b', 'g'))
    // distinct from the plain per-IP submission-rate key (`clientIp`), so the two budgets don't collide
    expect(newCustomerRateKey('203.0.113.9', 'x')).not.toBe('203.0.113.9')
  })
  it('one IP can seed only a few NEW identities per gallery (many IPs needed to fill the per-gallery cap)', () => {
    expect(MAX_NEW_CUSTOMERS_PER_IP_PER_SLUG).toBeLessThan(MAX_CUSTOMERS_PER_GALLERY / 10)
  })
})
