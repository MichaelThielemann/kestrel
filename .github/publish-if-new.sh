#!/usr/bin/env bash
# Publishes the package in the current directory unless that exact version is already on the registry.
set -euo pipefail

name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"

if npm view "$name@$version" version >/dev/null 2>&1; then
  echo "::notice::$name@$version is already on the registry — skipping"
  exit 0
fi

npm publish
