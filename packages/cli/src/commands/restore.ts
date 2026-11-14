import { runOpsCommand } from "../ops.ts";

/** `kestrel restore`: restores a backup over an environment or into a local directory, through kestrel-ops. */
export async function run(argv: readonly string[]): Promise<number> {
  return runOpsCommand("restore", argv);
}
