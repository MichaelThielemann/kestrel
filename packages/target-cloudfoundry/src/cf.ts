import { execFile } from "node:child_process";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";

/** The exit code and standard output of one cf call. Its standard error is dropped, so no raw cf output reaches a message. */
export interface CfResult {
  code: number;
  stdout: string;
}

/** Runs `cf` with `args`, without a shell. */
export type CfRunner = (args: readonly string[], options?: { timeoutMs?: number }) => Promise<CfResult>;

const MAX_OUTPUT = 32 * 1024 * 1024;

/** A cf call that did not finish: it ran out of time or ended by a signal. */
export class CfUnfinished extends OpsError {
  constructor(message: string) {
    super(message, 1, "target");
  }
}

/** The runner of the `cf` found on `PATH` in `env`, with colored and trace output switched off. */
export function cfRunner(env: NodeJS.ProcessEnv): CfRunner {
  return (args, options = {}) => {
    const timeoutMs = options.timeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      execFile("cf", [...args], { env: { ...env, CF_COLOR: "false", CF_TRACE: "false" }, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: "utf8" }, (error, stdout) => {
        if (error === null) resolve({ code: 0, stdout });
        else if (error.code === "ENOENT") reject(new OpsError("the cf CLI is not on PATH; install it and log in with cf login", 2, "target"));
        else if (error.killed === true) reject(new CfUnfinished(`cf ${args[0] ?? ""} did not finish within ${Math.round(timeoutMs / 1000)} s`));
        else if (typeof error.code === "number") resolve({ code: error.code, stdout });
        else if (error.signal) reject(new CfUnfinished(`cf ${args[0] ?? ""} ended by ${error.signal}`));
        else reject(new OpsError(`cf ${args[0] ?? ""} could not run: ${String(error.code ?? "unknown error")}`, 1, "target"));
      });
    });
  };
}
