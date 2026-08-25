import { describe, it, expect } from 'vitest'
import type { ValidatedInput } from '@kestrel/contracts'
import { asValidated, type Row, type WriteUnit } from '../../../../src/server/pipeline/steps/shared.js'

describe('WriteUnit.values — the ValidatedInput brand gate persist reads through', () => {
  it('accepts a row branded via asValidated (what validate.ts produces)', () => {
    const unit: WriteUnit = { values: asValidated({ title: 'x' }), before: null }
    expect(unit.values.title).toBe('x')
  })

  it('rejects a raw object literal at compile time — a step cannot hand persist unvalidated input', () => {
    // @ts-expect-error a plain object is not branded ValidatedInput; must go through asValidated/decodeInput
    const unit: WriteUnit = { values: { title: 'x' }, before: null }
    expect(unit).toBeTruthy()
  })

  it('rejects a plain Row read as ValidatedInput — persist.ts must declare the brand at ctx.work reads, not downcast to Row', () => {
    const row: Row = { title: 'x' }
    // @ts-expect-error a Row (what a bare `as Row` cast produces) is not a ValidatedInput without going through asValidated
    const patchValues: ValidatedInput = row
    expect(patchValues).toBeTruthy()
  })
})
