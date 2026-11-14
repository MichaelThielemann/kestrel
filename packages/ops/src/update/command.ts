import type { RunOptions } from "../run.ts";
import { notImplemented } from "./pending.ts";

/** The usage text of `kestrel update`; `deploy`, `verify` and `bundle` belong to the pipeline and are not listed. */
export const UPDATE_USAGE = `usage:
  update prepare [--full-media]
  update accept [--run <id>]
  update rollback [--run <id>]
  update status [--run <id>]
  update resume [--run <id>]
  update abort [--run <id>]
  update cleanup [--run <id>] [--dry-run]
common options: --env <name>, --json, --yes, --answers <file>, --keep, --break-lock
exit codes: 0 done, 1 a check failed, a step was refused or the run halted, 2 usage or configuration error,
  3 the update was rolled back`;

/**
 * Runs one `update` command line (`argv` without the word `update`): `prepare`, `accept`, `rollback`, `status`,
 * `resume`, `abort`, `cleanup`, and for the pipeline `deploy`, `verify` and `bundle`. It loads the environment like
 * `runOps`, requires a target that implements `UpdateTarget` (exit 2 otherwise), takes the lock for every command but
 * `status`, opens or continues the run's journal, and resolves to one of `UPDATE_EXIT`. With `--json` it prints one
 * document with a `schema` field such as `kestrel-ops/update-deploy@1`.
 */
export async function runUpdate(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  return notImplemented(`runUpdate(${argv.join(" ")}, ${Object.keys(options).length})`);
}
