import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Vitest runs from the package root.
const root = process.cwd()
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')
const configMd = read('docs/guide/configuration.md')
const architectureMd = read('docs/internals/architecture.md')
const readme = read('README.md')
const envExample = read('.env.example')

describe('docs — IP allow-list', () => {
  it('documents KESTREL_IP_ALLOWLIST and KESTREL_IP_ALLOWLIST_MODE', () => {
    // 00.ip-allowlist.ts gates every path once KESTREL_IP_ALLOWLIST is set; an undocumented security
    // control is one nobody configures (or worse, misconfigures blind).
    expect(configMd).toMatch(/KESTREL_IP_ALLOWLIST\b/)
    expect(configMd).toMatch(/KESTREL_IP_ALLOWLIST_MODE/)
    expect(configMd).toMatch(/enforce/)
  })

  it('does not scope KESTREL_TRUST_PROXY to the login-throttle alone', () => {
    // clientIp() (client-ip.ts) backs both the login throttle AND the IP-allowlist gate — the doc line
    // must not imply the depth only matters for throttling.
    const line = configMd.match(/- `KESTREL_TRUST_PROXY`[^\n]*/)?.[0] ?? ''
    expect(line).not.toMatch(/login-throttle client IP\.$/)
  })
})

describe('docs — session max-age', () => {
  it('does not claim lowering the max-age shortens sessions already issued', () => {
    // verifySession only rejects on the exp baked in at issue time; shouldRefreshSession only re-issues
    // near expiry. A lower KESTREL_SESSION_MAX_AGE does nothing for a cookie already outstanding.
    const entry = configMd.match(/- `KESTREL_SESSION_MAX_AGE`[\s\S]*?(?=\n- `|\n\n)/)?.[0] ?? ''
    expect(entry).not.toMatch(/Lowering it takes effect on the next request\.?/)
    expect(entry).toMatch(/logout/i)
  })
})

describe('docs — README session-secret boot claim', () => {
  it('does not claim a missing KESTREL_SESSION_SECRET aborts boot', () => {
    // sessionSettings() is only invoked per-/api/* request (access-guard.ts); no plugin calls it at
    // startup, so the process boots and binds the port fine with the secret unset.
    expect(readme).not.toMatch(/missing\s+it aborts boot/i)
  })
})

describe('docs — .env.example media defaults', () => {
  it('comments out the media vars that merely restate built-in defaults', () => {
    // Uncommented here, they silently win over kestrel.config.ts media settings per the env-first
    // precedence, unlike every other optional entry in this file.
    expect(envExample).not.toMatch(/^KESTREL_MEDIA_DRIVER=/m)
    expect(envExample).not.toMatch(/^KESTREL_MEDIA_LOCAL_DIR=/m)
    expect(envExample).not.toMatch(/^KESTREL_MEDIA_BASE_URL=/m)
    expect(envExample).not.toMatch(/^KESTREL_MEDIA_MAX_BYTES=/m)
  })
})

describe('docs — architecture.md BlockRenderer mechanisms', () => {
  it('describes resolution via resolveDynamicComponent, not resolveComponent', () => {
    expect(architectureMd).not.toMatch(/resolveComponent\b/)
    expect(architectureMd).toMatch(/resolveDynamicComponent/)
  })

  it('credits addComponentsDir for global block registration, not a ".global" filename suffix', () => {
    expect(architectureMd).not.toMatch(/`\.global`\s+suffix/)
    expect(architectureMd).toMatch(/addComponentsDir/)
  })
})
