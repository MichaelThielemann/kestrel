# Contributing

Bug reports and pull requests are welcome. For anything larger than a fix, open an issue first so the
direction can be agreed before you invest time.

## Setup

Node 22.18 or newer and pnpm.

```
pnpm install
pnpm build
pnpm test
```

`pnpm start` runs the example in `examples/minimal`.

## Before opening a pull request

```
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
```

`pnpm docs:check` fails when the generated parts of the READMEs are out of date; `pnpm docs:generate`
rewrites them. Add an entry under `## Unreleased` in `CHANGELOG.md` when the change is visible to someone
using the packages.

## Design rules

The five rules in the README's Conventions section decide most review questions; the reasoning behind
each is in [`docs/architecture.md`](docs/architecture.md). Three consequences come up most often:

- A published contract in `packages/contracts/src` does not change. A capability that needs a different
  shape becomes a new major of that contract next to the old one, so existing implementations keep
  working.
- A submodule keeps no module-level state. Everything it needs comes in through `setup(config, deps)`,
  which is what lets two instances with different configuration run in one process and in tests.
- A new submodule follows [`docs/submodule-template.md`](docs/submodule-template.md) and runs the contract
  test suite of the contract it provides.

## Style

English in code, docs and the changelog. The code should explain itself through names and types; write a
comment only where a constraint cannot be seen from the code, and put longer explanations into `docs/`,
where they are found by people who never open the source file. Exported API carries TSDoc.

## Releases

Only the maintainer publishes; the procedure is in [`RELEASING.md`](RELEASING.md). A breaking change
means a new major version.
