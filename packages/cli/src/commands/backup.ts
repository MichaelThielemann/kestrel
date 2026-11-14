import { runOpsCommand } from "../ops.ts";

/** `kestrel backup create|list|verify|prune`: verified backups of an environment, through kestrel-ops. */
export async function run(argv: readonly string[]): Promise<number> {
  return runOpsCommand("backup", argv);
}
