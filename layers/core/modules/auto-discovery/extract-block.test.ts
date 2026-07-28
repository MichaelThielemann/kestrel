import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { extractBlockDef, blockNameFromFile, renderBlockRegistry } from './extract-block'

describe('blockNameFromFile', () => {
  it('camel-cases the PascalCase filename (BlockRenderer pascal-cases it back)', () => {
    expect(blockNameFromFile('Hero.vue')).toBe('hero')
    expect(blockNameFromFile('BoxedContainer.vue')).toBe('boxedContainer')
  })
})

describe('extractBlockDef — SFC → BlockDef (static, no component execution)', () => {
  it('reproduces the declarative hero block byte-for-byte', () => {
    const sfc = `
<script setup lang="ts">
const props = defineProps({
  heading: textField({ required: true }),
  image: mediaField({ accept: 'image' }),
  cta: linkField(),
})
defineBlock({ label: 'Hero', slots: ['default'], icon: 'Image' })
</script>
<template><section><slot /></section></template>
`
    expect(extractBlockDef(sfc, 'Hero.vue')).toEqual({
      name: 'hero',
      fields: {
        heading: { type: 'text', required: true },
        image: { type: 'media', options: { accept: 'image' } },
        cta: { type: 'link' },
      },
      slots: ['default'],
      label: 'Hero',
      icon: 'Image',
    })
  })

  it('extracts a picker preview `image` (string literal) and drops a non-string image', () => {
    const withImage = `
<script setup lang="ts">
defineProps({})
defineBlock({ label: 'Hero', icon: 'image', image: '/block-previews/hero.png' })
</script>
<template><div /></template>`
    expect(extractBlockDef(withImage, 'Hero.vue')).toEqual({
      name: 'hero',
      fields: {},
      label: 'Hero',
      icon: 'image',
      image: '/block-previews/hero.png',
    })
    // a non-string image is silently dropped (same `typeof === 'string'` guard as icon)
    const badImage = `<script setup lang="ts">defineProps({})\ndefineBlock({ image: 123 })</script><template><div /></template>`
    expect(extractBlockDef(badImage, 'Bad.vue')).toEqual({ name: 'bad', fields: {} })
  })

  it('handles repeater + relation + richtext + a localized label; omits absent metadata', () => {
    const sfc = `
<script setup lang="ts">
defineProps({
  duration: numberField({ required: true, default: 4000 }),
  items: repeaterField({ fields: { pic: mediaField(), caption: richtextField() } }),
  speakers: relationField({ collection: 'speakers', many: true }),
})
defineBlock({ label: { en: 'Carousel', de: 'Karussell' } })
</script>
<template><div /></template>
`
    expect(extractBlockDef(sfc, 'Carousel.vue')).toEqual({
      name: 'carousel',
      fields: {
        duration: { type: 'number', required: true, default: 4000 },
        items: { type: 'repeater', options: { fields: { pic: { type: 'media' }, caption: { type: 'richtext' } } } },
        speakers: { type: 'relation', relation: { collection: 'speakers', many: true } },
      },
      label: { en: 'Carousel', de: 'Karussell' },
    })
  })

  it('works with no defineBlock (metadata all optional) and no props', () => {
    const sfc = `<script setup lang="ts">defineProps({})</script><template><hr /></template>`
    expect(extractBlockDef(sfc, 'Divider.vue')).toEqual({ name: 'divider', fields: {} })
  })

  it('throws a clear error for the type-only defineProps form (no runtime schema)', () => {
    const sfc = `<script setup lang="ts">defineProps<{ heading: string }>()</script><template><div /></template>`
    expect(() => extractBlockDef(sfc, 'Bad.vue')).toThrow(/runtime form/)
  })

  it('finds defineProps inside withDefaults(...) (a very common Vue idiom) — not a silent empty schema', () => {
    const sfc = `<script setup lang="ts">import { textField } from '#imports'
const props = withDefaults(defineProps({ heading: textField({ required: true }) }), { heading: 'Hi' })</script><template><h1>{{ props.heading }}</h1></template>`
    expect(extractBlockDef(sfc, 'Hero.vue')).toEqual({ name: 'hero', fields: { heading: { type: 'text', required: true } } })
  })

  it('finds defineProps through a TS as-cast, a non-null assertion, and export const', () => {
    const asCast = `<script setup lang="ts">const p = defineProps({ a: textField() }) as { a: string }</script><template><div/></template>`
    expect(extractBlockDef(asCast, 'A.vue').fields).toEqual({ a: { type: 'text' } })
    const bang = `<script setup lang="ts">const p = defineProps({ a: textField() })!</script><template><div/></template>`
    expect(extractBlockDef(bang, 'B.vue').fields).toEqual({ a: { type: 'text' } })
    const exp = `<script setup lang="ts">export const p = defineProps({ a: textField() })</script><template><div/></template>`
    expect(extractBlockDef(exp, 'C.vue').fields).toEqual({ a: { type: 'text' } })
  })

  it('still throws on the type-only form even when wrapped in withDefaults', () => {
    const sfc = `<script setup lang="ts">withDefaults(defineProps<{ x: string }>(), { x: '' })</script><template><div/></template>`
    expect(() => extractBlockDef(sfc, 'Bad.vue')).toThrow(/runtime form/)
  })

  it('skips a plain (display-only) prop like the resolved `media` bag — only factory props are schema', () => {
    const sfc = `
<script setup lang="ts">
defineProps({ heading: textField({ required: true }), media: Object, ratio: Number })
</script>
<template><div /></template>`
    expect(extractBlockDef(sfc, 'Card.vue')).toEqual({ name: 'card', fields: { heading: { type: 'text', required: true } } })
  })

  it('throws a helpful error when a field arg references a non-self-contained identifier', () => {
    const sfc = `<script setup lang="ts">defineProps({ x: textField({ default: SOME_IMPORT }) })</script><template><div /></template>`
    expect(() => extractBlockDef(sfc, 'Bad.vue')).toThrow(/self-contained/)
  })

  it('throws when there is no <script setup> block', () => {
    expect(() => extractBlockDef('<template><div /></template>', 'Bad.vue')).toThrow(/<script setup>/)
  })

  it('accepts <script lang="ts" setup> — attribute order is insignificant', () => {
    const sfc = `<script lang="ts" setup>defineProps({ heading: textField() })</script><template><div /></template>`
    expect(extractBlockDef(sfc, 'Hero.vue').fields).toEqual({ heading: { type: 'text' } })
  })

  it('throws on an uncalled field factory (forgot the parentheses)', () => {
    const sfc = `<script setup lang="ts">defineProps({ heading: textField })</script><template><div /></template>`
    expect(() => extractBlockDef(sfc, 'Bad.vue')).toThrow(/was not called/)
  })

  it('throws on a function default (not JSON-serializable — the registry is inlined as JSON)', () => {
    const sfc = `<script setup lang="ts">defineProps({ ts: numberField({ default: () => 1 }) })</script><template><div /></template>`
    expect(() => extractBlockDef(sfc, 'Bad.vue')).toThrow(/JSON-serializable/)
  })

  it('ignores a defineProps nested in a helper function — only the top-level macro counts', () => {
    const sfc = `<script setup lang="ts">
function helper() { return defineProps({ fake: numberField() }) }
const props = defineProps({ heading: textField({ required: true }) })
</script><template><div /></template>`
    expect(extractBlockDef(sfc, 'Hero.vue').fields).toEqual({ heading: { type: 'text', required: true } })
  })
})

describe('renderBlockRegistry — the #kestrel/blocks virtual body, over the real demo SFCs', () => {
  it('emits an evaluable `export default [...]` of the extracted BlockDefs', () => {
    const hero = fileURLToPath(new URL('../../../../app/blocks/Hero.vue', import.meta.url))
    const prose = fileURLToPath(new URL('../../../../app/blocks/Prose.vue', import.meta.url))
    const code = renderBlockRegistry([hero, prose])
    const defs = JSON.parse(code.replace(/^export default /, '')) as Array<Record<string, unknown>>
    expect(defs.map((d) => d.name)).toEqual(['hero', 'prose'])
    expect((defs[0].fields as Record<string, unknown>).heading).toEqual({ type: 'text', required: true })
    expect(defs[1]).toMatchObject({ name: 'prose', label: { en: 'Prose', de: 'Fließtext' } })
  })
})
