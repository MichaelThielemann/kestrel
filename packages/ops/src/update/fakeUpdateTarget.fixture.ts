import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { FakeApp, type FakePrefixes } from "../fakeApp.fixture.ts";
import { OpsError } from "../errors.ts";
import { hex } from "../layout.ts";
import type { ObjectStore } from "../store.ts";
import type { TargetFacts, TargetStatus } from "../target.ts";
import type { ConfigurationRestore, CrashEvent, DropletInfo, ReadyProbe, RecordedConfiguration, ReleaseSource, RevisionInfo, StagedDroplet, TargetPreflight, UpdateTarget } from "./target.ts";

/** How a release of the stand-in app behaves once started. */
export interface FakeRelease {
  /** The replication runtime version; from 6 on it seals at teardown and acknowledges a promoted generation. */
  runtime: string;
  /** Versions of the packages the release brings, as a target reports them. */
  versions: Record<string, string>;
  /** What its readiness check answers: 200, 503, 403, or no connection. */
  ready: "ready" | "not-ready" | "forbidden" | "unreachable";
  /** No instance comes up; the platform records a crash. */
  crashes: boolean;
  /** Renders every page into the delivery prefix right after it started, as a release that re-renders after a restore does. */
  renders: boolean;
  /** Environment changes its configuration brings; `null` removes a variable. */
  env: Record<string, string | null>;
}

/** The configuration of the stand-in app as the platform holds it. */
export interface FakeConfiguration {
  env: Record<string, string>;
  healthCheck: RecordedConfiguration["healthCheck"];
  memoryMb: number;
  diskMb: number;
  command: string | null;
}

/** Options of {@link FakeUpdateTarget}. */
export interface FakeUpdateTargetOptions {
  store: ObjectStore;
  /** The app's ephemeral disk. */
  dir: string;
  prefixes: FakePrefixes;
  /** The release the app runs at first. */
  current: FakeRelease;
  /** Releases by directory, as `stage` finds them. */
  releases: Record<string, FakeRelease>;
  configuration?: Partial<FakeConfiguration>;
}

/** A release with every field given a default: runtime 6.0.0, ready, no crash, renders, no environment change. */
export function fakeRelease(overrides: Partial<FakeRelease> = {}): FakeRelease {
  const runtime = overrides.runtime ?? "6.0.0";
  return { runtime, versions: { "@michaelthielemann/kestrel": runtime, "@michaelthielemann/kestrel-replication-sqlite": runtime }, ready: "ready", crashes: false, renders: true, env: {}, ...overrides };
}

const fingerprint = (salt: string, value: string): string => createHash("sha256").update(salt + value).digest("hex");

/**
 * An {@link UpdateTarget} over the in-process stand-in app: each droplet is a {@link FakeRelease}, and a start runs a
 * {@link FakeApp} with the current droplet's runtime on the shared store. `actions` records every call that changes
 * the app, in order. `sealDelayMs` lets a stop report stopped before the instance's teardown synced and sealed, as a
 * platform does that signals the instance only after answering the stop.
 */
export class FakeUpdateTarget implements UpdateTarget {
  readonly transport = "promote" as const;
  readonly actions: string[] = [];
  readonly droplets = new Map<string, { release: FakeRelease; createdAt: number }>();
  readonly revisions: RevisionInfo[] = [];
  readonly crashes: CrashEvent[] = [];
  readonly configuration: FakeConfiguration;
  readonly releases: Map<string, FakeRelease>;
  current: string;
  /** The desired instance count. */
  instances: number = 1;
  activeDeployment: string | null = null;
  /** Message a staging attempt fails with, or null. */
  failStaging: string | null = null;
  /** Milliseconds between a stop reporting stopped and the instance's teardown. */
  sealDelayMs: number = 0;
  /** Whether `saveDroplet` hands out bits. */
  dropletBits: boolean = true;
  /** Names the platform fills from credential sources, fingerprinted like the host's secret names. */
  vaultNames: Set<string> = new Set<string>();
  app: FakeApp | null = null;
  #state: "started" | "stopped" = "stopped";
  #crashed = false;
  #shutdown: Promise<void> = Promise.resolve();

