import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
// eslint-disable-next-line no-restricted-imports -- the run drives the Cloud Foundry target against the stub cf that target ships for its own tests
import { cloudFoundryTarget } from "../../../target-cloudfoundry/src/target.ts";
// eslint-disable-next-line no-restricted-imports -- the stub cf of the Cloud Foundry target's tests
import { FakeCloudFoundry, type FakeCfApp } from "../../../target-cloudfoundry/src/fakeCloudFoundry.fixture.ts";
// eslint-disable-next-line no-restricted-imports -- droplets, revisions and the web process of the stub platform
import { FakeDroplets } from "../../../target-cloudfoundry/src/fakeDroplets.fixture.ts";
// eslint-disable-next-line no-restricted-imports -- packages, staging and crash events of the stub platform
import { installStaging, type FakeStaging } from "../../../target-cloudfoundry/src/fakeStaging.fixture.ts";
import { projectFacts } from "../bundle.ts";
import { FakeApp } from "../fakeApp.fixture.ts";
import { fromJsonl, keys, parseJsonOrNull, type BlobEntry, type SiteEntry } from "../layout.ts";
import { listGenerations, markerKey } from "../replica.ts";
import { sha256 } from "../sqlite.ts";
import type { ObjectInfo, ObjectStore } from "../store.ts";
import { runOps } from "../run.ts";
import { allRows, FIXTURE } from "../upgradeFixture.fixture.ts";
import { runUpdate } from "./command.ts";
import { readUpdateRun } from "./journal.ts";
import type { HostFacts, UpdateRun, UpdateSteps } from "./types.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The backup location of the scenario's environment. */
export const RUN_LOCATION = "kestrel-backups/";

/** The prefixes of the scenario's app, those of the 5.8.1 fixture. */
export const RUN_PREFIXES = { replica: "replica/", media: "media/", delivery: "site/", derived: "media-variants/" };

const APP = { name: "site-api", guid: "6f0c2a8e-1b7d-4c3e-9a51-0d2e8f4b7a10" };
const MODULES = { "kestrel-media-default": "media-default", "kestrel-images-default": "images-default", "kestrel-persistence-sqlite": "persistence-sqlite", "kestrel-sanitize-svg": "sanitize-svg" };

/** How a release of the stand-in app behaves on the stub platform. */
export interface StandInRelease {
  version: string;
  /** The replication runtime: from 6 on it seals at teardown and acknowledges a promoted generation. */
  runtime: string;
  /** What the readiness URL answers while it runs: 200, 503 or 403. */
  ready: "ready" | "not-ready" | "forbidden";
  /** No instance comes up and the platform records a crash. */
  crashes: boolean;
  /** Renders every page into the delivery prefix after its start. */
  renders: boolean;
  /** The storage-migration packages of the workspace the release brings through a preset dependency, in the layout pnpm installs them. */
  modules: boolean;
  /** With `modules`, whether the release brings the SVG sanitizer as well. */
  svgSanitizer: boolean;
}

/** An app instance other than the stand-in app, such as one on the published packages of an older release. */
export interface ReleaseInstance {
  /** The database file on the instance's disk. */
  readonly file: string;
  start(): Promise<void>;
  stop(): Promise<unknown>;
}

/** Options of {@link CloudFoundryRun.create}. */
export interface CloudFoundryRunOptions {
  /** Load the 5.8.1 fixture into the bucket instead of seeding content through the app. */
  fixture?: boolean;
  /** Runs `release` on an instance of its own instead of the stand-in app; null keeps the stand-in app. */
  instance?: (release: StandInRelease) => ReleaseInstance | null;
}

