import { describe, it, expect } from 'vitest'
import { buildLlmsTxt } from './llms'

describe('buildLlmsTxt — llmstxt.org markdown for AI agents', () => {
  it('emits an H1 site name and trailing newline (no description, no sections)', () => {
    expect(buildLlmsTxt({ siteName: 'Acme', sections: [] })).toBe('# Acme\n')
  })

  it('adds a blockquote summary when a description is given', () => {
    expect(buildLlmsTxt({ siteName: 'Acme', siteDescription: 'We make things.', sections: [] })).toBe(
      '# Acme\n\n> We make things.\n',
    )
  })

  it('renders one H2 per section with a bulleted [title](url): description list', () => {
    const out = buildLlmsTxt({
      siteName: 'Acme',
      sections: [
        {
          heading: 'Pages',
          entries: [
            { title: 'Home', url: 'https://acme.test/', description: 'The landing page.' },
            { title: 'About', url: 'https://acme.test/about' }, // no description → no trailing colon
          ],
        },
      ],
    })
    expect(out).toBe(
      '# Acme\n\n## Pages\n\n- [Home](https://acme.test/): The landing page.\n- [About](https://acme.test/about)\n',
    )
  })

  it('flattens newlines and escapes link-breaking brackets so a page title/description cannot corrupt the list', () => {
    const out = buildLlmsTxt({
      siteName: 'Acme',
      siteDescription: 'line one\nline two',
      sections: [{ heading: 'Pages', entries: [
        { title: 'A] evil](http://x) title', url: 'https://acme.test/a', description: 'multi\nline\ndesc' },
      ] }],
    })
    // no injected newline splits the one-resource-per-line structure, and the ] in the title is escaped
    expect(out).toBe('# Acme\n\n> line one line two\n\n## Pages\n\n- [A\\] evil\\](http://x) title](https://acme.test/a): multi line desc\n')
  })

  it('skips empty sections entirely (no stray heading)', () => {
    const out = buildLlmsTxt({
      siteName: 'Acme',
      sections: [
        { heading: 'Empty', entries: [] },
        { heading: 'Posts', entries: [{ title: 'Hello', url: 'https://acme.test/hello' }] },
      ],
    })
    expect(out).toBe('# Acme\n\n## Posts\n\n- [Hello](https://acme.test/hello)\n')
  })
})
