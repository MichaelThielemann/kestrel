import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent } from 'vue'
import { fieldComponents, resolveFieldComponent, registerFieldComponent } from './field-registry'
import type { FieldType } from '@michaelthielemann/kestrel-core'
import FieldText from '../components/field/Text.vue'
import FieldLink from '../components/field/Link.vue'

describe('field registry', () => {
  it('maps exactly the implemented types', () => {
    expect(Object.keys(fieldComponents).sort()).toEqual(['boolean', 'choice', 'datetime', 'json', 'link', 'number', 'relation', 'repeater', 'richtext', 'slug', 'text'])
  })

  it('resolves an implemented type to its widget', () => {
    expect(resolveFieldComponent('text')).toBe(FieldText)
  })

  it('returns undefined for a not-yet-implemented type', () => {
    expect(resolveFieldComponent('bogus' as FieldType)).toBeUndefined()
  })

  it('resolves link to FieldLink', () => {
    expect(resolveFieldComponent('link')).toBe(FieldLink)
  })

  it('resolves repeater to a defined component (async wrapper)', () => {
    const resolved = resolveFieldComponent('repeater')
    expect(resolved).toBeDefined()
    expect(typeof resolved).toBe('object')
  })
})

describe('registerFieldComponent', () => {
  // it mutates the shared singleton → restore so the "exactly N types" assertion stays order-independent
  afterEach(() => { delete (fieldComponents as Record<string, unknown>).media })
  it('adds a component the resolver then returns', () => {
    const Stub = defineComponent({ template: '<div/>' })
    expect(resolveFieldComponent('media')).toBeUndefined()
    registerFieldComponent('media', Stub)
    expect(resolveFieldComponent('media')).toBe(Stub)
  })
})
