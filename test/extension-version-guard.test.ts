import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()

// `.github/publish-if-new.sh` does `npm view "$name@$version"` and treats a HIT as success (already shipped,
// nothing to do) rather than failure — so a manifest that still names a published version publishes GREEN
// while silently dropping every source change since that version went out. There is no offline way to ask
// the registry what is live, so the only honest guard is a maintained record of versions already known to be
// published: it catches exactly the failure mode above (this list must be extended by hand, right before
// cutting a release that actually publishes a new extension version — a stale list only makes the guard
// under-strict, never wrongly red).
const ALREADY_PUBLISHED: Record<string, string[]> = {
  'extensions/galleries-secure': ['1.0.0'],
  'extensions/galleries-secure-proofing': ['1.0.0'],
}

describe('extension manifest versions — not already shipped', () => {
  for (const [dir, published] of Object.entries(ALREADY_PUBLISHED)) {
    it(`${dir} declares a version not already on the registry`, () => {
      const meta = JSON.parse(readFileSync(resolve(root, dir, 'package.json'), 'utf8')) as { version: string }
      expect(
        published,
        `${dir}@${meta.version} is already published — a release from this manifest would silently drop ` +
          `any source change since that version shipped`,
      ).not.toContain(meta.version)
    })
  }
})
