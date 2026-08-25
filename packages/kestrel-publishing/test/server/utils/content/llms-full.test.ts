import { describe, it, expect, afterEach } from 'vitest'
import { buildLlmsFullTxt, recordMarkdown } from '../../../../src/server/utils/content/llms-full.js'
import { registerBlock, clearBlocks } from '@kestrel/fields'
import type { CollectionDef } from '@kestrel/core'

afterEach(() => clearBlocks())

const def = (over: Partial<CollectionDef> = {}): CollectionDef => ({
  name: 'pages', mode: 'multi', pageLike: true, fields: {}, ...over,
} as CollectionDef)

describe('buildLlmsFullTxt', () => {
  it('renders the site header, one section per collection and one sub-section per page', () => {
    expect(buildLlmsFullTxt({
      siteName: 'Acme',
      siteDescription: 'We make things',
      sections: [{
        heading: 'Pages',
        pages: [
          { title: 'About', url: 'https://acme.test/about', description: 'Who we are', body: 'We started in 1999.' },
          { title: 'Pricing', url: 'https://acme.test/pricing', body: '#### Plans\n\n- Free' },
        ],
      }],
    })).toBe(
      '# Acme\n'
      + '\n> We make things\n'
      + '\n## Pages\n'
      + '\n### About\n'
      + '\nSource: https://acme.test/about\n'
      + '\nWho we are\n'
      + '\nWe started in 1999.\n'
      + '\n### Pricing\n'
      + '\nSource: https://acme.test/pricing\n'
      + '\n#### Plans\n\n- Free\n',
    )
  })

  it('emits the site header alone when nothing is published', () => {
    expect(buildLlmsFullTxt({ siteName: 'Acme', sections: [] })).toBe('# Acme\n')
  })

  it('skips an empty section and still lists a page that has no body yet', () => {
    expect(buildLlmsFullTxt({ siteName: 'Acme', sections: [
      { heading: 'Empty', pages: [] },
      { heading: 'Pages', pages: [{ title: 'Stub', url: 'https://acme.test/stub', body: '' }] },
    ] })).toBe('# Acme\n\n## Pages\n\n### Stub\n\nSource: https://acme.test/stub\n')
  })

  it('escapes a description that would open a block of its own', () => {
    const out = buildLlmsFullTxt({
      siteName: 'Acme',
      siteDescription: '## not a section',
      sections: [{ heading: 'Pages', pages: [{ title: 'X', url: 'https://acme.test/x', description: '## also not', body: 'b' }] }],
    })
    expect(out).toContain('> \\## not a section')
    expect(out).toContain('\n\\## also not\n')
    expect(out.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## Pages'])
  })

  it('flattens a newline out of a title or heading so it cannot forge a document structure', () => {
    const out = buildLlmsFullTxt({ siteName: 'A\nB', sections: [
      { heading: 'C\nD', pages: [{ title: '## Fake', url: 'https://acme.test/x', body: 'body' }] },
    ] })
    expect(out).toContain('# A B')
    expect(out).toContain('## C D')
    expect(out).toContain('### ## Fake')
    expect(out.split('\n').filter((l) => l.startsWith('## ') && !l.startsWith('### '))).toEqual(['## C D'])
  })
})

describe('recordMarkdown', () => {
  it('renders the record’s own text and richtext fields in field order', () => {
    const d = def({ fields: { lead: { type: 'text' }, body: { type: 'richtext' } } })
    expect(recordMarkdown(d, { lead: 'A short lead.', body: '<p>The <em>body</em>.</p>' }))
      .toBe('A short lead.\n\nThe *body*.')
  })

  // A `text` field is raw editor input with no markup around it, so it reaches the document completely
  // unfiltered — the one place where a typed `## …` would forge the generator's own section structure.
  it('escapes Markdown block markers in a plain text field, on every line', () => {
    const d = def({ fields: { lead: { type: 'text', options: { multiline: true } } } })
    expect(recordMarkdown(d, { lead: '## Forged\nfine\n- item\n```' }))
      .toBe('\\## Forged\nfine\n\\- item\n\\```')
  })

  it('leaves ordinary prose in a text field alone', () => {
    const d = def({ fields: { lead: { type: 'text' } } })
    expect(recordMarkdown(d, { lead: 'Costs $5 — a #1 choice.' })).toBe('Costs $5 — a #1 choice.')
  })

  it('skips fields that carry no prose', () => {
    const d = def({ fields: {
      n: { type: 'number' }, ok: { type: 'boolean' }, when: { type: 'datetime' }, pick: { type: 'choice', options: { choices: [] } },
      slug: { type: 'slug' }, blob: { type: 'json' }, hero: { type: 'media' }, text: { type: 'text' },
    } } as unknown as Partial<CollectionDef>)
    expect(recordMarkdown(d, { n: 7, ok: true, when: '2026-01-01', pick: 'a', slug: 'x', blob: { a: 1 }, heroId: 3, text: 'kept' }))
      .toBe('kept')
  })

  it('skips the fields the caller already used as a heading', () => {
    const d = def({ fields: { title: { type: 'text' }, body: { type: 'text' } } })
    expect(recordMarkdown(d, { title: 'About', body: 'Prose.' }, { skipFields: ['title'] })).toBe('Prose.')
  })

  it('walks a repeater’s entries', () => {
    const d = def({ fields: { faq: { type: 'repeater', options: { fields: { q: { type: 'text' }, a: { type: 'richtext' } } } } } })
    expect(recordMarkdown(d, { faq: [{ q: 'Why?', a: '<p>Because.</p>' }, { q: 'When?', a: '<p>Now.</p>' }] }))
      .toBe('Why?\n\nBecause.\n\nWhen?\n\nNow.')
  })

  it('walks the block tree, including nested slots', () => {
    registerBlock({ name: 'hero', fields: { heading: { type: 'text' } } })
    registerBlock({ name: 'section', fields: { intro: { type: 'richtext' } }, slots: ['default'] })
    const d = def({ blocks: { enabled: true }, fields: {} })
    const content = [
      { id: '1', type: 'hero', props: { heading: 'Welcome' } },
      { id: '2', type: 'section', props: { intro: '<p>Intro.</p>' }, slots: { default: [{ id: '3', type: 'hero', props: { heading: 'Nested' } }] } },
    ]
    expect(recordMarkdown(d, { content })).toBe('Welcome\n\nIntro.\n\nNested')
  })

  it('ignores a block whose type is not registered rather than guessing at its props', () => {
    const d = def({ blocks: { enabled: true }, fields: {} })
    expect(recordMarkdown(d, { content: [{ id: '1', type: 'ghost', props: { heading: 'Hidden' } }] })).toBe('')
  })

  it('reads the content column only when the collection actually enables blocks', () => {
    registerBlock({ name: 'hero', fields: { heading: { type: 'text' } } })
    const d = def({ fields: {} })
    expect(recordMarkdown(d, { content: [{ id: '1', type: 'hero', props: { heading: 'Welcome' } }] })).toBe('')
  })

  it('shifts body headings so they nest under the document headings the caller emitted', () => {
    const d = def({ fields: { body: { type: 'richtext' } } })
    expect(recordMarkdown(d, { body: '<h1>Top</h1>' }, { headingOffset: 3 })).toBe('#### Top')
  })

  it('resolves internal richtext links through the injected resolver', () => {
    const d = def({ fields: { body: { type: 'richtext' } } })
    const row = { body: '<p>See <a href="kestrel:pages:7">this</a> and <a href="kestrel:pages:9">that</a>.</p>' }
    const resolve = (collection: string, id: number) => (id === 7 ? `https://acme.test/x` : null)
    expect(recordMarkdown(d, row, { resolveLink: resolve }))
      .toBe('See [this](https://acme.test/x) and that.')
  })

  it('drops an unresolved internal link when no resolver is supplied, rather than leaking the marker', () => {
    const d = def({ fields: { body: { type: 'richtext' } } })
    expect(recordMarkdown(d, { body: '<p>See <a href="kestrel:pages:7">this</a>.</p>' })).toBe('See this.')
  })

  it('returns an empty string for a record with nothing to say', () => {
    const d = def({ fields: { body: { type: 'richtext' }, lead: { type: 'text' } } })
    expect(recordMarkdown(d, {})).toBe('')
    expect(recordMarkdown(d, { body: '', lead: '   ' })).toBe('')
  })
})
