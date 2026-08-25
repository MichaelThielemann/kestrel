import { describe, it, expect } from 'vitest'
import { normalizeStaticOutput } from './normalize-static-output'

describe('normalizeStaticOutput', () => {
  it('replaces the nanoid inside the nuxt-data hydration island', () => {
    const html = '<script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">["6lI3Wlr3Jmif_jgyqONTS"]</script>'
    expect(normalizeStaticOutput(html)).toBe('<script type="application/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">["<ID>"]</script>')
  })

  it('replaces an ISO timestamp anywhere in the document', () => {
    expect(normalizeStaticOutput('<lastmod>2026-08-23T15:07:14.343Z</lastmod>')).toBe('<lastmod><TS></lastmod>')
  })

  it('replaces a dev-server absolute path before layers/ or node_modules/', () => {
    const html = '<link href="/_nuxt/@fs/home/michael/projects/kestrel/layers/public/app/pages/[...slug].vue">'
    expect(normalizeStaticOutput(html)).toBe('<link href="/<ROOT>/layers/public/app/pages/[...slug].vue">')
  })

  // A mid-length (20-22 char) quoted CONTENT string OUTSIDE the hydration island — the exact shape a
  // real page title/slug could take — must NOT be normalized away.
  it('does NOT touch a 21-character quoted string outside the nuxt-data island', () => {
    const id21 = 'Twenty_One_Chars_Lon1'
    expect(id21).toHaveLength(21)
    const html = `<meta property="og:title" content="${id21}">`
    expect(normalizeStaticOutput(html)).toBe(html)
  })

  it('does not touch a nuxt-data-shaped id string sitting outside any script tag', () => {
    const text = 'plain text: "6lI3Wlr3Jmif_jgyqONTS" stays as-is'
    expect(normalizeStaticOutput(text)).toBe(text)
  })
})
