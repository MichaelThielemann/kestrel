import { describe, it, expect } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createError } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import References from './references.vue'

// 'ok' = check succeeded, nothing broken; 'fail' = the check itself failed; 'broken' = found a bad ref.
let refsMode: 'ok' | 'fail' | 'broken' = 'ok'
registerEndpoint('/api/brokenRefs', () => {
  if (refsMode === 'fail') throw createError({ statusCode: 500, statusMessage: 'Boom' })
  if (refsMode === 'broken') return [{ source: { collection: 'pages', id: 1 }, target: { collection: 'posts', id: 2 }, reason: 'missing' }]
  return []
})

describe('references page', () => {
  it('shows a neutral error — NOT the green all-clear — when the integrity check fails', async () => {
    refsMode = 'fail'
    const w = await mountSuspended(References)
    await flushPromises()
    expect(w.find('.refs__error').exists()).toBe(true)
    expect(w.find('.ui-empty').exists()).toBe(false) // must not imply a verified-clean site
    expect(w.find('.refs__table').exists()).toBe(false)
  })

  it('shows the all-clear empty state when the check succeeds with nothing broken', async () => {
    refsMode = 'ok'
    const w = await mountSuspended(References)
    await flushPromises()
    expect(w.find('.ui-empty').exists()).toBe(true)
    expect(w.find('.refs__error').exists()).toBe(false)
  })

  it('lists broken references when the check finds some', async () => {
    refsMode = 'broken'
    const w = await mountSuspended(References)
    await flushPromises()
    expect(w.find('.refs__table').exists()).toBe(true)
    expect(w.text()).toContain('pages #1')
  })
})
