import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/vue-3'
import { StarterKit } from '@tiptap/starter-kit'
import { RichtextSpanClass, RichtextBlockClass } from './richtext-preserve-class'

// A headless `new Editor({...})` parses/serialises fine under happy-dom even though the interactive
// editing surface does not (see richtext.dom.test.ts). We assert the schema keeps `class` — both on
// initial parse and after `focus()`, which is the real trigger that re-serialises the block.
function makeEditor(content: string) {
  return new Editor({
    content,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: { openOnClick: false } }),
      RichtextSpanClass,
      RichtextBlockClass,
    ],
  })
}

describe('richtext-preserve-class', () => {
  let editor: Editor | undefined
  afterEach(() => {
    editor?.destroy()
    editor = undefined
  })

  it('round-trips a span class (the hero title color) on parse', () => {
    editor = makeEditor('<h1><span class="text--color-white text--hero-headline-1">X</span></h1>')
    expect(editor.getHTML()).toContain('text--color-white')
    expect(editor.getHTML()).toContain('text--hero-headline-1')
  })

  it('round-trips a span class AFTER focus (the real trigger)', () => {
    editor = makeEditor('<h1><span class="text--color-white text--hero-headline-1">X</span></h1>')
    editor.commands.focus()
    const html = editor.getHTML()
    expect(html).toContain('text--color-white')
    expect(html).toContain('text--hero-headline-1')
  })

  it('round-trips a block-level class on a paragraph', () => {
    editor = makeEditor('<p class="text--section-label">L</p>')
    editor.commands.focus()
    expect(editor.getHTML()).toContain('class="text--section-label"')
  })

  it('does not add a spurious class attribute to a plain span', () => {
    editor = makeEditor('<p><span>strong</span></p>')
    expect(editor.getHTML()).not.toContain('class=')
  })

  it('emits no class on a freshly inserted heading/paragraph', () => {
    editor = makeEditor('<p>plain</p>')
    editor.commands.focus()
    editor.commands.setContent('<h2>fresh</h2>')
    expect(editor.getHTML()).toContain('<h2>fresh</h2>')
    expect(editor.getHTML()).not.toContain('class=')
  })
})
