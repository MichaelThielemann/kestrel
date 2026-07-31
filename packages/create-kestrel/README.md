# create-kestrel

Scaffolds a [Kestrel](https://github.com/MichaelThielemann/kestrel) site — a collection-driven CMS that
renders published content to static HTML.

```bash
pnpm create kestrel my-site
cd my-site && pnpm install && pnpm dev
```

It asks for an admin password and writes a project that runs as-is: a `nuxt.config.ts` extending the
engine, an app shell that renders, and a `.env` holding a fresh session secret plus the scrypt hash of
your password. Sign in at <http://localhost:3000/admin>.

| Flag | |
| --- | --- |
| `--name <name>` | package name (default: the directory name, slugified) |
| `--password <pw>` | set the admin password without prompting |
| `--yes` | never prompt; leaves `KESTREL_ADMIN_PASSWORD_HASH` for you to fill in |
| `--force` | scaffold into a directory that is not empty |

To add Kestrel to an **existing** project, use the engine's own CLI instead — it merges rather than
refuses:

```bash
pnpm add @michaelthielemann/kestrel
pnpm kestrel init
```

Documentation: <https://github.com/MichaelThielemann/kestrel#documentation>
