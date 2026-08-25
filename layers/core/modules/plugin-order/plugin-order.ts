import { existsSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'

const PLUGIN_EXTENSIONS = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx']

/** One of Kestrel's own `server/plugins/**` files, in the position it must execute at. */
export interface PluginEntry {
  /** The layer directory name (`layers/<layer>`). */
  layer: string
  /** Path relative to the layer root. */
  file: string
  /** Keys (`${layer}/${file}`) of OTHER entries that MUST appear at a lower index than this one — empty
   *  when nothing's correctness depends on this entry's position. Machine-checked by `validatePluginOrder`
   *  against `PLUGIN_ORDER`'s actual array positions, not merely asserted. */
  after: string[]
  /** One line: the real dependency this entry's `after` encodes (when non-empty), or the evidence it's
   *  safe to reorder (when empty) — always named, never assumed. */
  evidence: string
}

/** `${layer}/${file}` — the identity `after` references and `validatePluginOrder` indexes by. */
const key = (p: Pick<PluginEntry, 'layer' | 'file'>): string => `${p.layer}/${p.file}`

/**
 * The declared execution order for every plugin Kestrel itself ships — DATA, read and pushed by
 * `layers/core/modules/plugin-order/index.ts`, replacing Nitro's own layer-then-filename sort for these
 * files. `validatePluginOrder` (below) makes TWO kinds of drift a loud build failure instead of a silent
 * Nitro auto-append or an unenforced comment: (1) a plugin file on disk that isn't declared here (or a
 * declared entry with no file behind it), and (2) an `after` dependency whose real position in this array
 * doesn't actually satisfy it — a reshuffle that moves a dependent entry ahead of what it depends on fails
 * the SAME way a missing/phantom file does, not silently.
 *
 * Audited against a real boot in both contexts (in-repo `nuxt build` and the playground's
 * `extends: ['..', ...]` composition) via a throwaway probe module reading the resolved
 * `nitro.options.plugins`. Confirmed identical for Kestrel's own 6 layers in both contexts:
 * core → fields → media → auth → collections → public,
 * filename-sort within each layer — which is exactly what this list encodes explicitly.
 */
export const PLUGIN_ORDER: PluginEntry[] = [
  {
    layer: 'core', file: 'server/plugins/00.config.ts', after: [],
    evidence: 'Nothing depends on core/00.config.ts to come after anything else; everything downstream depends on IT (see the after: entries below).',
  },
  {
    layer: 'core', file: 'server/plugins/00.migrate.ts', after: ['core/server/plugins/00.config.ts'],
    evidence: 'Calls useDb(), which reads the config provider 00.config.ts seeds.',
  },
  {
    layer: 'core', file: 'server/plugins/01.register-introspection-pipeline.ts', after: [],
    evidence: 'registerPipeline into a Map; read lazily on first request, never at another plugin\'s init.',
  },
  {
    layer: 'core', file: 'server/plugins/01.register-openapi-pipeline.ts', after: [],
    evidence: 'registerPipeline into a Map; read lazily on first request, never at another plugin\'s init.',
  },
  {
    layer: 'core', file: 'server/plugins/01.register-tooling-pipelines.ts', after: [],
    evidence: 'registerPipeline into a Map; read lazily on first request, never at another plugin\'s init.',
  },
  {
    layer: 'core', file: 'server/plugins/02.schema-sync.ts', after: ['core/server/plugins/00.migrate.ts'],
    evidence: 'Dev-only additive auto-migration; its own header comment: "Runs after 00.migrate, so built-in collections are already migrated and this is a no-op on them".',
  },
  {
    layer: 'core', file: 'server/plugins/04.outbox-worker.ts', after: [],
    evidence: 'Starts its own setInterval poll loop against useDb(); no other plugin\'s behavior depends on when this one starts polling (the poll itself is unconditional, no readiness handshake with another plugin).',
  },
  {
    layer: 'core', file: 'server/plugins/05.reindex-refs.ts', after: [],
    evidence: 'registerReindexRefs() registers a handler on the outbox event bus; dispatched later by the outbox worker, never read at another plugin\'s init.',
  },
  {
    layer: 'fields', file: 'server/plugins/01.register-blocks-pipeline.ts', after: [],
    evidence: 'registerPipeline into a Map; read lazily on first request.',
  },
  {
    layer: 'fields', file: 'server/plugins/01.register-field-populate.ts', after: [],
    evidence: 'Registers the single global row populator; field populators (media/link/richtext/relation) are looked up at READ time, so this plugin\'s order vs. the layer plugins that register them does not matter (stated in the plugin\'s own header comment).',
  },
  {
    layer: 'media', file: 'server/plugins/01.register-media-pipelines.ts', after: [],
    evidence: 'registerPipeline into a Map; read lazily on first request.',
  },
  {
    layer: 'media', file: 'server/plugins/02.register-media.ts', after: [],
    evidence: 'registerFieldPopulator; looked up at read time, not at another plugin\'s init.',
  },
  {
    layer: 'media', file: 'server/plugins/04.variant-capture.ts', after: [],
    evidence: 'Hooks the render request context (isRendererContext) and stashes discovered variants during SSR; reconciled per-render, no dependency on another plugin having run first.',
  },
  {
    layer: 'media', file: 'server/plugins/05.media-cleanup.ts', after: [],
    evidence: 'registerMediaCleanup() registers a handler on the outbox event bus; dispatched later.',
  },
  {
    layer: 'auth', file: 'server/plugins/01.register-auth-pipelines.ts', after: [],
    evidence: 'registerPipeline into a Map; read lazily on first request.',
  },
  {
    layer: 'collections', file: 'server/plugins/01.register.ts', after: [],
    evidence: 'Reads the #kestrel/collections and #kestrel/blocks VIRTUALS directly (never allCollections()); writes the runtime registry, but no plugin in this list reads that registry at its own init — only at request time, well after every plugin has finished (documented invariant, docs/internals/architecture.md § Server plugins).',
  },
  {
    layer: 'collections', file: 'server/plugins/02.register-relation-populate.ts', after: [],
    evidence: 'registerFieldPopulator; looked up at read time.',
  },
  {
    layer: 'public', file: 'server/plugins/00.ensure-snapshot-triggers.ts',
    after: ['core/server/plugins/00.migrate.ts', 'core/server/plugins/02.schema-sync.ts'],
    evidence: 'THE one real cross-layer dependency: needs the snapshot store\'s table to already exist, created by core\'s 00.migrate (in-repo) or 02.schema-sync (consumer). Self-tolerant even so — a boot before either has run logs a warning and returns rather than crashing (ensureSnapshotTriggers\'s own TSDoc); still placed after both so the warning path is never hit in practice.',
  },
  {
    layer: 'public', file: 'server/plugins/01.register-public-pipelines.ts', after: [],
    evidence: 'registerPipeline into a Map; read lazily on first request.',
  },
  {
    layer: 'public', file: 'server/plugins/02.register-links.ts', after: [],
    evidence: 'registerFieldPopulator; looked up at read time.',
  },
  {
    layer: 'public', file: 'server/plugins/03.redirects.ts', after: [],
    evidence: 'registerAfterStep registers a DEFERRED, when-scoped pipeline hook; invoked on a future write, not at another plugin\'s init.',
  },
  {
    layer: 'public', file: 'server/plugins/05.plan-publish.ts', after: [],
    evidence: 'Registers planPublish on the outbox bus; dispatched later by the outbox worker, after commit — never at plugin init.',
  },
  {
    layer: 'public', file: 'server/plugins/zz.publish.ts', after: [],
    evidence: 'Registers a deferred CRITICAL after-step and starts the boot publish; the boot publish\'s own registry read sits after an `await` inside publishFull, so it resumes only once the synchronous plugin loop (including collections\' 01.register) has already finished — order-free by construction (documented invariant, docs/internals/architecture.md § Server plugins).',
  },
]

/** POSIX-normalize a path for comparison — `path.join`'s OUTPUT is OS-native (backslash on Windows), but
 *  `PluginEntry.file` is authored with literal forward slashes (`'server/plugins/00.config.ts'`) and Nuxt's
 *  own `_layers[].cwd` values are not guaranteed to be OS-native either (bundlers commonly normalize to
 *  POSIX internally regardless of platform). Comparing through one canonical POSIX form — rather than two
 *  parallel branches guessing which separator a given string happens to use — removes the asymmetry a
 *  Windows build would otherwise hit. */
const toPosix = (p: string): string => p.split(sep).join('/')

/** Find layer `name`'s root among Nuxt's resolved `_layers` cwds. Nitro plugin paths must be absolute
 *  filesystem paths — there is no bare-specifier equivalent for a Nitro plugin the way there is for a
 *  package export — so this lookup (mirroring the pattern auto-discovery used for the pre-package fields
 *  seed) is still needed. */
function layerRoot(roots: string[], name: string): string {
  const root = roots.find((r) => toPosix(r).endsWith(`/layers/${name}`))
  if (!root) throw new Error(`[kestrel] plugin-order: could not locate the "${name}" layer root`)
  return root
}

/** `PLUGIN_ORDER` (or an injected `list`, for testing drift scenarios without editing the real constant),
 *  resolved to absolute file paths in declared order — what gets pushed into `nitro.options.plugins`. */
export function resolvePluginOrder(roots: string[], list: PluginEntry[] = PLUGIN_ORDER): string[] {
  return list.map((p) => join(layerRoot(roots, p.layer), p.file))
}

/** Nitro's OWN plugin file extension set (`nitropack`'s `GLOB_SCAN_PATTERN` for `plugins/`) — matched
 *  exactly, not approximated, so this scan can never be fooled by a file Nitro would pick up that this
 *  didn't look for. */
const PLUGIN_FILE_RE = new RegExp(`\\.(${PLUGIN_EXTENSIONS.join('|')})$`)
const isPluginFile = (name: string) => PLUGIN_FILE_RE.test(name) && !name.endsWith('.test.ts') && !/\.test\.(js|mjs|cjs|mts|cts|tsx|jsx)$/.test(name)

/** Every file under `dir` Nitro's own scan would find — RECURSIVELY (Nitro's glob is `plugins/**\/*.{ext}`,
 *  not a flat listing), matching Nitro's exact extension set. Mirrors Nitro's own convention for real, not
 *  approximately. */
function walkPluginFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkPluginFiles(full, out)
    else if (isPluginFile(entry.name)) out.push(full)
  }
  return out
}

