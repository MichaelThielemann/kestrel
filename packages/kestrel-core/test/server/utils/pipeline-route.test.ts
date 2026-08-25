import { describe, it, expect } from 'vitest'
import { isRecordId, parsePipelineRoute, parseRecordId } from '../../../src/server/utils/pipeline-route.js'

const status = (fn: () => unknown): number | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { statusCode?: number }).statusCode
  }
}

describe('parsePipelineRoute', () => {
  it('reads the collection form, with and without a record id', () => {
    expect(parsePipelineRoute('/api/pages/readMany')).toEqual({ collection: 'pages', pipeline: 'readMany' })
    expect(parsePipelineRoute('/api/pages/readOne/42')).toEqual({ collection: 'pages', pipeline: 'readOne', id: 42 })
  })

  it('reads the collection-less form', () => {
    expect(parsePipelineRoute('/api/login')).toEqual({ collection: null, pipeline: 'login' })
  })

  it('ignores the query string', () => {
    expect(parsePipelineRoute('/api/pages/translations?group=g1')).toEqual({ collection: 'pages', pipeline: 'translations' })
  })

  it('never reads a numeric segment as a pipeline name — that is what keeps an id out of the name space', () => {
    expect(status(() => parsePipelineRoute('/api/pages/42'))).toBe(404)
    expect(status(() => parsePipelineRoute('/api/42'))).toBe(404)
    expect(status(() => parsePipelineRoute('/api/pages/42/7'))).toBe(404)
  })

  it('400s a record id that is not a positive integer', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '01']) {
      expect(status(() => parsePipelineRoute(`/api/pages/readOne/${bad}`))).toBe(400)
    }
  })

  it('404s anything outside the grammar', () => {
    expect(status(() => parsePipelineRoute('/api'))).toBe(404)
    expect(status(() => parsePipelineRoute('/api/a/b/1/c'))).toBe(404)
    expect(status(() => parsePipelineRoute('/healthz'))).toBe(404)
  })

  it('decodes percent-encoded segments', () => {
    expect(parsePipelineRoute('/api/my%20pages/readMany').collection).toBe('my pages')
  })
})

describe('isRecordId / parseRecordId', () => {
  it('accepts only positive integers without a leading zero', () => {
    expect(['1', '42', '900'].every(isRecordId)).toBe(true)
    expect(['0', '01', '-1', '1.0', '', 'x', '1e3'].some(isRecordId)).toBe(false)
  })

  it('parseRecordId returns the number or 400s', () => {
    expect(parseRecordId('7')).toBe(7)
    expect(status(() => parseRecordId('nope'))).toBe(400)
  })
})
