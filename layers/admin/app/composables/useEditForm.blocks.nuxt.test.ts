import { describe, it, expect, beforeEach } from 'vitest'
import { defineComponent, computed, h, nextTick } from 'vue'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import BlockFields from '../components/BlockFields.vue'
import { useEditForm } from './useEditForm'
import { useBlockTree } from './useBlockTree'
// The REAL write-path normalizer, so the mocked endpoint answers exactly what the server would.
import { sanitizeRichtext } from '@michaelthielemann/kestrel-core'
import type { SerializedBlock } from '@michaelthielemann/kestrel-core'

// The editor is only clean after a save if NOTHING writes to `values` once `rebaseline` has taken the
// baseline. The mounted block pane is the hard case: it holds a live richtext widget whose serialization
// differs from the sanitizer's, so any echo from it lands as a real difference and the Ampel stays amber.

const proseDef = {
  name: 'prose',
  label: { en: 'Prose' },
  fields: { body: { type: 'richtext', required: true, unique: false } },
} as unknown as SerializedBlock

const pagesSchema = {
  name: 'pages', mode: 'multi', translatable: false, pageLike: true, seo: true, status: true,
  blocks: { enabled: true, allowed: ['prose'] }, editor: 'blocks', nav: true,
  fields: { title: { type: 'text', required: true, unique: false } },
}

// TipTap's own serialization of a body with a hard break; sanitize-html stores it as `<br />`.
const TIPTAP_HTML = '<p>Zeile eins<br>Zeile zwei</p>'

type Row = Record<string, unknown>
let stored: Row

function freshRow(): Row {
  return {
    id: 1, title: 'Startseite', path: '/', layout: null, seo: {}, status: 'published',
    content: [{ id: 'b1', type: 'prose', props: { body: sanitizeRichtext(TIPTAP_HTML) } }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T03:04:05.678Z',
  }
}

registerEndpoint('/api/collections', () => ({ data: [pagesSchema] }))
registerEndpoint('/api/pages/deadRefs/1', () => [])
registerEndpoint('/api/pages/readOne/1', () => stored)
registerEndpoint('/api/pages/updateOne/1', { method: 'POST', handler: async (event) => {
  const body = await readBody(event) as Row
  // crud: the body is parsed by the collection's update schema (which runs the richtext transform on
  // every block prop) and the STORED row is what comes back.
  const content = (body.content as { props: Record<string, unknown> }[]).map((b) => ({
    ...b, props: { ...b.props, body: sanitizeRichtext(String(b.props.body ?? '')) },
  }))
  stored = { ...stored, ...body, content, updatedAt: new Date().toISOString() }
  return stored
} })

let form: ReturnType<typeof useEditForm>
let tree: ReturnType<typeof useBlockTree>

// BlocksBody.vue reduced to its two load-bearing bindings — `:disabled="saving"` and the id-addressed
// `@update` → `setProp` — plus the same `content` computed → `setField('content', …)` wiring. Everything
// below BlockFields (FieldLayout → FieldRenderer → FieldRichtext → UiRichtext/TipTap) is product code.
// With no block selected the pane is unmounted, exactly like the real `v-else` branch.
const Harness = defineComponent({
  async setup() {
    form = useEditForm({ collection: 'pages', id: '1' })
    await form.ready
    const content = computed<unknown[]>({
      get: () => (form.values.content as unknown[]) ?? [],
      set: (v) => form.setField('content', v),
    })
    const byName = computed(() => ({ prose: proseDef }))
    tree = useBlockTree(content, byName, undefined, (v, coalesceAs) => form.setField('content', v, coalesceAs))
    return () => tree.selectedBlock.value
      ? h(BlockFields, {
          block: tree.selectedBlock.value,
          def: proseDef,
          locale: 'en',
          disabled: form.saving.value,
          onUpdate: (k: string, v: unknown) => tree.selectedId.value && tree.setProp(tree.selectedId.value, k, v),
        })
      : null
  },
})

const settle = async () => {
  for (let i = 0; i < 6; i++) { await nextTick(); await new Promise((r) => setTimeout(r, 0)) }
}
// The richtext widget is registered as a defineAsyncComponent, so its chunk (all of TipTap) resolves
// asynchronously once the block is selected.
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) { await nextTick(); await new Promise((r) => setTimeout(r, 25)) }
  await settle()
}

describe('useEditForm — blocks editor', () => {
  beforeEach(() => { stored = freshRow() })

  it('is clean after a save whose response is sanitizer-normalized', async () => {
    const w = await mountSuspended(Harness)
    await settle()
    expect(form.dirty.value).toBe(false)

    tree.select('b1') // mounts the block pane, and with it the richtext widget
    await waitFor(() => w.find('.ui-richtext').exists())

    tree.setProp('b1', 'body', TIPTAP_HTML.replace('Zeile zwei', 'Zeile zwei geaendert'))
    await settle()
    expect(form.dirty.value).toBe(true)

    const r = await form.submit()
    await settle()

    expect(r.ok).toBe(true)
    expect((stored.content as { props: { body: string } }[])[0]!.props.body).toContain('geaendert')
    expect(form.dirty.value).toBe(false)
    w.unmount()
  })

  it('is clean after a save with no block selected', async () => {
    const w = await mountSuspended(Harness)
    await settle()
    expect(w.find('.ui-richtext').exists()).toBe(false)

    form.setField('title', 'Startseite1')
    await settle()
    const r = await form.submit()
    await settle()

    expect(r.ok).toBe(true)
    expect(form.dirty.value).toBe(false)
    w.unmount()
  })
})