  constructor(readonly options: FakeUpdateTargetOptions) {
    const guid = randomUUID();
    this.droplets.set(guid, { release: options.current, createdAt: Date.now() });
    this.current = guid;
    this.releases = new Map(Object.entries(options.releases));
    this.configuration = { env: {}, healthCheck: { type: "http", endpoint: "/ready", timeoutSeconds: 180, invocationTimeoutSeconds: null }, memoryMb: 1024, diskMb: 2048, command: null, ...options.configuration };
  }

  /** The release of the current droplet. */
  get release(): FakeRelease {
    const droplet = this.droplets.get(this.current);
    if (droplet === undefined) throw new Error(`droplet ${this.current} is gone`);
    return droplet.release;
  }

  private requireStopped(step: string): void {
    if (this.#state !== "stopped") throw new OpsError(`refusing to ${step} while the app runs`, 1, "target");
  }

  async describe(): Promise<TargetFacts> {
    return { kind: "fake-update", packages: { ...this.release.versions, "@michaelthielemann/kestrel-replication-sqlite": this.release.runtime }, droplet: this.current };
  }

  async status(): Promise<TargetStatus> {
    return this.#state === "stopped" ? { state: "stopped", instances: 0 } : { state: "started", instances: this.#crashed ? 0 : this.instances };
  }

  async preflight(): Promise<TargetPreflight> {
    const running = this.#state === "started" && !this.#crashed ? this.instances : 0;
    return { instances: this.instances, running, activeDeployment: this.activeDeployment, healthCheck: this.configuration.healthCheck.type };
  }

  async stop(): Promise<{ stoppedAt: number }> {
    this.actions.push("stop");
    const app = this.app;
    this.app = null;
    this.#state = "stopped";
    this.#crashed = false;
    const stoppedAt = Date.now();
    if (app !== null) {
      const teardown = async (): Promise<void> => {
        if (this.sealDelayMs > 0) await new Promise((done) => setTimeout(done, this.sealDelayMs));
        await app.stop();
      };
      this.#shutdown = teardown();
      if (this.sealDelayMs === 0) await this.#shutdown;
    }
    return { stoppedAt };
  }

  /** Resolves once the last stop's teardown has ended. */
  idle(): Promise<void> {
    return this.#shutdown;
  }

  /** Ends the running instance without teardown, as a crash or a kill does: nothing written since its last sync reaches the replica. */
  kill(): void {
    this.app?.kill();
    this.app = null;
    this.#state = "stopped";
  }

  async start(): Promise<void> {
    if (this.#state === "started") throw new OpsError("the app is already running", 1, "target");
    this.actions.push("start");
    await this.#shutdown;
    const release = this.release;
    this.#state = "started";
    const last = this.revisions.at(-1);
    if (last?.droplet !== this.current) this.revisions.push({ guid: randomUUID(), version: (last?.version ?? 0) + 1, droplet: this.current, createdAt: Date.now() });
    if (release.crashes) {
      this.#crashed = true;
      this.crashes.push({ at: Date.now(), type: "audit.app.process.crash", reason: "APP/PROC/WEB: Exited with status 1" });
      return;
    }
    const app = new FakeApp({ store: this.options.store, dir: this.options.dir, prefixes: this.options.prefixes, runtime: release.runtime });
    await app.start();
    this.app = app;
    if (release.renders) {
      await app.export();
      await app.sync();
    }
  }

  async waitReady(): Promise<boolean> {
    return this.#state === "started" && !this.#crashed && this.release.ready === "ready";
  }

  async probeReady(): Promise<ReadyProbe> {
    if (this.#state !== "started" || this.#crashed) return { outcome: "unverifiable", status: null, reason: "no instance answers" };
    switch (this.release.ready) {
      case "ready":
        return { outcome: "ready", status: 200 };
      case "not-ready":
        return { outcome: "not-ready", status: 503 };
      case "forbidden":
        return { outcome: "unverifiable", status: 403, reason: "forbidden" };
      case "unreachable":
        return { outcome: "unverifiable", status: null, reason: "no connection" };
    }
  }

  async crashEvents(since: number): Promise<CrashEvent[]> {
    return this.crashes.filter((event) => event.at >= since);
  }

  async stopEvidence(): Promise<string[]> {
    return ["stand-in platform: no events"];
  }

  async stage(release: ReleaseSource): Promise<StagedDroplet> {
    this.actions.push("stage");
    if (this.failStaging !== null) throw new OpsError(`staging failed: ${this.failStaging}`, 1, "target");
    const found = this.releases.get(release.dir);
    if (found === undefined) throw new OpsError(`staging failed: no release in ${release.dir}`, 1, "target");
    const droplet = randomUUID();
    this.droplets.set(droplet, { release: found, createdAt: Date.now() });
    return { droplet, package: randomUUID(), stagedAt: Date.now() };
  }

  async currentDroplet(): Promise<string | null> {
    return this.droplets.has(this.current) ? this.current : null;
  }

  async setDroplet(droplet: string): Promise<void> {
    this.requireStopped("set the droplet");
    if (!this.droplets.has(droplet)) throw new OpsError(`no droplet ${droplet}`, 1, "target");
    this.actions.push(`set-droplet ${droplet}`);
    this.current = droplet;
  }

  async readConfiguration(secretNames: ReadonlySet<string>): Promise<RecordedConfiguration> {
    const salt = hex(16);
    const env: RecordedConfiguration["env"] = {};
    for (const [name, value] of Object.entries(this.configuration.env)) env[name] = secretNames.has(name) || this.vaultNames.has(name) ? { fingerprint: fingerprint(salt, value) } : { value };
    const revision = this.revisions.at(-1);
    return { schema: "kestrel-ops/configuration@1", recordedAt: Date.now(), droplet: await this.currentDroplet(), revision: revision === undefined ? null : { guid: revision.guid, version: revision.version }, salt, env, healthCheck: { ...this.configuration.healthCheck }, memoryMb: this.configuration.memoryMb, diskMb: this.configuration.diskMb, command: this.configuration.command, instances: this.instances };
  }

  async applyReleaseConfiguration(release: ReleaseSource): Promise<void> {
    this.requireStopped("apply the release's configuration");
    this.actions.push("apply-release-configuration");
    const found = this.releases.get(release.dir);
    for (const [name, value] of Object.entries(found?.env ?? {})) {
      if (value === null) delete this.configuration.env[name];
      else this.configuration.env[name] = value;
    }
  }

  async restoreConfiguration(recorded: RecordedConfiguration): Promise<ConfigurationRestore> {
    this.requireStopped("restore the configuration");
    this.actions.push("restore-configuration");
    const result: ConfigurationRestore = { set: [], removed: [], unchanged: [], unrestorable: [] };
    for (const name of Object.keys(this.configuration.env)) {
      if (recorded.env[name] !== undefined) continue;
      delete this.configuration.env[name];
      result.removed.push(name);
    }
    for (const [name, value] of Object.entries(recorded.env)) {
      if ("value" in value) {
        this.configuration.env[name] = value.value;
        result.set.push(name);
      } else {
        const now = this.configuration.env[name];
        (now !== undefined && fingerprint(recorded.salt, now) === value.fingerprint ? result.unchanged : result.unrestorable).push(name);
      }
    }
    Object.assign(this.configuration, { healthCheck: { ...recorded.healthCheck }, command: recorded.command, ...(recorded.memoryMb === null ? {} : { memoryMb: recorded.memoryMb }), ...(recorded.diskMb === null ? {} : { diskMb: recorded.diskMb }) });
    return result;
  }

  async listDroplets(): Promise<DropletInfo[]> {
    return [...this.droplets].map(([guid, d]) => ({ guid, createdAt: d.createdAt, current: guid === this.current })).sort((a, b) => a.createdAt - b.createdAt);
  }

  async listRevisions(): Promise<RevisionInfo[]> {
    return this.revisions.map((revision) => ({ ...revision, droplet: revision.droplet !== null && this.droplets.has(revision.droplet) ? revision.droplet : null }));
  }

  async deleteDroplet(guid: string): Promise<void> {
    if (guid === this.current) throw new OpsError(`refusing to delete the current droplet ${guid}`, 1, "target");
    this.actions.push(`delete-droplet ${guid}`);
    this.droplets.delete(guid);
  }

  async saveDroplet(guid: string, file: string): Promise<boolean> {
    const droplet = this.droplets.get(guid);
    if (!this.dropletBits || droplet === undefined) return false;
    writeFileSync(file, JSON.stringify(droplet.release), { mode: 0o600 });
    return true;
  }

  async restoreDroplet(file: string): Promise<string> {
    const release = boundaryCast<FakeRelease>(JSON.parse(readFileSync(file, "utf8")), "json");
    const guid = randomUUID();
    this.droplets.set(guid, { release, createdAt: Date.now() });
    this.actions.push(`restore-droplet ${guid}`);
    return guid;
  }
}