/** Every plugin file Nitro would ACTUALLY scan across the layers `list` declares — derived from `list`
 *  itself (not a separately hardcoded layer set) so an injected test `list` governs exactly the layers it
 *  claims to, never silently falling back to a hardcoded layer set regardless of what was actually passed
 *  in — the shape a test injecting a fully isolated fake `list`/`roots` pair depends on. */
function scanActualPlugins(roots: string[], list: PluginEntry[]): string[] {
  const layers = [...new Set(list.map((p) => p.layer))]
  const found: string[] = []
  for (const layer of layers) found.push(...walkPluginFiles(join(layerRoot(roots, layer), 'server/plugins')))
  return found.sort()
}

/** `PLUGIN_ORDER` entries reachable from `list`, by `key`. */
function assertOrderConstraintsSatisfied(list: PluginEntry[]): void {
  const indexOf = new Map(list.map((p, i) => [key(p), i]))
  const violations: string[] = []
  for (const p of list) {
    for (const dep of p.after) {
      const depIndex = indexOf.get(dep)
      const ownIndex = indexOf.get(key(p))!
      if (depIndex === undefined) {
        violations.push(`${key(p)} declares after: "${dep}", but no such entry exists in PLUGIN_ORDER`)
      } else if (depIndex >= ownIndex) {
        violations.push(`${key(p)} must come after ${dep} (${p.evidence}), but is declared at index ${ownIndex} vs. ${dep}'s index ${depIndex}`)
      }
    }
  }
  if (violations.length) {
    throw new Error(['[kestrel] plugin-order: PLUGIN_ORDER violates a declared after: dependency.', ...violations.map((v) => `  ${v}`)].join('\n'))
  }
}

