# Releasing

All packages share one version and are published together from the workspace.

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
2. `./scripts/smoke-consumer.sh "<scrypt hash for password smoke>"` – installs the packed
   tarballs into a throwaway project outside the workspace and boots it. This is the only check
   that sees the published shape (`publishConfig`, `files`, peer dependencies).
3. Bump the version in every `packages/*/package.json` (same number everywhere) and
   `packages/core/src/version.ts` (the workspace test fails when they differ), add an entry to
   `CHANGELOG.md` and run `pnpm docs:generate` (the committed manifest carries the versions).
4. Commit, tag `v<version>`, push the commit and the tag.
5. The `release` workflow runs on the tag: it verifies the tag matches the workspace version,
   repeats lint, typecheck, tests, docs check and build, then publishes every package that is not
   on the registry yet. It authenticates with npm trusted publishing (OIDC, no token): every package
   needs a trusted publisher on npmjs.com pointing at this repository and the workflow file
   `release.yml`. A package that does not exist on npm yet cannot have one, so its first version
   is published from the terminal (`pnpm build`, then
   `pnpm --filter <name> publish --access public`) and the trusted publisher is added afterwards.
   A local dry run of the whole set is `pnpm -r --filter './packages/*' publish --access public --dry-run`.

`workspace:*` ranges are rewritten to the real version by pnpm on pack/publish; `publishConfig`
switches `exports` and `bin` from the TypeScript sources to `dist/`.
