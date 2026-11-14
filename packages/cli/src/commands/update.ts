import { runOpsCommand } from "../ops.ts";

/** `kestrel update`: the update assistant of the installed kestrel-ops; exit 2 when it has none. */
export async function run(argv: readonly string[]): Promise<number> {
  return runOpsCommand("update", argv);
}