/**
 * LOUD failure for BOTH kinds of drift: (1) a plugin file present on disk but missing from `PLUGIN_ORDER`
 * (which Nitro's own scan-and-append would otherwise silently tack onto the END, in undeclared position —
 * see nitropack's `scanPlugins`/`options.plugins.push` for exactly that fallback behavior) or a declared
 * entry whose file no longer exists; (2) a declared `after` dependency the array's ACTUAL positions don't
 * satisfy — a reshuffle, not just a deletion, fails just as loudly. Throws — the ONLY way a Nuxt module's
 * `setup()` can fail the build loudly (a Nitro hook can't itself abort configuration once already running).
 * Called from `setup()`, before the `nitro:config` hook — a build-time failure, not a Nitro-time one.
 */
export function validatePluginOrder(roots: string[], list: PluginEntry[] = PLUGIN_ORDER): void {
  assertOrderConstraintsSatisfied(list)

  const declared = new Set(resolvePluginOrder(roots, list))
  const actual = new Set(scanActualPlugins(roots, list))
  const missing = [...actual].filter((f) => !declared.has(f)) // on disk, not declared
  const phantom = [...declared].filter((f) => !actual.has(f)) // declared, not on disk
  if (missing.length === 0 && phantom.length === 0) return
  const lines: string[] = ['[kestrel] plugin-order: PLUGIN_ORDER has drifted from the real server/plugins/ files.']
  if (missing.length) lines.push(`  On disk but NOT declared (would silently land last, undeclared, via Nitro's own scan-and-append): ${missing.join(', ')}`)
  if (phantom.length) lines.push(`  Declared but the file does not exist: ${phantom.join(', ')}`)
  lines.push('  Fix PLUGIN_ORDER in layers/core/modules/plugin-order/plugin-order.ts.')
  throw new Error(lines.join('\n'))
}

