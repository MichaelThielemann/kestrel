import { describe, it, expect } from 'vitest'
import { humanizeFieldName } from './humanize'

describe('humanizeFieldName', () => {
  it('humanizes snake/kebab/camel keys and capitalizes the first word', () => {
    expect(humanizeFieldName('title')).toBe('Title')
    expect(humanizeFieldName('siteName')).toBe('Site Name')
    expect(humanizeFieldName('meta_description')).toBe('Meta description')
    expect(humanizeFieldName('main-menu')).toBe('Main menu')
  })
})
