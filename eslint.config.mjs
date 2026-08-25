// @ts-check
// The Nuxt-aware base is generated from the PLAYGROUND, not the root config: the root ships to consumers
// (package.json `files`), so it must stay free of devtooling. Playground composes every layer + both
// extensions (see playground/nuxt.config.ts), so its auto-import registry covers the whole monorepo.
import withNuxt from './playground/.nuxt/eslint.config.mjs'
import vuejsAccessibility from 'eslint-plugin-vuejs-accessibility'
import boundaries from 'eslint-plugin-boundaries'
import jsdoc from 'eslint-plugin-jsdoc'
import tsdoc from 'eslint-plugin-tsdoc'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('.', import.meta.url))

// Explicit imports only — auto-imports (the other half of layer coupling) are checked by
// test/architecture/layer-edges.test.ts against the same allowlist.
const edgeAllowlist = JSON.parse(readFileSync(new URL('./test/architecture/edge-allowlist.json', import.meta.url), 'utf8'))

const LAYER_NAMES = ['access', 'admin', 'auth', 'collections', 'core', 'fields', 'media', 'public', 'ui']

export default withNuxt(
  ...vuejsAccessibility.configs['flat/recommended'],
  {
    ignores: [
      '**/node_modules/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/.data/**',
      '**/dist/**',
      '**/.cache/**',
      'CHANGELOG.md',
    ],
  },
  {
    rules: {
      // A caught error is only useful if the finally-block/best-effort cleanup can run — but disallowing
      // an empty block entirely bans exactly that pattern (`try { … } finally { try { cleanup() } catch {} }`).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // False positive on file-based routing: Nuxt pages/layouts are named by URL segment or convention
      // (`index.vue`, `login.vue`, `admin.vue`, `[id].vue`), never by component identity. It also flags the
      // deliberate single-word naming of field/block components, which are disambiguated by their directory
      // (`components/field/Media.vue`, `app/blocks/Hero.vue`), not by a compound name.
      'vue/multi-word-component-names': 'off',
      // TS-typed `defineProps<{ x?: T }>()` already documents "absent means undefined" — a repo-wide
      // `withDefaults()` pass would touch ~30 components' runtime behavior for no safety gain over the
      // type system.
      'vue/require-default-prop': 'off',
      // Formatting, not correctness — deferred to a dedicated `features.stylistic` pass rather than mixed
      // into the first lint-adoption diff.
      'vue/html-self-closing': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/attributes-order': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.dom.test.ts', '**/*.nuxt.test.ts'],
    rules: {
      // `vi.mock()` must textually precede the imports it intercepts — vitest hoists the call, but the
      // rule doesn't know that and flags the (correct) ordering as an error.
      'import/first': 'off',
    },
  },
  {
    // Layer boundaries: server+app source only. Tests legitimately reach into fixtures across layers
    // (see docs/internals/layers-and-packages.md), so they're excluded here and from the graph rail's edge extraction.
    files: ['layers/**/*.ts', 'layers/**/*.vue'],
    ignores: ['**/*.test.ts', '**/*.dom.test.ts', '**/*.nuxt.test.ts'],
    plugins: { boundaries },
    settings: {
      // Explicit root-path: in this pnpm workspace the plugin's default resolver only sees dependencies
      // declared in the nearest package.json, which silently drops resolution for a bare cwd guess.
      'boundaries/root-path': repoRoot,
      'boundaries/elements': LAYER_NAMES.map(name => ({ type: name, pattern: `layers/${name}/**` })),
      // The plugin's bundled resolver defaults to .js/.json/.node; without .ts/.vue every extensionless
      // relative import here fails to resolve and the rule silently never fires.
      'import/resolver': { node: { extensions: ['.js', '.mjs', '.ts', '.vue', '.json'] } },
    },
    rules: {
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        policies: [
          { from: { element: { type: '*' } }, allow: { to: { element: { type: '{{ from.element.type }}' } } } },
          ...edgeAllowlist.edges.map(edge => ({
            from: { element: { type: edge.from } },
            allow: { to: { element: { type: edge.to } } },
          })),
        ],
      }],
    },
  },
  {
    // `server/core/**` holds the pure decision cores — no Node/H3/DB access, no
    // hidden clock/randomness/env reads. A core takes every such fact as data instead.
    files: ['**/server/core/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'h3', message: 'core is pure: no transport access. Take the needed value as data.' },
          { name: 'better-sqlite3', message: 'core is pure: no direct DB access. Take the needed value as data.' },
          { name: 'drizzle-orm', message: 'core is pure: no ORM access. Take the needed value as data.' },
        ],
        patterns: [
          { group: ['node:*'], message: 'core is pure: no Node builtins.' },
          { group: ['drizzle-orm/*'], message: 'core is pure: no ORM access. Take the needed value as data.' },
          { group: ['better-sqlite3/*'], message: 'core is pure: no direct DB access. Take the needed value as data.' },
        ],
      }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'core is pure: no Date.now(). Take `facts.now` as data.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'core is pure: no argless `new Date()`. Take `facts.now` as data.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'core is pure: no Math.random(). Take the needed value as data.',
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'core is pure: no process.env. Take the needed value as data.',
        },
      ],
    },
  },
  {
    // The current public surface (ADR-0015): TSDoc presence + syntax.
    files: [
      'packages/kestrel-contracts/src/**/*.ts',
      'packages/kestrel-core/src/**/*.ts',
      'packages/kestrel-fields/src/**/*.ts',
      'packages/kestrel-auth/src/**/*.ts',
      'packages/kestrel-access/src/**/*.ts',
      'packages/kestrel-media/src/**/*.ts',
      'packages/kestrel-collections/src/**/*.ts',
      'packages/kestrel-publishing/src/**/*.ts',
      'packages/kestrel-delivery-live/src/**/*.ts',
      'packages/kestrel-delivery-static/src/**/*.ts',
    ],
    plugins: { jsdoc, tsdoc },
    rules: {
      'tsdoc/syntax': 'error',
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: true,
        require: {
          FunctionDeclaration: true,
        },
        // Only top-level exports: the plain node-type strings would also flag arrow functions and
        // variable declarations nested inside an exported object (e.g. `fieldTypes`'s per-type
        // `column`/`validator` closures), which are implementation, not part of the public surface.
        contexts: [
          'TSInterfaceDeclaration',
          'TSTypeAliasDeclaration',
          'ExportNamedDeclaration > VariableDeclaration',
        ],
      }],
    },
  },
)
