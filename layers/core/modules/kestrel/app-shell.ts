export type AppShellDiagnostic = { level: 'error' | 'warn'; message: string }

export type AppShellInput = {
  mainComponent: string | null | undefined
  pagesEnabled: boolean
  read: (file: string) => string
}

const withoutComments = (src: string) => src.replace(/<!--[\s\S]*?-->/g, '')

// `<nuxt-page />` is as valid as `<NuxtPage />`; matching only the Pascal spelling would flag a working app.
const kebab = (tag: string) => tag.replace(/(?!^)([A-Z])/g, '-$1').toLowerCase()
const uses = (src: string, tag: string) => new RegExp(`<\\s*(${tag}|${kebab(tag)})[\\s/>]`, 'i').test(src)

const FIX = `
  <template>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </template>`

/** Reports only — assigning `mainComponent` would defeat a legitimate override. See ADR-0005. */
export function diagnoseAppShell({ mainComponent, pagesEnabled, read }: AppShellInput): AppShellDiagnostic[] {
  const found: AppShellDiagnostic[] = []

  if (!pagesEnabled) {
    found.push({
      level: 'error',
      message:
        'the pages feature is disabled (`pages: false`), so no route is registered at all — the admin is a set of pages under `app/pages/admin/`. Remove the override to reach /admin.',
    })
  }

  if (mainComponent) {
    let src: string | undefined
    try {
      src = withoutComments(read(mainComponent))
    } catch {
      // An unreadable app root is Nuxt's to report; guessing here would produce a phantom error.
    }
    if (src !== undefined && !uses(src, 'NuxtPage')) {
      found.push({
        level: 'error',
        message: `${mainComponent} renders no <NuxtPage />, so NO route renders — including /admin. It shadows Kestrel's own app.vue because the consumer layer wins. Either delete it (Kestrel ships a working one) or make it:${FIX}`,
      })
    } else if (src !== undefined && !uses(src, 'NuxtLayout')) {
      found.push({
        level: 'warn',
        message: `${mainComponent} renders no <NuxtLayout />, so page-level \`layout\` is ignored and the admin loses its navigation shell. Wrap <NuxtPage /> in <NuxtLayout>.`,
      })
    }
  }

  return found
}
