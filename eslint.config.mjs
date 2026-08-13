// @ts-check
// The Nuxt-aware base is generated from the PLAYGROUND, not the root config: the root ships to consumers
// (package.json `files`), so it must stay free of devtooling. Playground composes every layer + both
// extensions (see playground/nuxt.config.ts), so its auto-import registry covers the whole monorepo.
import withNuxt from './playground/.nuxt/eslint.config.mjs'
import vuejsAccessibility from 'eslint-plugin-vuejs-accessibility'

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
)
