import type { Target } from "../target.ts";

/** The release an update deploys: the directory a target stages, relative to the environments file. */
export interface ReleaseSource {
  /** Absolute path of the directory the target stages, from `update.release.dir`. */
  dir: string;
}

/** A droplet staged from a release while the app kept running. */
export interface StagedDroplet {
  /** The platform's id of the staged code. */
  droplet: string;
  /** The id of the uploaded package it was staged from, or null when the platform has none. */
  package: string | null;
  /** When staging ended, by this machine's clock. */
  stagedAt: number;
}

/** One staged code version of the app as the platform lists it. */
export interface DropletInfo {
  guid: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** True for the droplet the app starts from. */
  current: boolean;
}

/** One recorded deployment of the app that the platform can roll back to; it names the droplet it starts. */
export interface RevisionInfo {
  guid: string;
  version: number;
  /** Null when the platform does not say, or the droplet is gone. */
  droplet: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
}

/**
 * The answer of the app's readiness check, in three outcomes: `ready` (200), `not-ready` (503, a body with
 * `ready: false`, or another 5xx answer: the release runs and reports itself broken, which rolls back), and
 * `unverifiable` (403, 401, 404, a timeout or no connection: the check cannot tell, which halts without a rollback).
 */
export type ReadyProbe = { outcome: "ready"; status: number } | { outcome: "not-ready"; status: number } | { outcome: "unverifiable"; status: number | null; reason: string };

/** A crash or failed start the platform recorded for the app. */
export interface CrashEvent {
  /** Epoch milliseconds. */
  at: number;
  type: string;
  /** The platform's reason, such as an exit description; never raw log output. */
  reason: string | null;
}

/** One environment variable as a recorded configuration keeps it: the value of a plain one, a salted sha256 of a secret one. */
export type RecordedValue = { value: string } | { fingerprint: string };

/**
 * The app's configuration before an update changed it, written once into the backup location. Plain values are kept
 * verbatim; a secret value (a name the host lists as secret, or one the target fills from a credential source) only
 * as `sha256(salt + value)` in hex.
 */
export interface RecordedConfiguration {
  schema: "kestrel-ops/configuration@1";
  recordedAt: number;
  droplet: string | null;
  revision: { guid: string; version: number } | null;
  /** Random hex mixed into every fingerprint of this record. */
  salt: string;
  env: Record<string, RecordedValue>;
  healthCheck: { type: string; endpoint: string | null; timeoutSeconds: number | null; invocationTimeoutSeconds: number | null };
  memoryMb: number | null;
  diskMb: number | null;
  /** The start command, or null for the one the platform detects. */
  command: string | null;
  instances: number;
}

/** What restoring a recorded configuration did. */
export interface ConfigurationRestore {
  /** Plain variables set back to their recorded value. */
  set: string[];
  /** Variables the update added, removed again. */
  removed: string[];
  /** Secret variables whose current value matches the recorded fingerprint, left as they are. */
  unchanged: string[];
  /** Secret variables whose current value does not match the recorded fingerprint; their old value is unknown and was not restored. */
  unrestorable: string[];
}

/** What a target reports before an update touches it, read without refusing. */
export interface TargetPreflight {
  /** The desired instance count of the app's process; an update needs 1. */
  instances: number;
  /** Instances that are not down. */
  running: number;
  /** A deployment the platform is running, such as a rolling push, or null. */
  activeDeployment: string | null;
  /** The configured health check type, such as `http` or `process`. */
  healthCheck: string;
  /**
   * False when {@link UpdateTarget.probeReady} cannot check the release's readiness and answers `ready` for any running
   * instance, such as a target without a readiness URL; prepare and the gate of a deploy refuse it with exit 2. Absent
   * counts as checked.
   */
  readinessChecked?: boolean;
}

/**
 * A {@link Target} an update can drive: stage new code while the app runs, swap it in while it is stopped, record and
 * restore its configuration, probe its readiness and list and delete old droplets. Every method that changes the app
 * refuses unless the app is stopped, except {@link UpdateTarget.stage}, which never changes the running app.
 */
export interface UpdateTarget extends Target {
  readonly transport: "promote";
  /** Facts the gate decides on; never throws for a second instance or an active deployment, it reports them. */
  preflight(): Promise<TargetPreflight>;
  /** Uploads and stages `release` into a droplet while the app keeps running; a failure leaves the app as it was. */
  stage(release: ReleaseSource): Promise<StagedDroplet>;
  /** The droplet the app starts from, or null. */
  currentDroplet(): Promise<string | null>;
  /** Makes `droplet` current; refuses unless the app is stopped. */
  setDroplet(droplet: string): Promise<void>;
  /** Reads the app's configuration; `secretNames` and the names the target fills from credential sources are fingerprinted. */
  readConfiguration(secretNames: ReadonlySet<string>): Promise<RecordedConfiguration>;
  /** Applies the configuration the release brings (its manifest and variables); refuses unless the app is stopped. */
  applyReleaseConfiguration(release: ReleaseSource): Promise<void>;
  /** Puts a recorded configuration back verbatim, without asking; refuses unless the app is stopped. */
  restoreConfiguration(recorded: RecordedConfiguration): Promise<ConfigurationRestore>;
  /** One readiness check of the running app. */
  probeReady(): Promise<ReadyProbe>;
  /** Crashes and failed starts recorded at or after `since` (epoch milliseconds). */
  crashEvents(since: number): Promise<CrashEvent[]>;
  listDroplets(): Promise<DropletInfo[]>;
  listRevisions(): Promise<RevisionInfo[]>;
  /** Deletes a droplet that is not current; a revision that names it can no longer be rolled back to. */
  deleteDroplet(guid: string): Promise<void>;
  /** Writes the bits of `guid` to `file`; false when the platform does not hand them out, a rejection when it could but the download failed. */
  saveDroplet?(guid: string, file: string): Promise<boolean>;
  /** Uploads droplet bits saved by {@link UpdateTarget.saveDroplet} and resolves to the new droplet's id. */
  restoreDroplet?(file: string): Promise<string>;
}

const UPDATE_METHODS = ["preflight", "stage", "currentDroplet", "setDroplet", "readConfiguration", "applyReleaseConfiguration", "restoreConfiguration", "probeReady", "crashEvents", "listDroplets", "listRevisions", "deleteDroplet"] as const;

/** True for a target that implements every required method of {@link UpdateTarget}. */
export function isUpdateTarget(target: Target): target is UpdateTarget {
  return target.transport === "promote" && UPDATE_METHODS.every((name) => typeof Reflect.get(target, name) === "function");
}
