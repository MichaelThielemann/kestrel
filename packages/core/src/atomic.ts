import type { KestrelError } from "./errors.ts";

export interface AtomicScopeInfo {
  /** The pipeline whose group is being run. For logging only. */
  pipeline: string;
  /** The 1-based ordinal of the group inside that pipeline. For logging only. */
  group: number;
}

/** What the runner tells the scope when the group's steps are done: commit, or roll back. */
export type AtomicVerdict = "commit" | "rollback";

/** For `phase: "rollback"`, `original` carries the error that made the rollback necessary. */
export type AtomicOutcome =
  | { kind: "settled"; verdict: AtomicVerdict }
  | { kind: "failed"; phase: "begin" | "commit" | "rollback" | "timeout"; error: KestrelError; original?: KestrelError };

/**
 * Runs `body` inside one all-or-nothing scope of the provider's store.
 *
 * The provider begins the scope, awaits `body`, and then commits or rolls back according to the value
 * `body` resolves with. It never swallows a rejection of `body`: it rolls back and re-throws. It returns
 * `failed` only for a failure of its own — beginning, committing, rolling back or its own timeout — never
 * for a failure the body reported. How long a scope may take is the provider's own configuration.
 */
export type AtomicScope = (info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>) => Promise<AtomicOutcome>;
