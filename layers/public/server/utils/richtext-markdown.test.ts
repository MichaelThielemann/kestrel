import { describe, it, expect } from 'vitest'
import { richtextToMarkdown } from './richtext-markdown'
import { sanitizeRichtext } from '../../../fields/server/field-registry/sanitize'
import { resolveRichtextLinks } from '../../../fields/app/utils/richtext-links'

describe('richtextToMarkdown', () => {
  it('renders paragraphs separated by a blank line', () => {
    expect(richtextToMarkdown('<p>One</p><p>Two</p>')).toBe('One\n\nTwo')
  })

  it('renders headings at their own level and shifts them by headingOffset', () => {
    expect(richtextToMarkdown('<h1>Top</h1><h3>Deep</h3>')).toBe('# Top\n\n### Deep')
    expect(richtextToMarkdown('<h1>Top</h1><h3>Deep</h3>', { headingOffset: 3 })).toBe('#### Top\n\n###### Deep')
  })

  it('clamps a shifted heading at h6 instead of emitting seven hashes', () => {
    expect(richtextToMarkdown('<h5>Five</h5>', { headingOffset: 3 })).toBe('###### Five')
  })

  it('renders inline marks', () => {
    expect(richtextToMarkdown('<p><strong>a</strong> <b>b</b> <em>c</em> <i>d</i> <s>e</s> <code>f</code></p>'))
      .toBe('**a** **b** *c* *d* ~~e~~ `f`')
  })

  it('passes through marks with no markdown equivalent, keeping their text', () => {
    expect(richtextToMarkdown('<p><u>a</u><span class="x">b</span><mark>c</mark><sub>d</sub><sup>e</sup></p>'))
      .toBe('abcde')
  })

  it('renders links, and drops the target of an unresolved (#) link to plain text', () => {
    expect(richtextToMarkdown('<p><a href="https://example.com">Home</a></p>')).toBe('[Home](https://example.com)')
    expect(richtextToMarkdown('<p><a href="#">Draft</a></p>')).toBe('Draft')
    expect(richtextToMarkdown('<p><a>Bare</a></p>')).toBe('Bare')
  })

  it('escapes brackets in link text so the link syntax cannot be broken', () => {
    expect(richtextToMarkdown('<p><a href="/a">a [b] c</a></p>')).toBe('[a \\[b\\] c](/a)')
  })

  it('renders unordered and ordered lists, numbering ordered items from one', () => {
    expect(richtextToMarkdown('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b')
    expect(richtextToMarkdown('<ol><li>a</li><li>b</li></ol>')).toBe('1. a\n2. b')
  })

  it('indents a nested list under its parent item', () => {
    expect(richtextToMarkdown('<ul><li>a<ul><li>b</li></ul></li></ul>')).toBe('- a\n  - b')
  })

  it('renders a blockquote with one marker per line', () => {
    expect(richtextToMarkdown('<blockquote><p>a</p><p>b</p></blockquote>')).toBe('> a\n>\n> b')
  })

  it('renders a code block fenced, without escaping its contents', () => {
    expect(richtextToMarkdown('<pre><code>const a = &lt;b&gt;</code></pre>')).toBe('```\nconst a = <b>\n```')
  })

  it('renders a horizontal rule', () => {
    expect(richtextToMarkdown('<p>a</p><hr /><p>b</p>')).toBe('a\n\n---\n\nb')
  })

  it('turns <br> into a line break inside the paragraph', () => {
    expect(richtextToMarkdown('<p>a<br>b</p>')).toBe('a\nb')
  })

  it('decodes the entities sanitize-html emits', () => {
    expect(richtextToMarkdown('<p>a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39; &nbsp;g</p>'))
      .toBe(`a & b < c > d "e" 'f' g`)
  })

  it('escapes a leading block marker so a paragraph cannot turn into a list or heading', () => {
    expect(richtextToMarkdown('<p>- not a list</p>')).toBe('\\- not a list')
    expect(richtextToMarkdown('<p># not a heading</p>')).toBe('\\# not a heading')
    expect(richtextToMarkdown('<p>1. not an item</p>')).toBe('1\\. not an item')
    expect(richtextToMarkdown('<p>plain</p>')).toBe('plain')
  })

  // The document this feeds (llms-full.txt) uses `##` for its own collection sections, so an unescaped
  // `## …` typed by an editor does not merely add a heading — it forges a sibling of the generator's own
  // structure and re-parents every page that follows.
  it('escapes a heading marker of ANY level, not just h1', () => {
    expect(richtextToMarkdown('<p>## two</p>')).toBe('\\## two')
    expect(richtextToMarkdown('<p>###### six</p>')).toBe('\\###### six')
    expect(richtextToMarkdown('<p>#nothashtag</p>')).toBe('#nothashtag') // no space → not a heading anyway
  })

  it('escapes a marker on EVERY line of a paragraph, not just the first', () => {
    expect(richtextToMarkdown('<p>fine<br>## forged<br>- item</p>')).toBe('fine\n\\## forged\n\\- item')
  })

  it('escapes the remaining block constructs a paragraph could open', () => {
    expect(richtextToMarkdown('<p>```js</p>')).toBe('\\```js')
    expect(richtextToMarkdown('<p>~~~</p>')).toBe('\\~~~')
    expect(richtextToMarkdown('<p>---</p>')).toBe('\\---')
    expect(richtextToMarkdown('<p>***</p>')).toBe('\\***')
    expect(richtextToMarkdown('<p>&gt;&gt; quoted</p>')).toBe('\\>> quoted')
    expect(richtextToMarkdown('<p>1) also an item</p>')).toBe('1\\) also an item')
  })

  it('keeps a heading on one line — a hard break inside it would start a new block', () => {
    expect(richtextToMarkdown('<h2>one<br>two</h2>')).toBe('## one two')
  })

  it('fences a code block wider than any backtick run inside it', () => {
    expect(richtextToMarkdown('<pre><code>a\n```\nb</code></pre>')).toBe('````\na\n```\nb\n````')
    expect(richtextToMarkdown('<pre><code>plain</code></pre>')).toBe('```\nplain\n```')
  })

  it('widens the inline code delimiter around content that contains backticks', () => {
    expect(richtextToMarkdown('<p><code>a `b` c</code></p>')).toBe('``a `b` c``')
    expect(richtextToMarkdown('<p><code>`x`</code></p>')).toBe('`` `x` ``')
  })

  it('keeps whitespace outside an inline mark, where CommonMark can still parse it', () => {
    expect(richtextToMarkdown('<p>a<strong> bold </strong>b</p>')).toBe('a **bold** b')
    expect(richtextToMarkdown('<p><em>lead </em>tail</p>')).toBe('*lead* tail')
  })

  it('collapses whitespace in flow text but keeps a single separating space', () => {
    expect(richtextToMarkdown('<p>a\n   b</p>')).toBe('a b')
    expect(richtextToMarkdown('<p><strong>a</strong> <em>b</em></p>')).toBe('**a** *b*')
  })

  it('treats bare top-level text as a paragraph', () => {
    expect(richtextToMarkdown('loose <strong>text</strong>')).toBe('loose **text**')
  })

  it('drops empty blocks rather than emitting blank paragraphs', () => {
    expect(richtextToMarkdown('<p></p><p>  </p><p>a</p>')).toBe('a')
  })

  it('returns an empty string for empty, blank or non-string input', () => {
    expect(richtextToMarkdown('')).toBe('')
    expect(richtextToMarkdown('<p><br></p>')).toBe('')
    expect(richtextToMarkdown(null)).toBe('')
    expect(richtextToMarkdown(undefined)).toBe('')
    expect(richtextToMarkdown(42 as unknown as string)).toBe('')
  })

  it('ignores an unknown tag but keeps the text it wraps', () => {
    expect(richtextToMarkdown('<p><figure>a</figure>b</p>')).toBe('ab')
  })
})

// The real input is always sanitize-html's own output, so pin the conversion against it rather than
// against hand-written markup that may not match what is actually stored.
describe('richtextToMarkdown over sanitizeRichtext output', () => {
  it('converts an editor-shaped document', () => {
    const stored = sanitizeRichtext(
      '<h2>Pricing</h2><p>Plans start at <strong>€9</strong>. <a href="https://example.com/x">Compare</a>.</p>'
      + '<ul><li>Free</li><li>Pro</li></ul><blockquote><p>Cancel anytime.</p></blockquote>',
    )
    expect(richtextToMarkdown(stored, { headingOffset: 3 })).toBe(
      '##### Pricing\n\n'
      + 'Plans start at **€9**. [Compare](https://example.com/x).\n\n'
      + '- Free\n- Pro\n\n'
      + '> Cancel anytime.',
    )
  })

  it('keeps an unresolved internal-link marker out of the output', () => {
    const stored = sanitizeRichtext('<p>See <a href="kestrel:pages:7">the page</a>.</p>')
    expect(richtextToMarkdown(resolveRichtextLinks(stored, () => null))).toBe('See the page.')
  })
})
