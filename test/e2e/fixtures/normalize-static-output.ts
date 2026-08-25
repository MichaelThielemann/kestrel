/**
 * Strips the per-run nondeterminism dev-mode SSR HTML (and the meta artifacts that embed publish
 * timestamps) unavoidably carries, so a byte-compare against a committed baseline captured in a DIFFERENT
 * process/filesystem location/moment is still meaningful: a real content difference stays visible, while a
 * random record id, a wall-clock timestamp, or a dev-server's absolute repo path does not.
 */
export function normalizeStaticOutput(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TS>')
    .replace(/\/[^"'\s]*?\/(layers\/|node_modules\/)/g, '/<ROOT>/$1')
    // The random nanoid (record id / translationGroup) is only ever baked into Nuxt's own hydration data
    // island — a bare quoted string inside `<script ... data-nuxt-data="nuxt-app" ...>...</script>`, not a
    // key:value pair (devalue's array-position format has no attribute name to anchor on). Scoped to that
    // island specifically, NOT the whole document: an id-length quoted string in real page content (a
    // 21-character title, a slug) must survive untouched — see the mutant test in normalize-static-output.test.ts.
    .replace(/(<script[^>]*data-nuxt-data="nuxt-app"[^>]*>)([\s\S]*?)(<\/script>)/, (_m, open: string, island: string, close: string) =>
      open + island.replace(/"[A-Za-z0-9_-]{20,22}"/g, '"<ID>"') + close)
}
