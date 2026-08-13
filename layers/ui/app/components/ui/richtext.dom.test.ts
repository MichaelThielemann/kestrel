import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import Richtext from './Richtext.vue'
import { richtextLinkHref } from '../../../../fields/app/utils/richtext-links'
import { RICHTEXT_ALLOWLIST } from '../../../../fields/server/field-registry/sanitize'

type LiveEditor = {
  commands: { insertContent: (s: string) => boolean }
  chain: () => {
    setTextSelection: (r: { from: number; to: number }) => {
      setLink: (a: { href: string }) => { run: () => boolean }
    }
  }
  getHTML: () => string
}

/** The live TipTap instance behind the wrapper — the only way to drive a REAL edit under happy-dom. */
const editorOf = (w: VueWrapper) => (w.vm as unknown as { editor: LiveEditor }).editor

// Smoke only: ProseMirror's editing surface is not reliable under happy-dom, so
// editor interaction is verified manually. We assert the component mounts and the
// toolbar/content shell render.
describe('UiRichtext', () => {
  it('mounts the editor shell with a toolbar', async () => {
    const w = mount(Richtext, { props: { modelValue: '<p>Hi</p>' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.find('.ui-richtext').exists()).toBe(true)
    expect(w.find('.ui-rt-toolbar').exists()).toBe(true)
    w.unmount()
  })

  // An echoed emit reaches the edit form as a user edit: it clears the redo stack (Undo kills Redo) and
  // lands '' where the restored value was null, leaving the form dirty after a full revert.
  it('applies an external model write without emitting it back', async () => {
    const w = mount(Richtext, { props: { modelValue: '<p>Hi</p>' } })
    await new Promise((r) => setTimeout(r, 0))

    await w.setProps({ modelValue: null })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('update:modelValue')).toBeUndefined()

    await w.setProps({ modelValue: '<p>Other</p>' })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('update:modelValue')).toBeUndefined()
    expect(w.find('.tiptap').text()).toContain('Other')

    w.unmount()
  })

  // `disabled` is bound to the edit form's `saving` flag, so this fires around every save — and TipTap
  // emits `update` for a bare editability change. The value must be in the SANITIZER's serialization
  // (`<br />`, what the server stores) rather than TipTap's (`<br>`): an identical re-emit is swallowed
  // by Vue's useModel setter, so a TipTap-form value would pass even unguarded.
  it('does not emit when only the editable state is toggled', async () => {
    const w = mount(Richtext, { props: { modelValue: '<p>Zeile eins<br />Zeile zwei</p>' } })
    await new Promise((r) => setTimeout(r, 0))

    await w.setProps({ disabled: true })
    await new Promise((r) => setTimeout(r, 0))
    await w.setProps({ disabled: false })
    await new Promise((r) => setTimeout(r, 0))

    expect(w.emitted('update:modelValue')).toBeUndefined()
    w.unmount()
  })

  it('still emits a real content change, including right after an external write', async () => {
    const w = mount(Richtext, { props: { modelValue: '<p>Hi</p>' } })
    await new Promise((r) => setTimeout(r, 0))

    await w.setProps({ modelValue: '<p>Other</p>' })
    await new Promise((r) => setTimeout(r, 0))
    expect(w.emitted('update:modelValue')).toBeUndefined()

    editorOf(w).commands.insertContent('!')
    await new Promise((r) => setTimeout(r, 0))

    const emits = w.emitted('update:modelValue')
    expect(emits).toBeTruthy()
    expect(String(emits!.at(-1)![0])).toContain('Other!')
    w.unmount()
  })

  // TipTap's Link mark validates every href against its own scheme allowlist, which has no `kestrel:`.
  // Unconfigured it drops the whole anchor on load and makes `setLink` a silent no-op, so merely opening
  // and saving a record would destroy its internal links. Only a REAL editor catches this — the toolbar
  // test drives a stand-in and would pass either way.
  describe('internal `kestrel:` links', () => {
    const HREF = richtextLinkHref('pages', 7)

    it('keeps the marker href when stored content is loaded', async () => {
      const w = mount(Richtext, { props: { modelValue: `<p>see <a href="${HREF}">this page</a> ok</p>` } })
      await new Promise((r) => setTimeout(r, 0))

      expect(editorOf(w).getHTML()).toContain(`href="${HREF}"`)
      w.unmount()
    })

    it('lets the toolbar set one', async () => {
      const w = mount(Richtext, { props: { modelValue: '<p>hello world</p>' } })
      await new Promise((r) => setTimeout(r, 0))

      editorOf(w).chain().setTextSelection({ from: 1, to: 6 }).setLink({ href: HREF }).run()

      expect(editorOf(w).getHTML()).toContain(`href="${HREF}"`)
      w.unmount()
    })
  })

  // `sanitize.ts` is the sole authority on target/rel: it adds them to absolute http(s) links and strips
  // them from every other kind, so a same-site link never opens a new tab. The Link mark stamps its own
  // defaults on EVERY anchor, so a stored non-absolute link came back decorated — a difference the edit
  // form reads as an unsaved change, and one that never converges because the next save strips them again.
  describe('link target/rel', () => {
    const cases: [string, string][] = [
      ['internal', `<p><a href="${richtextLinkHref('pages', 7)}">x</a></p>`],
      ['relative', '<p><a href="/impressum">x</a></p>'],
      ['mailto', '<p><a href="mailto:a@b.c">x</a></p>'],
    ]

    it.each(cases)('round-trips a %s link byte-identically', async (_name, stored) => {
      const w = mount(Richtext, { props: { modelValue: stored } })
      await new Promise((r) => setTimeout(r, 0))

      expect(editorOf(w).getHTML()).toBe(stored)
      w.unmount()
    })

    it('keeps the attributes the server put on an external link', async () => {
      const stored = '<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/x">x</a></p>'
      const w = mount(Richtext, { props: { modelValue: stored } })
      await new Promise((r) => setTimeout(r, 0))

      const html = editorOf(w).getHTML()
      expect(html).toContain('target="_blank"')
      expect(html).toContain('rel="noopener noreferrer nofollow"')
      w.unmount()
    })
  })

  // The sanitizer's allowlist and the editor's schema have to agree. A tag the server accepts but no
  // extension parses is silently deleted by the first edit, and the next save persists that loss — so
  // every allowed tag needs a case here, and the coverage assertion below fails if one is added without.
  // `b`/`i` are aliases the schema normalizes to `strong`/`em`; a bare `<span>` only survives WITH a
  // class (that is what RichtextSpanClass captures), which is also all the allowlist promises.
  describe('every allowed tag survives the editor', () => {
    const roundTrip: Record<string, { stored: string; as?: string }> = {
      p: { stored: '<p>x</p>' },
      br: { stored: '<p>a<br>b</p>' },
      span: { stored: '<p><span class="c">x</span></p>' },
      strong: { stored: '<p><strong>x</strong></p>' },
      b: { stored: '<p><b>x</b></p>', as: 'strong' },
      em: { stored: '<p><em>x</em></p>' },
      i: { stored: '<p><i>x</i></p>', as: 'em' },
      u: { stored: '<p><u>x</u></p>' },
      s: { stored: '<p><s>x</s></p>' },
      sub: { stored: '<p><sub>x</sub></p>' },
      sup: { stored: '<p><sup>x</sup></p>' },
      mark: { stored: '<p><mark>x</mark></p>' },
      blockquote: { stored: '<blockquote><p>x</p></blockquote>' },
      pre: { stored: '<pre><code>x</code></pre>' },
      code: { stored: '<p><code>x</code></p>' },
      h1: { stored: '<h1>x</h1>' },
      h2: { stored: '<h2>x</h2>' },
      h3: { stored: '<h3>x</h3>' },
      h4: { stored: '<h4>x</h4>' },
      h5: { stored: '<h5>x</h5>' },
      h6: { stored: '<h6>x</h6>' },
      ul: { stored: '<ul><li><p>x</p></li></ul>' },
      ol: { stored: '<ol><li><p>x</p></li></ol>' },
      li: { stored: '<ul><li><p>x</p></li></ul>' },
      a: { stored: '<p><a href="/x">x</a></p>' },
      hr: { stored: '<hr>' },
    }

    it('covers every tag the sanitizer allows', () => {
      expect(Object.keys(roundTrip).sort()).toEqual([...RICHTEXT_ALLOWLIST.allowedTags!].sort())
    })

    it.each(Object.entries(roundTrip))('keeps <%s>', async (tag, { stored, as }) => {
      const w = mount(Richtext, { props: { modelValue: stored } })
      await new Promise((r) => setTimeout(r, 0))

      expect(editorOf(w).getHTML()).toMatch(new RegExp(`<${as ?? tag}[ >]`))
      w.unmount()
    })
  })
})
