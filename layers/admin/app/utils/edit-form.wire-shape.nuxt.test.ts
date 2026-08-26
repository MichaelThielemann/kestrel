import { describe, it, expect } from 'vitest'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { ValidationFailed } from '@michaelthielemann/kestrel-contracts'
import { readFetchError, mapServerErrors, parseBlockErrors } from './edit-form'
import { toHttpError } from '@michaelthielemann/kestrel-core'

// Binds the REAL server error shape to the admin consumer end to end: a real ValidationFailed instance,
// through the real edge translation (toHttpError — the same function core/server/api/[...path].ts uses),
// over a real HTTP response, parsed by the real client-side ofetch error handling — no hand-rolled
// {statusCode, data} object standing in for any of it.
registerEndpoint('/api/posts/createOne', { method: 'POST', handler: () => {
  throw toHttpError(new ValidationFailed({
    issues: [
      { path: ['title'], message: 'Required' },
      { path: ['content', 0, 'props', 'caption'], message: 'Caption is required' },
    ],
  }))
} })

async function fetchRealValidationFailure(): Promise<unknown> {
  try {
    await $fetch('/api/posts/createOne', { method: 'POST', body: {} })
  } catch (e) {
    return e
  }
  throw new Error('expected the endpoint to reject')
}

describe('the real server ValidationFailed wire shape, bound end-to-end to the admin consumer', () => {
  it('mapServerErrors reads the field-level message from a real ofetch-wrapped response', async () => {
    const info = readFetchError(await fetchRealValidationFailure())
    expect(info.statusCode).toBe(400)
    expect(info.issues.length).toBeGreaterThan(0)
    expect(mapServerErrors(info.issues).fields.title).toBe('Required')
  })

  it('parseBlockErrors resolves a real nested content[i].props.<field> issue to its block id', async () => {
    const info = readFetchError(await fetchRealValidationFailure())
    const content = [{ id: 'blk1', type: 'hero', props: { caption: '' } }]
    const errors = parseBlockErrors(info.issues, content)
    expect(errors.blk1?.caption).toBe('Caption is required')
  })
})