/** One command of the scenario as it ended. */
export interface CommandRun {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

/** What one command of the scenario varies. */
export interface CommandOptions {
  /** The release `update.release.dir` names; default the scenario's newest. */
  release?: string;
  answers?: Record<string, string>;
  steps?: Partial<UpdateSteps>;
  /** Wraps the store the command reaches the bucket through, to inject failures. */
  store?: (store: ObjectStore) => ObjectStore;
  host?: HostFacts;
  /** Extra entries of the environment's `update` block. */
  update?: Record<string, unknown>;
  /** Extra entries of the environment's `target` block, such as a `manifest` and its `vars`. */
  target?: Record<string, unknown>;
  /** Credentials of the tool, read from environment variables of the command, so its redactor knows them. */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** False runs the command without `--json`, so stdout holds the lines an operator reads. */
  json?: boolean;
  /** False runs the command without `--yes`. */
  yes?: boolean;
  /** False runs the command without `--answers`, so {@link CommandOptions.answers} is ignored. */
  answersFile?: boolean;
}

/** A store that throws on every call once {@link KilledStore.kill} ran, as the store looks from a process that was killed. */
export interface KilledStore {
  store: ObjectStore;
  kill(): void;
  readonly killed: boolean;
}

/**
 * Wraps `store` so that the first `put` for which `after` holds goes through and then ends every later call with an
 * error, as if the process was killed right after that write.
 */
export function killAfterPut(store: ObjectStore, after: (key: string) => boolean): KilledStore {
  let killed = false;
  const dead = (): never => {
    throw new Error("the process was killed");
  };
  const guard = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => (killed ? dead() : call(...args));
  return {
    store: {
      id: store.id,
      list: guard((prefix: string) => store.list(prefix)),
      head: guard((key: string) => store.head(key)),
      get: guard((key: string) => store.get(key)),
      read: guard((key: string, options?: { ifMatch?: string }) => store.read(key, options)),
      put: guard(async (key: string, data: Uint8Array, options?: { contentType?: string }) => {
        await store.put(key, data, options);
        if (after(key)) killed = true;
      }),
      copy: guard((from: string, to: string, options?: Parameters<ObjectStore["copy"]>[2]) => store.copy(from, to, options)),
      delete: guard((key: string) => store.delete(key)),
      locate: (key) => store.locate(key),
    },
    kill: () => {
      killed = true;
    },
    get killed() {
      return killed;
    },
  };
}

/** Wraps `store` so that the first `put` for which `matches` holds fails as a dropped connection does, and every other call goes through. */
export function dropOnePut(store: ObjectStore, matches: (key: string) => boolean): ObjectStore {
  let left = 1;
  return {
    ...store,
    put: async (key, data, options) => {
      if (matches(key) && left-- > 0) throw new Error("socket hang up");
      return store.put(key, data, options);
    },
  };
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
}

const fullRelease = (overrides: Partial<StandInRelease> & { version: string }): StandInRelease => ({ runtime: overrides.version, ready: "ready", crashes: false, renders: true, modules: false, svgSanitizer: true, ...overrides });

const modulesOf = (release: StandInRelease): Array<[string, string]> => (release.modules ? Object.entries(MODULES).filter(([name]) => release.svgSanitizer || name !== "kestrel-sanitize-svg") : []);

const versionsOf = (release: StandInRelease, dir: string): Record<string, string> => ({
  ...projectFacts(dir).versions,
  "@michaelthielemann/kestrel": release.version,
  "@michaelthielemann/kestrel-replication-sqlite": release.runtime,
});

/**
 * One app on a stub Cloud Foundry platform whose bucket is `store`: every droplet is a {@link StandInRelease}, a
 * start runs the stand-in app of the current droplet's release on the bucket, and each `update` command runs in
 * process through the Cloud Foundry target, the stub `cf` and the store, as a separate process would. `starts`
 * lists every start with the newest replica generation's origin, and `violations` every start of a release before
 * 6 while an update's promoted generation was the newest.
 */
export class CloudFoundryRun {
  readonly root = mkdtempSync(join(tmpdir(), "kestrel-ops-cf-run-"));
  readonly cf = new FakeCloudFoundry();
  readonly releases = new Map<string, StandInRelease>();
  readonly starts: Array<{ version: string; origin: string | null }> = [];
  readonly violations: string[] = [];
  staging: FakeStaging;
  droplets: FakeDroplets;
  api: FakeCfApp;
  app: FakeApp | null = null;
  /** The running instance a {@link CloudFoundryRunOptions.instance} factory started, or null. */
  instance: ReleaseInstance | null = null;
  private newest = "";
  private instanceOf: CloudFoundryRunOptions["instance"];
  private server: Server | null = null;
  private readyUrl = "";

  private constructor(readonly store: ObjectStore) {
    this.droplets = new FakeDroplets(this.cf);
    this.staging = installStaging(this.cf);
    this.api = this.cf.addApp({ ...APP, env: { NODE_ENV: "production", SITE_NAME: "Example" } });
  }

