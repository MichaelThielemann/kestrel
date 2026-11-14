import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettings, loadEnvironments, type UpdateSettings } from "../environments.ts";
import { LOCATION, PREFIXES } from "../harness.fixture.ts";
import { Journal } from "../journal.ts";
import { hex } from "../layout.ts";
import { MemoryBucket, memoryStore } from "../memoryStore.ts";
import type { Output } from "../output.ts";
import { Redactor } from "../redact.ts";
import type { ObjectStore } from "../store.ts";
import { createWorkspace } from "../workspace.ts";
import { fakeRelease, FakeUpdateTarget, type FakeRelease } from "./fakeUpdateTarget.fixture.ts";
import { RUN_STEP } from "./journal.ts";
import { defaultSteps } from "./steps.ts";
import type { UpdateContext, UpdateRun, UpdateSteps } from "./types.ts";

/** Options of {@link createUpdateHarness}. */
export interface UpdateHarnessOptions {
  /** The release the app runs before the update; default runtime 5.8.1, which writes no seal. */
  from?: Partial<FakeRelease>;
  /** The release the update deploys; default runtime 6.0.0. */
  to?: Partial<FakeRelease>;
  /** The store; default an in-memory bucket. */
  store?: ObjectStore;
  production?: boolean;
  /** The `update` block of the environment, merged over the defaults; the waits default to one second. */
  update?: Partial<UpdateSettings>;
}

/** What {@link UpdateHarness.context} varies per command. */
export interface ContextOptions {
  /** The update run the command works on; a new run with this process's id when absent. */
  run?: Pick<UpdateRun, "runId" | "lastSeq">;
  /** The command the run's opening record names, such as `update deploy`; written only for a new run. */
  command?: string;
  steps?: Partial<UpdateSteps>;
  answers?: Record<string, string>;
  yes?: boolean;
}

/** Lines a context wrote, by stream. */
export interface CollectedOutput {
  info: string[];
  warn: string[];
  error: string[];
}

/** A project with an environment `prod` on a {@link FakeUpdateTarget}, and contexts for update commands against it. */
export interface UpdateHarness {
  root: string;
  bucket: MemoryBucket | null;
  store: ObjectStore;
  target: FakeUpdateTarget;
  /** The directory the update stages; the target knows it as the `to` release. */
  releaseDir: string;
  output: CollectedOutput;
  /** A context for one command; for a new run it records the opening `run` record first. */
  context(options?: ContextOptions): Promise<UpdateContext>;
  dispose(): Promise<void>;
}

/** Builds an {@link UpdateHarness}; the app is stopped until a test starts it. */
export function createUpdateHarness(options: UpdateHarnessOptions = {}): UpdateHarness {
  const root = mkdtempSync(join(tmpdir(), "kestrel-ops-update-"));
  const releaseDir = join(root, "release");
  mkdirSync(releaseDir, { recursive: true });
  const bucket = options.store === undefined ? new MemoryBucket("kestrel-test") : null;
  const store = options.store ?? memoryStore(bucket ?? new MemoryBucket("kestrel-test"));
  const target = new FakeUpdateTarget({ store, dir: join(root, "app"), prefixes: PREFIXES, current: fakeRelease({ runtime: "5.8.1", ...options.from }), releases: { [releaseDir]: fakeRelease(options.to) } });
  const update = { sealTimeoutSeconds: 1, syncWindowSeconds: 1, renderTimeoutSeconds: 1, readyTimeoutSeconds: 1, ...options.update };
  const environments = {
    environments: {
      prod: {
        production: options.production ?? true,
        target: { adapter: "fake-update" },
        storage: { bucket: "kestrel-test" },
        app: { replicaPrefix: PREFIXES.replica, mediaPrefix: PREFIXES.media, deliveryPrefix: PREFIXES.delivery, derivedPrefixes: [PREFIXES.derived] },
        backups: { prefix: LOCATION },
        update: { ...update, release: { dir: "release" } },
      },
    },
  };
  writeFileSync(join(root, "kestrel.environments.json"), JSON.stringify(environments, null, 2));
  const output: CollectedOutput = { info: [], warn: [], error: [] };
  const workspaces: Array<{ dispose(): void }> = [];
  return {
    root,
    bucket,
    store,
    target,
    releaseDir,
    output,
    async context(ctxOptions = {}) {
      const env = loadEnvironments(root).prod;
      if (env === undefined) throw new Error("the harness environment is missing");
      const runId = hex(6);
      const redactor = new Redactor();
      const workspace = createWorkspace(join(root, "state"), runId);
      workspaces.push(workspace);
      const run = ctxOptions.run ?? { runId, lastSeq: 0 };
      const journal = new Journal(run.runId, store, LOCATION, redactor, Date.now, workspace.path("journal.jsonl"), run.lastSeq);
      const out: Output = { info: (line) => output.info.push(redactor.apply(line)), warn: (line) => output.warn.push(redactor.apply(line)), error: (line) => output.error.push(redactor.apply(line)) };
      const ctx: UpdateContext = {
        envName: "prod",
        env,
        app: store,
        backups: store,
        location: LOCATION,
        target,
        out,
        answers: { answers: ctxOptions.answers ?? {}, yes: ctxOptions.yes ?? true },
        clock: Date.now,
        redactor,
        workspace,
        runId,
        journal,
        tool: { name: "@michaelthielemann/kestrel-ops", version: "0.0.0-test" },
        project: { versions: {}, lockfileSha256: null },
        poll: { delayMs: 5, attempts: 200 },
        readyTimeoutMs: 1000,
        generationWaitMs: 1000,
        update: updateSettings(env),
        release: { dir: releaseDir, versions: fakeRelease(options.to).versions, lockfileSha256: null },
        host: {},
        run: { id: run.runId },
        steps: { ...defaultSteps(), ...ctxOptions.steps },
      };
      if (ctxOptions.run === undefined) await journal.record(RUN_STEP, "started", { command: ctxOptions.command ?? "update deploy", env: "prod", phase: (ctxOptions.command ?? "update deploy").split(" ")[1] ?? "deploy" });
      return ctx;
    },
    async dispose() {
      await target.idle();
      if ((await target.status()).state === "started") await target.stop();
      for (const workspace of workspaces) workspace.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
