export const PACKAGE_NAME = '@michaelthielemann/kestrel'

// Template dotfiles are `_`-prefixed because npm strips a literal `.gitignore` from a tarball. ADR-0005.
const RENAMES = {
  _gitignore: '.gitignore',
  '_env.example': '.env.example',
  '_package.json': 'package.json',
}

export function targetName(rel) {
  const parts = rel.split('/')
  const base = parts[parts.length - 1]
  parts[parts.length - 1] = RENAMES[base] ?? base
  return parts.join('/')
}

/** An unknown placeholder is left as-is so a typo is visible rather than silently blank. */
export function renderTemplate(src, vars) {
  return src.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole))
}

export function toPackageName(dirName) {
  const slug = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return slug || 'kestrel-site'
}

const KEY_RE = /^\s*([A-Z][A-Z0-9_]*)\s*=/

/**
 * Fills only keys that are absent or empty, so re-running `init` never rotates a live session secret.
 * A key in `force` replaces a value that is already there — for a secret the caller supplied by hand,
 * where being handed one at all is the instruction to change it.
 * Returns the new text plus the keys that changed.
 */
export function mergeEnv(existing, entries, force = []) {
  const forced = new Set(force)
  const pending = new Map(Object.entries(entries))
  const lines = existing === '' ? [] : existing.split('\n')
  const written = []

  // A dotenv loader takes the LAST assignment of a key, so filling the first would leave the file
  // reporting a value the app never sees.
  const lastIndex = new Map()
  lines.forEach((line, i) => {
    const key = KEY_RE.exec(line)?.[1]
    if (key) lastIndex.set(key, i)
  })

  const out = lines.map((line, i) => {
    const key = KEY_RE.exec(line)?.[1]
    if (!key || !pending.has(key) || lastIndex.get(key) !== i) return line
    const value = pending.get(key)
    pending.delete(key)
    if (line.slice(line.indexOf('=') + 1).trim() !== '' && !forced.has(key)) return line
    written.push(key)
    return `${key}=${value}`
  })

  if (pending.size) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('')
    for (const [key, value] of pending) {
      out.push(`${key}=${value}`)
      written.push(key)
    }
    out.push('')
  }

  return { text: out.join('\n'), written }
}

/** `typeof null === 'object'`, and arrays are objects too — both need explicit exclusion for a plain object check. */
export const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const NESTED = ['scripts', 'dependencies', 'devDependencies']
// `type` decides whether every .js in the project is ESM or CJS, so injecting it silently could break a
// CommonJS project outright. Only these top-level keys may be introduced, and each is reported.
const TOP_LEVEL = ['name', 'private', 'type']

/** Additive: the project's own values always win. Returns the manifest plus every key it introduced. */
export function mergePackageJson(existing, template) {
  const merged = { ...existing }
  const added = []

  for (const key of TOP_LEVEL) {
    if (!(key in template) || key in existing) continue
    merged[key] = template[key]
    added.push(key)
  }
  for (const key of NESTED) {
    if (!template[key]) continue
    merged[key] = isPlainObject(existing[key]) ? { ...template[key], ...existing[key] } : template[key]
    for (const name of Object.keys(template[key])) {
      if (!isPlainObject(existing[key]) || !(name in existing[key])) added.push(`${key}.${name}`)
    }
  }
  return { merged, added }
}

/**
 * The value a dotenv key carries, or `undefined`/`''` when it carries none.
 * Horizontal whitespace only: `\s*` would let an empty assignment match the NEXT line's value.
 */
export const envValue = (env, key) => new RegExp(`^[^\\S\\n]*${key}[^\\S\\n]*=[^\\S\\n]*(.+)$`, 'm').exec(env)?.[1].trim()

const withoutComments = (src) => src.replace(/<!--[\s\S]*?-->/g, '')
// `<nuxt-page />` is as valid as `<NuxtPage />`; matching only the Pascal spelling would flag a working app.
const kebab = (tag) => tag.replace(/(?!^)([A-Z])/g, '-$1').toLowerCase()
export const usesComponent = (src, tag) => new RegExp(`<\\s*(${tag}|${kebab(tag)})[\\s/>]`, 'i').test(src)

/**
 * `kestrel doctor`, as a pure function of what was read; `null` means the file is absent.
 * The `app.vue` rules mirror `layers/core/modules/kestrel/app-shell.ts`; a test pins the two together.
 */
export function diagnoseProject({ packageJson, nuxtConfig, appVue, env }) {
  const found = []
  const add = (level, message) => found.push({ level, message })

  let manifest
  if (packageJson !== null) {
    try {
      manifest = JSON.parse(packageJson)
    } catch {
      add('error', 'package.json is not valid JSON — nothing can read it, including pnpm.')
    }
  }

  if (packageJson === null) {
    add('error', 'no package.json — run this inside a project directory, or `kestrel init <dir>` to make one.')
  } else if (manifest !== undefined) {
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }
    if (!(PACKAGE_NAME in deps)) add('error', `${PACKAGE_NAME} is not a dependency — run \`pnpm add ${PACKAGE_NAME}\`.`)
    if (!('nuxt' in deps)) {
      add(
        'error',
        'nuxt is not a direct dependency. Kestrel depends on it, but a strict node_modules layout (pnpm) does not link a transitive package\'s `nuxt` binary, so `nuxt dev` will not resolve — run `pnpm add -D nuxt`.',
      )
    }
    if (!manifest.scripts?.dev) add('warn', 'no `dev` script — add `"dev": "nuxt dev"` so `pnpm dev` works.')
  }

  if (nuxtConfig === null) {
    add(
      'error',
      'no nuxt.config.ts. Installing the package does nothing on its own: Nuxt only loads Kestrel when the config extends it. Without this file every route, /admin included, serves the default Nuxt welcome page.',
    )
  } else if (!nuxtConfig.includes(PACKAGE_NAME)) {
    add('error', `nuxt.config.ts does not extend ${PACKAGE_NAME} — add \`extends: ['${PACKAGE_NAME}']\`.`)
  } else if (/extends\s*:\s*\[[^\]]*['"]\.\.[/\\]\.\./.test(nuxtConfig)) {
    add(
      'warn',
      "a relative `extends` path of '../..' or deeper silently drops every Kestrel sub-layer (c12 treats it as a file, not a directory, because pathe reports its extension as '.'). Use the package name.",
    )
  }

  if (appVue !== null) {
    const src = withoutComments(appVue)
    if (!usesComponent(src, 'NuxtPage')) {
      add(
        'error',
        'app/app.vue renders no <NuxtPage />, so no route renders — including /admin. It shadows the one Kestrel ships. Delete it, or wrap <NuxtPage /> in <NuxtLayout>.',
      )
    } else if (!usesComponent(src, 'NuxtLayout')) {
      add('warn', 'app/app.vue renders no <NuxtLayout />, so the admin loses its navigation shell.')
    }
  }

  if (env === null) {
    add('error', 'no .env — sign-in at /admin answers 503 until KESTREL_ADMIN_PASSWORD_HASH is set. Run `kestrel init`.')
  } else {
    const value = (key) => envValue(env, key)
    if (!value('KESTREL_ADMIN_PASSWORD_HASH')) {
      add('error', 'KESTREL_ADMIN_PASSWORD_HASH is unset — /admin renders but sign-in answers 503. Run `kestrel hash-password`.')
    }
    if (!value('KESTREL_SESSION_SECRET')) {
      add('warn', 'KESTREL_SESSION_SECRET is unset — dev falls back to a random per-process secret (sessions drop on restart) and production refuses to boot.')
    }
  }

  return found
}