  /** Starts the stub platform with the app running `from`; `fixture` loads the 5.8.1 fixture into the bucket first, otherwise the app seeds its own content. */
  static async create(store: ObjectStore, from: Partial<StandInRelease> & { version: string }, options: CloudFoundryRunOptions = {}): Promise<CloudFoundryRun> {
    const run = new CloudFoundryRun(store);
    run.instanceOf = options.instance;
    await run.cf.listen();
    run.server = createServer((_request, response) => {
      const release = run.current();
      response.statusCode = run.app === null && run.instance === null ? 503 : release.ready === "ready" ? 200 : release.ready === "not-ready" ? 503 : 403;
      response.end(release.ready === "not-ready" ? JSON.stringify({ ready: false }) : "");
    });
    await new Promise<void>((done) => run.server?.listen(0, "127.0.0.1", done));
    const address = run.server.address();
    run.readyUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/ready`;
    run.wireStaging();
    run.cf.hooks = { start: () => run.startApp(), stop: () => run.stopApp() };
    const release = run.addRelease(from);
    run.droplets.addDroplet(run.api, { current: true, bits: `release ${release.version}` });
    mkdirSync(join(run.root, "target"), { recursive: true });
    if (options.fixture === true) {
      const blobs = join(FIXTURE, "blobs");
      for (const file of files(blobs)) {
        const key = relative(blobs, file).split("\\").join("/");
        if (!key.startsWith("backups/")) await store.put(key, new Uint8Array(readFileSync(file)));
      }
    }
    await run.startApp();
    if (options.fixture !== true) await run.app?.seed();
    return run;
  }

  /** Adds a release with its own directory, which a deploy stages; the newest one added is the default. */
  addRelease(overrides: Partial<StandInRelease> & { version: string }): StandInRelease {
    const release = fullRelease(overrides);
    const dir = join(this.root, "releases", release.version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "server.mjs"), "export {};\n");
    if (release.modules) {
      const store = join(dir, "node_modules", ".pnpm", "example-preset@1.0.0", "node_modules");
      const preset = join(store, "example-preset");
      mkdirSync(join(store, "@michaelthielemann"), { recursive: true });
      mkdirSync(preset, { recursive: true });
      for (const [name, pkg] of modulesOf(release)) symlinkSync(join(REPO, "packages", pkg), join(store, "@michaelthielemann", name), "dir");
      writeFileSync(join(preset, "package.json"), JSON.stringify({ name: "example-preset", version: "1.0.0", type: "module", dependencies: Object.fromEntries(modulesOf(release).map(([name]) => [`@michaelthielemann/${name}`, "*"])) }));
      symlinkSync(preset, join(dir, "node_modules", "example-preset"), "dir");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "example-site", private: true, dependencies: { "example-preset": "1.0.0" } }));
    }
    this.releases.set(`release ${release.version}`, release);
    this.newest = release.version;
    return release;
  }

  /** The release of the app's current droplet. */
  current(): StandInRelease {
    const bits = this.droplets.droplets.get(this.api.droplet ?? "")?.bits ?? "";
    const release = this.releases.get(bits);
    if (release === undefined) throw new Error(`droplet ${this.api.droplet ?? "(none)"} holds no known release`);
    return release;
  }

  private wireStaging(): void {
    const stage = this.cf.commands.get("stage-package");
    if (stage === undefined) throw new Error("the stub platform cannot stage");
    this.cf.commands.set("stage-package", async (args) => {
      const answer = await stage(args);
      const droplet = /droplet guid:\s*(\S+)/.exec(answer.stdout)?.[1];
      const pkg = this.staging.packages.find((p) => p.guid === args[args.indexOf("--package-guid") + 1]);
      const release = [...this.releases.values()].find((r) => join(this.root, "releases", r.version) === pkg?.dir);
      if (answer.code === 0 && droplet !== undefined && release !== undefined) this.droplets.addDroplet(this.api, { guid: droplet, bits: `release ${release.version}` });
      return answer;
    });
  }

  private async newestOrigin(): Promise<string | null> {
    const newest = (await listGenerations(this.store, RUN_PREFIXES.replica)).at(-1);
    if (newest === undefined) return null;
    const data = await this.store.get(markerKey(RUN_PREFIXES.replica, newest.name, "origin"));
    const kind: unknown = data === null ? null : Reflect.get(Object(parseJsonOrNull(data)), "kind");
    return typeof kind === "string" ? kind : null;
  }

  private async startApp(): Promise<void> {
    const release = this.current();
    const origin = await this.newestOrigin();
    this.starts.push({ version: release.version, origin });
    if (Number(release.runtime.split(".")[0]) < 6 && origin === "upgrade") this.violations.push(`release ${release.version} started on a promoted generation`);
    if (release.crashes) {
      this.staging.crashes.push({ app: APP.name, type: "audit.app.process.crash", created_at: new Date().toISOString(), data: { exit_description: "APP/PROC/WEB: Exited with status 1" } });
      setTimeout(() => Object.assign(this.api, { running: 0, ready: 0 }), 0);
      return;
    }
    const own = this.instanceOf?.(release) ?? null;
    if (own !== null) {
      await own.start();
      this.instance = own;
      return;
    }
    const app = new FakeApp({ store: this.store, dir: join(this.root, "disk"), prefixes: RUN_PREFIXES, runtime: release.runtime });
    await app.start();
    this.app = app;
    if (release.renders) {
      await app.export();
      await app.sync();
    }
  }

  private async stopApp(): Promise<void> {
    const app = this.app;
    const instance = this.instance;
    this.app = null;
    this.instance = null;
    await app?.stop();
    await instance?.stop();
  }

  private environments(release: string, update: Record<string, unknown>, target: Record<string, unknown>, credentials: boolean): void {
    const environment = {
      production: true,
      target: { adapter: "@michaelthielemann/kestrel-target-cloudfoundry", app: APP.name, org: "example-org", space: "dev", dir: "target", readyUrl: this.readyUrl, stopGraceSeconds: 0, ...target },
      storage: { bucket: "kestrel-test", ...(credentials ? { credentials: { accessKeyId: { env: "RUN_ACCESS_KEY" }, secretAccessKey: { env: "RUN_SECRET_KEY" } } } : {}) },
      app: { replicaPrefix: RUN_PREFIXES.replica, mediaPrefix: RUN_PREFIXES.media, deliveryPrefix: RUN_PREFIXES.delivery, derivedPrefixes: [RUN_PREFIXES.derived] },
      backups: { prefix: RUN_LOCATION },
      update: { release: { dir: `releases/${release}` }, sealTimeoutSeconds: 2, syncWindowSeconds: 3, renderTimeoutSeconds: 3, readyTimeoutSeconds: 4, ...update },
    };
    writeFileSync(join(this.root, "kestrel.environments.json"), JSON.stringify({ environments: { prod: environment } }, null, 2));
  }

  /** Runs `kestrel update <args> --env prod --json --yes --answers <file>` (each left out when its {@link CommandOptions} entry is false) in process, as a new process on the operator's or the pipeline's machine would. */
  async update(args: string[], options: CommandOptions = {}): Promise<CommandRun> {
    const version = options.release ?? this.newest;
    const release = this.releases.get(`release ${version}`);
    if (release === undefined) throw new Error(`no release ${version}`);
    this.environments(version, options.update ?? {}, options.target ?? {}, options.credentials !== undefined);
    const answers = join(this.root, `answers-${String(Date.now())}-${String(Math.random()).slice(2, 8)}.json`);
    writeFileSync(answers, JSON.stringify({ "unsealed-stop": "accept", ...options.answers }));
    const store = options.store?.(this.store) ?? this.store;
    let stdout = "";
    let stderr = "";
    const code = await runUpdate([...args, "--env", "prod", ...(options.json === false ? [] : ["--json"]), ...(options.yes === false ? [] : ["--yes"]), ...(options.answersFile === false ? [] : ["--answers", answers])], {
      cwd: this.root,
      env: options.credentials === undefined ? {} : { RUN_ACCESS_KEY: options.credentials.accessKeyId, RUN_SECRET_KEY: options.credentials.secretAccessKey },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      targets: { "@michaelthielemann/kestrel-target-cloudfoundry": (config, deps) => cloudFoundryTarget(config, deps, { env: this.cf.env({ PATH: process.env.PATH ?? "" }), pollMs: 20, stopTimeoutMs: 30_000, readTimeoutMs: 5000, callTimeoutMs: 30_000 }) },
      stores: () => store,
      stateRoot: join(this.root, "state"),
      poll: { delayMs: 20, attempts: 150 },
      readyTimeoutMs: 10_000,
      generationWaitMs: 1000,
      project: { versions: versionsOf(release, join(this.root, "releases", release.version)), lockfileSha256: null },
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.steps === undefined ? {} : { updateSteps: options.steps }),
    });
    const start = stdout.lastIndexOf('{\n  "schema"');
    const json = start < 0 ? {} : boundaryCast<Record<string, unknown>>(JSON.parse(stdout.slice(start)), "json");
    return { code, stdout, stderr, json };
  }

  /** Runs `kestrel <args> --env prod`, a command of backups and restores such as `backup prune`, in process like {@link CloudFoundryRun.update}; `clock` replaces the tool's clock. */
  async ops(args: string[], options: Pick<CommandOptions, "store" | "credentials"> & { clock?: () => number } = {}): Promise<CommandRun> {
    this.environments(this.newest, {}, {}, options.credentials !== undefined);
    const store = options.store?.(this.store) ?? this.store;
    let stdout = "";
    let stderr = "";
    const code = await runOps([...args, "--env", "prod"], {
      cwd: this.root,
      env: options.credentials === undefined ? {} : { RUN_ACCESS_KEY: options.credentials.accessKeyId, RUN_SECRET_KEY: options.credentials.secretAccessKey },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      targets: { "@michaelthielemann/kestrel-target-cloudfoundry": (config, deps) => cloudFoundryTarget(config, deps, { env: this.cf.env({ PATH: process.env.PATH ?? "" }), pollMs: 20, stopTimeoutMs: 30_000, readTimeoutMs: 5000, callTimeoutMs: 30_000 }) },
      stores: () => store,
      stateRoot: join(this.root, "state"),
      poll: { delayMs: 20, attempts: 150 },
      readyTimeoutMs: 10_000,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const start = stdout.lastIndexOf('{\n  "schema"');
    const json = start < 0 ? {} : boundaryCast<Record<string, unknown>>(JSON.parse(stdout.slice(start)), "json");
    return { code, stdout, stderr, json };
  }

  /** Update run `runId` as its journal in the bucket shows it. */
  run(runId: string): Promise<UpdateRun> {
    return readUpdateRun({ backups: this.store, location: RUN_LOCATION, poll: { delayMs: 20, attempts: 150 } }, runId);
  }

  /** Every row of the running app's database by table, without the sessions a rollback ends and the provenance rows it adds. */
  liveRows(): Record<string, unknown[]> {
    const file = this.app?.file ?? this.instance?.file;
    if (file === undefined) throw new Error("no release runs");
    return withoutVolatile(allRows(file));
  }

  /** Every row of a backup's database by table, without the sessions and provenance rows. */
  async backupRows(backupId: string): Promise<Record<string, unknown[]>> {
    const file = join(this.root, `backup-${backupId}.db`);
    writeFileSync(file, (await this.store.get(RUN_LOCATION + keys.db(backupId))) ?? new Uint8Array());
    return withoutVolatile(allRows(file));
  }

  /** Originals of a backup whose live key holds other bytes, and delivery keys that differ from the backup's in presence or bytes. */
  async differencesFrom(backupId: string): Promise<{ originals: string[]; delivery: string[] }> {
    const blobs = boundaryCast<BlobEntry[]>(fromJsonl((await this.store.get(RUN_LOCATION + keys.blobs(backupId))) ?? new Uint8Array()), "json");
    const site = boundaryCast<SiteEntry[]>(fromJsonl((await this.store.get(RUN_LOCATION + keys.site(backupId))) ?? new Uint8Array()), "json");
    const originals: string[] = [];
    for (const entry of blobs) {
      const live = await this.store.get(entry.key);
      const copy = await this.store.get(RUN_LOCATION + entry.object);
      if (live === null || copy === null || sha256(live) !== sha256(copy)) originals.push(entry.key);
    }
    const delivery = new Set<string>();
    const listed = new Map<string, ObjectInfo>((await this.store.list(RUN_PREFIXES.delivery)).map((info) => [info.key, info]));
    for (const entry of site) {
      const live = listed.has(entry.key) ? await this.store.get(entry.key) : null;
      const copy = await this.store.get(RUN_LOCATION + entry.object);
      if (live === null || copy === null || sha256(live) !== sha256(copy)) delivery.add(entry.key);
      listed.delete(entry.key);
    }
    for (const key of listed.keys()) delivery.add(key);
    return { originals, delivery: [...delivery].sort() };
  }

  async dispose(): Promise<void> {
    await this.cf.idle();
    await this.stopApp().catch(() => undefined);
    await this.cf.close();
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
    rmSync(this.root, { recursive: true, force: true });
  }
}

function withoutVolatile(rows: Record<string, unknown[]>): Record<string, unknown[]> {
  return Object.fromEntries(Object.entries(rows).filter(([table]) => table !== "authn_sessions" && table !== "kestrel_ops_provenance"));
}
