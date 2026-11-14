import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { FakeApp, type FakePrefixes } from "./fakeApp.fixture.ts";
import { runOps, type RunOptions } from "./run.ts";
import type { ObjectStore } from "./store.ts";

/** Credentials the harness hands the tool; no output may ever contain them. */
export const SECRETS = { accessKeyId: "OPSKEY-4c1f-access", secretAccessKey: "s3cr3t-7d2e-never-printed" };

/** The stand-in app's prefixes. */
export const PREFIXES: FakePrefixes = { replica: "database/", media: "media/", delivery: "www/", derived: "media-variants/" };

/** The backup location in the harness bucket. */
export const LOCATION = "kestrel-backups/";

/** One run of the tool. */
export interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
  /** The last JSON document on stdout, for `--json` runs. */
  json: Record<string, unknown>;
}

/** A project directory with `kestrel.environments.json`, a stand-in app and a way to run the tool against both. */
export interface Harness {
  root: string;
  app: FakeApp;
  store: ObjectStore;
  outputs: string[];
  run(args: string[], extra?: Partial<RunOptions>): Promise<RunOutcome>;
  answers(values: Record<string, string>): string;
  dispose(): Promise<void>;
}

/** Options of {@link createHarness}. */
export interface HarnessOptions {
  store: ObjectStore;
  runtime?: string;
  production?: boolean;
}

/** Builds a harness whose tool and app share `store`. */
export function createHarness(options: HarnessOptions): Harness {
  const root = mkdtempSync(join(tmpdir(), "kestrel-ops-harness-"));
  const app = new FakeApp({ store: options.store, dir: join(root, "app"), prefixes: PREFIXES, runtime: options.runtime ?? "6.0.0" });
  const environments = {
    environments: {
      prod: {
        production: options.production ?? true,
        target: { adapter: "fake" },
        storage: { bucket: "kestrel-test", credentials: { accessKeyId: { env: "OPS_ACCESS_KEY" }, secretAccessKey: { env: "OPS_SECRET_KEY" } } },
        app: { replicaPrefix: PREFIXES.replica, mediaPrefix: PREFIXES.media, deliveryPrefix: PREFIXES.delivery, derivedPrefixes: [PREFIXES.derived] },
        backups: { prefix: LOCATION },
      },
    },
  };
  writeFileSync(join(root, "kestrel.environments.json"), JSON.stringify(environments, null, 2));
  const outputs: string[] = [];
  let answerFiles = 0;
  return {
    root,
    app,
    store: options.store,
    outputs,
    async run(args, extra = {}) {
      let stdout = "";
      let stderr = "";
      const code = await runOps(args, {
        cwd: root,
        env: { OPS_ACCESS_KEY: SECRETS.accessKeyId, OPS_SECRET_KEY: SECRETS.secretAccessKey },
        stdout: (t) => {
          stdout += t;
        },
        stderr: (t) => {
          stderr += t;
        },
        targets: { fake: () => app },
        stores: () => options.store,
        stateRoot: join(root, "state"),
        poll: { delayMs: 5, attempts: 200 },
        readyTimeoutMs: 1000,
        ...extra,
      });
      outputs.push(stdout, stderr);
      const start = stdout.lastIndexOf('\n{\n  "schema"');
      const text = start >= 0 ? stdout.slice(start + 1) : stdout.startsWith('{\n  "schema"') ? stdout : "";
      const json = text === "" ? {} : boundaryCast<Record<string, unknown>>(JSON.parse(text), "json");
      return { code, stdout, stderr, json };
    },
    answers(values) {
      answerFiles += 1;
      const file = join(root, `answers-${answerFiles}.json`);
      writeFileSync(file, JSON.stringify(values));
      return file;
    },
    async dispose() {
      if ((await app.status()).state === "started") await app.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
