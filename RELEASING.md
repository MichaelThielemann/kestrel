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
     --provenance` for each one. The registry is asked about every package first: a version that
     is already on the registry with different content stops the job before anything is published;
     one whose registry integrity equals the artifact's is left alone, so re-running a failed
     `publish` job finishes the release.

   Trusted publishing (OIDC, no token): every package needs a trusted publisher on npmjs.com for this
   repository, the workflow file `release.yml` and the environment `release`. The environment has
   required reviewers and admits only `v*` tags, so a release waits for approval before anything is
   published. A package that does not exist on npm yet cannot have a trusted publisher, and the
   release refuses a version that is already on npm with other content, so a new package is never
   published at its release version from a terminal. Before the tag, publish a `0.0.0` placeholder of
   it by hand and trust the workflow, then let the tag publish the real version with provenance:

   ```
   mkdir -p /tmp/placeholder && cd /tmp/placeholder
   printf '%s\n' '{"name":"<name>","version":"0.0.0","description":"Placeholder; the first release is <version>"}' > package.json
   printf '%s\n' 'Placeholder; the first release is <version>.' > README.md
   npm publish --access public
   npm trust github <name> --repo MichaelThielemann/kestrel --file release.yml --env release --allow-publish --yes
   ```

   The checksums in the artifact protect the hand-over from `build` to `publish`, not the build
   itself: what `build` packs is what gets published, so the approval of the `release` environment is
   the point to look at the run before anything reaches npm.
   A local dry run of the whole set is `node scripts/release.mjs plan --tag v<version> --dir /tmp/release`
   followed by `node scripts/release.mjs publish --tag v<version> --dir /tmp/release --dry-run`.

`workspace:*` ranges are rewritten to the real version by pnpm on pack; `publishConfig` switches
`exports` and `bin` from the TypeScript sources to `dist/`. pnpm itself is pinned, with its hash, by
`packageManager` in `package.json`; the workflows take it from there.
