#!/usr/bin/env bash
# Publishes the package in the current directory unless that exact version is already on the registry.
set -euo pipefail

name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"

if npm view "$name@$version" version >/dev/null 2>&1; then
  echo "::notice::$name@$version is already on the registry — skipping"
  exit 0
fi

# `pnpm publish`, not `npm publish`: several packages (the engine root, and every @kestrel/* package) carry
# a real `workspace:*` dependency on another workspace package — only pnpm's own publish/pack rewrites that
# to the real resolved version before upload (confirmed via `pnpm pack`: `"@kestrel/core": "workspace:*"`
# becomes `"@kestrel/core": "0.1.0"` in the packed manifest). `npm publish` does not understand the
# protocol at all and would ship the literal, unresolvable string "workspace:*" to the registry.
# `--no-git-checks`: the tag checkout leaves HEAD detached, which pnpm's default git-state guard refuses.
pnpm publish --no-git-checks
