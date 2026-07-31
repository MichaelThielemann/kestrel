import { describe, it, expect } from 'vitest'
import { diagnoseAppShell } from './app-shell'

const LAYER_APP_VUE = `<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
`

// What `nuxi init` / `npm create nuxt` writes into a fresh project.
const NUXI_INIT_APP_VUE = `<template>
  <div>
    <NuxtRouteAnnouncer />
    <NuxtWelcome />
  </div>
</template>
`

const read = (files: Record<string, string>) => (file: string) => {
  const src = files[file]
  if (src === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return src
}

describe('diagnoseAppShell', () => {
  it('is silent for the app.vue the public layer ships', () => {
    expect(
      diagnoseAppShell({
        mainComponent: '/pkg/layers/public/app/app.vue',
        pagesEnabled: true,
        read: read({ '/pkg/layers/public/app/app.vue': LAYER_APP_VUE }),
      }),
    ).toEqual([])
  })

  it('errors when the winning app.vue has no <NuxtPage> — nothing renders, /admin included', () => {
    const found = diagnoseAppShell({
      mainComponent: '/site/app/app.vue',
      pagesEnabled: true,
      read: read({ '/site/app/app.vue': NUXI_INIT_APP_VUE }),
    })
    expect(found).toHaveLength(1)
    expect(found[0].level).toBe('error')
    expect(found[0].message).toContain('/site/app/app.vue')
    expect(found[0].message).toContain('<NuxtPage')
  })

  it('warns when the winning app.vue renders pages but drops <NuxtLayout> — the admin loses its shell', () => {
    const found = diagnoseAppShell({
      mainComponent: '/site/app/app.vue',
      pagesEnabled: true,
      read: read({ '/site/app/app.vue': '<template><NuxtPage /></template>' }),
    })
    expect(found).toHaveLength(1)
    expect(found[0].level).toBe('warn')
    expect(found[0].message).toContain('<NuxtLayout')
  })

  it('accepts the shorthand <NuxtPage/> and <NuxtLayout/> spellings', () => {
    expect(
      diagnoseAppShell({
        mainComponent: '/site/app/app.vue',
        pagesEnabled: true,
        read: read({ '/site/app/app.vue': '<template><NuxtLayout><NuxtPage/></NuxtLayout></template>' }),
      }),
    ).toEqual([])
  })

  it('errors when pages are disabled — every admin route lives in app/pages/admin', () => {
    const found = diagnoseAppShell({
      mainComponent: '/pkg/layers/public/app/app.vue',
      pagesEnabled: false,
      read: read({ '/pkg/layers/public/app/app.vue': LAYER_APP_VUE }),
    })
    expect(found).toHaveLength(1)
    expect(found[0].level).toBe('error')
    expect(found[0].message).toContain('pages')
  })

  it('reports both problems when an app.vue without <NuxtPage> is combined with pages: false', () => {
    const found = diagnoseAppShell({
      mainComponent: '/site/app/app.vue',
      pagesEnabled: false,
      read: read({ '/site/app/app.vue': NUXI_INIT_APP_VUE }),
    })
    expect(found.map((d) => d.level)).toEqual(['error', 'error'])
  })

  it('stays silent when no app.vue resolves at all (Nuxt generates its own)', () => {
    expect(diagnoseAppShell({ mainComponent: undefined, pagesEnabled: true, read: read({}) })).toEqual([])
  })

  it('stays silent when the file cannot be read rather than guessing', () => {
    expect(
      diagnoseAppShell({ mainComponent: '/site/app/app.vue', pagesEnabled: true, read: read({}) }),
    ).toEqual([])
  })

  it('ignores a <NuxtPage> that only appears inside a comment', () => {
    const found = diagnoseAppShell({
      mainComponent: '/site/app/app.vue',
      pagesEnabled: true,
      read: read({ '/site/app/app.vue': '<template><!-- <NuxtPage /> --><NuxtWelcome /></template>' }),
    })
    expect(found).toHaveLength(1)
    expect(found[0].level).toBe('error')
  })
})
