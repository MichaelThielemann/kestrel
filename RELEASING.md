# Releasing

All packages share one version and are published together from the workspace.

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
2. `./scripts/smoke-consumer.sh "<scrypt hash for password smoke>"` – installs the packed
   tarballs into a throwaway project outside the workspace and boots it. This is the only check
   that sees the published shape (`publishConfig`, `files`, peer dependencies).
3. Bump the version in every `packages/*/package.json` (same number everywhere) and add an entry
   to `CHANGELOG.md`.
4. Commit, tag `v<version>`.
5. `pnpm -r --filter './packages/*' publish --access public` (dry run first: add `--dry-run`).

`workspace:*` ranges are rewritten to the real version by pnpm on pack/publish; `publishConfig`
switches `exports` and `bin` from the TypeScript sources to `dist/`.
