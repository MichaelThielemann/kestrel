# Releasing

All packages share one version and are published together from the workspace.

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
2. `./scripts/smoke-consumer.sh` – installs the packed tarballs into a throwaway project outside the
   workspace and boots it. This is the only check that sees the published shape (`publishConfig`,
   `files`, peer dependencies). The install runs without install scripts and resolves third-party
   dependencies as the registry stood three days earlier (`SMOKE_BEFORE=<ISO date>` moves that point),
   so a version published minutes ago never runs on the machine that later tags the release.
3. Bump the version in every `packages/*/package.json` (same number everywhere) and
   `packages/core/src/version.ts` (the workspace test fails when they differ), add an entry to
   `CHANGELOG.md` and run `pnpm docs:generate` (the committed manifest carries the versions).
4. Commit, tag `v<version>`, push the commit and the tag.
5. The `release` workflow runs on the tag in two jobs:
   - `build` (read-only token, no id token) checks out without keeping the token, installs, verifies
     that the tag matches the workspace version, repeats lint, typecheck, tests, docs check and build,
     and packs every package with `node scripts/release.mjs plan`. The plan refuses a tag unless every
     publishable package carries its version. The tarballs, `release.json` (name, version, file,
     integrity) and `SHA512SUMS` go up as the `release-artifacts` artifact. No dependency cache is
     restored anywhere in the release.
   - `publish` needs `build` and runs in the GitHub environment `release`, the only place with
     `id-token: write`. It installs nothing: it downloads the artifact, checks every tarball against
     its checksums and the tag, and `node scripts/release.mjs publish` runs `pnpm publish <tarball>
     --provenance` for each one. A version that is already on the registry with different content
     stops the job; one whose registry integrity equals the artifact's is left alone, so re-running a
     failed `publish` job finishes the release.

   Trusted publishing (OIDC, no token): every package needs a trusted publisher on npmjs.com for this
   repository, the workflow file `release.yml` and the environment `release`. The environment has
   required reviewers and admits only `v*` tags, so a release waits for approval before anything is
   published. A package that does not exist on npm yet cannot have a trusted publisher, so its first
   version is published from the terminal (`pnpm build`, then
   `pnpm --filter <name> publish --access public`) and the trusted publisher is added afterwards.
   A local dry run of the whole set is `node scripts/release.mjs plan --tag v<version> --dir /tmp/release`
   followed by `node scripts/release.mjs publish --tag v<version> --dir /tmp/release --dry-run`.

`workspace:*` ranges are rewritten to the real version by pnpm on pack; `publishConfig` switches
`exports` and `bin` from the TypeScript sources to `dist/`. pnpm itself is pinned, with its hash, by
`packageManager` in `package.json`; the workflows take it from there.
