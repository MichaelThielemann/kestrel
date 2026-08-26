import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const root = process.cwd()
const srcRoot = resolve(root, 'packages/kestrel-core/src')
const entry = resolve(srcRoot, 'client.ts')

// Only relative imports resolve within the package; a bare specifier is an npm dependency, checked
// separately below by name rather than by walking into node_modules.
const RELATIVE_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)(?:\s+type)?\s*(?:[^'"\n]*?\s+from\s+)?['"](\.[^'"\n]+)['"]/g
const ANY_IMPORT_SPEC_RE = /(?:^|\n)[ \t]*(?:import|export)(?:\s+type)?\s*(?:[^'"\n]*?\s+from\s+)?['"]([^'"\n]+)['"]/g

/** `@michaelthielemann/kestrel-core/client` is the browser-bundling boundary: a client file importing a runtime value from it
 *  must never transitively pull in a Node builtin — Vite externalizes an unresolvable `node:` specifier to
 *  an empty stub, and a NAMED import against that stub throws at module link time, before any application
 *  code runs. */
function resolveRelative(fromFile: string, spec: string): string {
  // Source imports use the NodeNext `.js`-extension convention (they resolve against the built dist/,
  // where the sibling really is `.js`) — swap it for the `.ts` file this walk actually reads.
  const withoutJs = spec.endsWith('.js') ? spec.slice(0, -3) : spec
  let target = resolve(dirname(fromFile), withoutJs)
  if (!target.endsWith('.ts')) target += '.ts'
  return target
}

function transitiveFileSet(entryFile: string): Map<string, string> {
  const files = new Map<string, string>()
  const stack = [entryFile]
  while (stack.length) {
    const file = stack.pop()!
    if (files.has(file)) continue
    const src = readFileSync(file, 'utf8')
    files.set(file, src)
    for (const m of src.matchAll(RELATIVE_IMPORT_RE)) {
      const target = resolveRelative(file, m[1]!)
      if (target.startsWith(srcRoot) && !files.has(target)) stack.push(target)
    }
  }
  return files
}

describe('@michaelthielemann/kestrel-core/client — browser-safety boundary', () => {
  it('client.ts and everything it transitively imports carry no `node:` specifier', () => {
    const files = transitiveFileSet(entry)
    expect(files.size, 'expected client.ts to resolve to at least one file').toBeGreaterThan(0)
    const offenders: string[] = []
    for (const [file, src] of files) {
      for (const m of src.matchAll(ANY_IMPORT_SPEC_RE)) {
        if (m[1]!.startsWith('node:')) offenders.push(`${file.slice(root.length + 1)}: '${m[1]}'`)
      }
    }
    expect(offenders, 'a node: specifier reachable from client.ts breaks the browser bundle at module-link time').toEqual([])
  })

  it('is not a trivial pass: the transitive walk actually reaches more than the entry file', () => {
    // client.ts is a pure re-export barrel — if this ever drops to 1, the walk above stopped following
    // imports (a regex/resolution regression) and the "no offenders" result would be vacuous.
    const files = transitiveFileSet(entry)
    expect(files.size).toBeGreaterThan(1)
  })
})