/**
 * The permanent, in-process observer of the REAL merge: `validatePluginOrder`/`resolvePluginOrder` only
 * prove what THIS module pushes — they cannot see what Nitro's own scan-and-append, another module's
 * `nitro:config` hook, or Nitro's own internal/dev-tooling plugins do to the array afterward. Called from
 * `index.ts`'s `nitro:init` hook (which receives the fully-built Nitro instance, after every `nitro:config`
 * hook AND Nitro's own scan have both already run) against the REAL `nitro.options.plugins`, this asserts
 * our declared order survived that whole pipeline intact: every `expected` path appears, in order, as ONE
 * CONTIGUOUS RUN somewhere in the real array — NOT necessarily a prefix. A real `nuxt dev` boot pushes
 * `@nuxt/devtools`'/`@nuxt/nitro-server`'s own internal plugins (an inline devtools runtime, dev-server
 * request logging) ahead of everything via their own earlier-registered `nitro:config` hooks — legitimate
 * Nuxt/Nitro tooling this module neither owns nor should reject, so "prefix" is the wrong bar; "our own
 * declared plugins never get split apart or interleaved with anyone else's" is the real, checkable
 * invariant, and is what this asserts. Also asserts the real array has no duplicate entries anywhere
 * (Nitro's own `!plugins.includes(x)` scan guard is SUPPOSED to prevent one, but this checks the outcome
 * directly rather than trusting that guard blind). Throws — a boot-time, not merely a config-time, failure.
 */
export function assertEffectiveOrderMatches(actualPlugins: (string | undefined)[], expected: string[]): void {
  const cleaned = actualPlugins.filter((p): p is string => typeof p === 'string')
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const p of cleaned) {
    if (seen.has(p)) duplicates.add(p)
    seen.add(p)
  }
  if (duplicates.size) {
    throw new Error(`[kestrel] plugin-order: nitro.options.plugins contains duplicate entries: ${[...duplicates].join(', ')}`)
  }
  if (expected.length === 0) return
  let start = -1
  for (let i = 0; i + expected.length <= cleaned.length; i++) {
    if (expected.every((e, j) => cleaned[i + j] === e)) { start = i; break }
  }
  if (start === -1) {
    throw new Error(
      '[kestrel] plugin-order: the REAL nitro.options.plugins does not contain PLUGIN_ORDER as one unbroken, '
      + "in-order run — something split our declared block apart or interleaved into it.\n"
      + `  Expected (contiguous, any position): ${expected.join(', ')}\n`
      + `  Actual full list:                    ${cleaned.join(', ')}`,
    )
  }
}
