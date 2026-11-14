/**
 * A failure the tool reports to the operator and ends the command with: exit code 1 when a check failed or the tool
 * refused a step, 2 for a usage or configuration error. `element` names the backup part, key or step concerned.
 */
export class OpsError extends Error {
  override readonly name = "OpsError";

  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
    readonly element?: string,
  ) {
    super(message);
  }
}
