import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileString } from 'sass'

const root = fileURLToPath(new URL('..', import.meta.url))

// A consumer that injects its own design-system module into every stylesheet does so through Vite's
// `css.preprocessorOptions.scss.additionalData`, which Vite applies to EVERY entry — including the
// `.vue` style blocks Kestrel ships. This stands in for the worst case: a module forwarded `as *` whose
// member names all collide with Kestrel's own.
const CONSUMER_MODULE = `
  @mixin focus-ring { outline: 3px dashed hotpink; }
  @mixin sr-only { position: absolute; }
  @mixin input-base { border: 0; }
  @mixin input-slim { padding: 0; }
  @mixin ui-datepicker { color: red; }
  $gutter: 16px;
`
const ADDITIONAL_DATA = '@use "sass:color";\n@use "@/assets/scss/_mixins.scss" as *;\n'

const consumerImporter = {
  canonicalize: (url: string) => (url.startsWith('@/') ? new URL(`consumer:${url.slice(2)}`) : null),
  load: () => ({ contents: CONSUMER_MODULE, syntax: 'scss' as const }),
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(path)
    return path.endsWith('.vue') ? [path] : []
  })
}

/** Every SCSS block Vite compiles as its own entry (and therefore prepends `additionalData` to). */
const entries = [...walk(join(root, 'layers')), ...walk(join(root, 'extensions'))]
  .flatMap((file) => {
    const blocks = [...readFileSync(file, 'utf8').matchAll(/<style[^>]*lang="scss"[^>]*>([\s\S]*?)<\/style>/g)]
    return blocks.map((m, i) => ({ file, index: i, source: m[1]! }))
  })

describe('shipped SCSS under a consumer global module', () => {
  it('finds the style blocks to check', () => {
    expect(entries.length).toBeGreaterThan(20)
  })

  it.each(entries)('$file [$index] compiles without ambiguous member lookups', ({ file, source }) => {
    expect(() =>
      compileString(ADDITIONAL_DATA + source, {
        url: pathToFileURL(file),
        loadPaths: [dirname(file)],
        importers: [consumerImporter],
      }),
    ).not.toThrow()
  })
})
