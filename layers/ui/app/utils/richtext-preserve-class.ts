import { Mark, Extension } from '@tiptap/vue-3' // re-exports @tiptap/core; keeps deps unchanged

// StarterKit has no span/TextStyle mark and no `class` attribute on block nodes, so parsing stored
// markup discards every consumer presentational class (e.g. the hero title's `text--color-white`).
// These two extensions teach the schema to keep `class` on span wrappers and on block nodes, matching
// what sanitize.ts already allows (`*: [class]`) so the class survives an edit/focus round-trip.
const classAttr = {
  class: {
    default: null as string | null,
    parseHTML: (el: HTMLElement) => el.getAttribute('class'),
    renderHTML: (a: Record<string, unknown>) => (a.class ? { class: a.class } : {}),
  },
}

// Inline `<span class="…">` wrapper. Only spans that HAVE a class become this mark, so ordinary spans
// aren't captured.
export const RichtextSpanClass = Mark.create({
  name: 'spanClass',
  parseHTML: () => [{ tag: 'span[class]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
  addAttributes: () => classAttr,
})

// Block-level class (e.g. `<p class="text--section-label">`).
export const RichtextBlockClass = Extension.create({
  name: 'blockClass',
  addGlobalAttributes: () => [{
    types: ['heading', 'paragraph', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'codeBlock'],
    attributes: classAttr,
  }],
})
