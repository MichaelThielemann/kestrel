import { runOpsCommand } from "../ops.ts";

/** `kestrel status`: the state of an environment (app, replica, backups, locks), through kestrel-ops. */
export async function run(argv: readonly string[]): Promise<number> {
  return runOpsCommand("status", argv);
}
