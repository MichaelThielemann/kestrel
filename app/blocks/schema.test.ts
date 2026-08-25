import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach } from 'vitest'
import { clearBlocks, registerBlock, allBlocks, buildBlocksSchema } from '@kestrel/fields'
import { extractBlockDef } from '../../layers/core/modules/auto-discovery/extract-block'

// End-to-end: the demo block SFCs → the build extractor → the block registry → the Zod validator.
const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
const hero = extractBlockDef(read('Hero.vue'), 'Hero.vue')
const prose = extractBlockDef(read('Prose.vue'), 'Prose.vue')

beforeEach(() => clearBlocks())

describe('starter block SFCs → extracted schema', () => {
  it('extracts the expected block names + field shapes from the SFCs', () => {
    expect(hero.name).toBe('hero')
    expect(hero.fields).toEqual({
      heading: { type: 'text', required: true },
      image: { type: 'media', options: { accept: 'image' } },
      cta: { type: 'link' },
    })
    expect(hero.slots).toEqual(['default'])
    expect(hero.icon).toBe('image')
    expect(prose).toEqual({ name: 'prose', fields: { body: { type: 'richtext', required: true } }, label: { en: 'Prose', de: 'Fließtext' }, icon: 'file-text' })
  })

  it('prose validates a richtext body and sanitizes it', () => {
    registerBlock(prose)
    const s = buildBlocksSchema(allBlocks())
    const out = s.parse([{ id: '1', type: 'prose', props: { body: '<script>x</script><p>hi</p>' } }]) as Array<{ props: { body: string } }>
    expect(out[0].props.body).toBe('<p>hi</p>')
  })

  it('hero requires a heading and accepts an optional image id + default slot', () => {
    registerBlock(hero)
    const s = buildBlocksSchema(allBlocks())
    expect(s.safeParse([{ id: '1', type: 'hero', props: {} }]).success).toBe(false)
    expect(s.safeParse([{ id: '1', type: 'hero', props: { heading: 'Hi', image: 5 } }]).success).toBe(true)
  })

  it('hero declares + validates an optional cta link (rejects a non-http url)', () => {
    registerBlock(hero)
    const s = buildBlocksSchema(allBlocks())
    expect(s.safeParse([{ id: '1', type: 'hero', props: { heading: 'Hi', cta: { type: 'external', url: 'https://x.io' } } }]).success).toBe(true)
    expect(s.safeParse([{ id: '1', type: 'hero', props: { heading: 'Hi', cta: { type: 'internal', collection: 'pages', id: 5 } } }]).success).toBe(true)
    // only true once `cta` is a declared (validated) field — an undeclared prop would pass through unchecked
    expect(s.safeParse([{ id: '1', type: 'hero', props: { heading: 'Hi', cta: { type: 'external', url: 'javascript:alert(1)' } } }]).success).toBe(false)
  })
})
