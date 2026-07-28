import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent } from 'vue'
import { editorComponents, resolveCollectionEditor, registerCollectionEditor } from './editor-registry'

describe('collection-editor registry', () => {
  // Registrations mutate the shared singleton; drop test entries so runs stay order-independent.
  afterEach(() => {
    delete editorComponents.fields
    delete editorComponents.blocks
    delete editorComponents['node-graph']
  })

  it('starts empty and resolves an unknown type to undefined', () => {
    expect(resolveCollectionEditor('fields')).toBeUndefined()
    expect(resolveCollectionEditor('bogus')).toBeUndefined()
  })

  it('registers a body component the resolver then returns', () => {
    const Stub = defineComponent({ template: '<div/>' })
    registerCollectionEditor('node-graph', Stub)
    expect(resolveCollectionEditor('node-graph')).toBe(Stub)
  })

  it('lets a later registration override an earlier one for the same type', () => {
    const A = defineComponent({ template: '<div/>' })
    const B = defineComponent({ template: '<span/>' })
    registerCollectionEditor('fields', A)
    registerCollectionEditor('fields', B)
    expect(resolveCollectionEditor('fields')).toBe(B)
  })
})
