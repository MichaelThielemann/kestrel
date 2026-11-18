import type { z } from "zod";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError, type TargetDeps, type TargetStatus } from "@michaelthielemann/kestrel-ops";
import type { CfRunner } from "./cf.ts";
import type { CloudFoundryConfig } from "./config.ts";

/** A `cf curl` call that failed, exited with an error or answered an unexpected document; `titles` holds the API's error titles. */
export class CfApiError extends OpsError {
  constructor(
    message: string,
    readonly titles: readonly string[] = [],
  ) {
    super(message, 1, "target");
  }
}

/**
 * `at`, in milliseconds since the epoch, as the value of a Cloud Foundry v3 timestamp filter such as
 * `created_ats[gte]`. The Cloud Controller accepts only `YYYY-MM-DDThh:mm:ssZ` there, so the time is rounded down to
 * its whole second: a `[gte]` filter still includes `at`, and the caller narrows the answer to the exact time.
 */
export function cfTimestamp(at: number): string {
  return `${new Date(Math.floor(at / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * What the steps of the target share for one app: the cf runner, the v3 API through `cf curl` with a schema for each
 * answer, the app's guid (resolved once and checked against `cf target`), and the reads every step starts from.
 */
export interface CfSession {
  readonly app: string;
  readonly config: CloudFoundryConfig;
  readonly deps: TargetDeps;
  /** The environment cf runs in and `{ env }` variables are read from. */
  readonly env: NodeJS.ProcessEnv;
  /** Pause between two reads while waiting, in milliseconds. */
  readonly pollMs: number;
  readonly run: CfRunner;
  /** Calls the v3 API at `path`; `data` goes on cf's command line, so it never holds a value of a variable. */
  api<T>(path: string, schema: z.ZodType<T>, method?: string, data?: string): Promise<T>;
  appGuid(): Promise<string>;
  /** Refuses with exit 2 when cf targets another org or space, or the app's guid differs from the one resolved first. */
  confirmTarget(): Promise<void>;
  /** Refuses with exit 1 unless the app is stopped with no instance; `step` names what was refused. */
  requireStopped(step: string): Promise<void>;
  status(): Promise<TargetStatus>;
}
