import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { stamp } from "./layout.ts";
import type { MemoryBucket } from "./memoryStore.ts";
import { memoryStore } from "./memoryStore.ts";
import { buildDatabase, completeGeneration, listGenerations } from "./replica.ts";
import { runOps } from "./run.ts";
import type { ObjectStore } from "./store.ts";
import type { Target, TargetFacts, TargetStatus } from "./target.ts";

/** The checked-in data of an instance on the published 5.8.1 packages. */
export const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "upgrade", "5.8.1");

/** The backup location the fixture tests write to. */
export const FIXTURE_LOCATION = "kestrel-backups/";

/** The replica prefix of the fixture's blob tree. */
export const FIXTURE_REPLICA = "replica/";

/** The parts of the fixture's `manifest.json` the tests read. */
export interface FixtureManifest {
  version: string;
  packages: Record<string, string>;
  missingOriginal: string;
  media: Record<string, { id: string; key: string }>;
  collections: Record<string, number>;
}

/** The fixture's `manifest.json`. */
export const fixture = boundaryCast<FixtureManifest>(JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")), "json");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/** Writes the fixture's blob tree into `bucket`, keyed as the instance wrote it. */
export function loadFixtureBlobs(bucket: MemoryBucket): void {
  const blobs = join(FIXTURE, "blobs");
  for (const file of files(blobs)) bucket.write(relative(blobs, file).split("\\").join("/"), readFileSync(file), "put");
}

/** Copies the fixture database to `file`; the checked-in file itself is never opened. */
export function copyFixtureDatabase(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(join(FIXTURE, "kestrel.db"), file);
}

/** Every row of every table of a database, by table, in rowid order. */
export function allRows(file: string): Record<string, unknown[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = boundaryCast<Array<{ name: string }>>(db.prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' ORDER BY "name"`).all(), "host");
    return Object.fromEntries(names.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

/** Writes a generation named by `at` alone that holds only `snapshot.db`, as the 5.8.1 runtime does at every start and every `snapshotSeconds`. */
export async function snapshotOnlyGeneration(store: ObjectStore, at: number, database: string): Promise<string> {
  const generation = stamp(at);
  await store.put(`${FIXTURE_REPLICA}gen/${generation}/snapshot.db`, new Uint8Array(readFileSync(database)));
  return generation;
}

/**
 * A stand-in for an app on the published 5.8.1 packages on an ephemeral disk: every start restores the generation
 * that sorts last by name, whatever files lie next to it, and writes a generation named by its own clock at the start,
 * with no lower bound, that holds only its snapshot.
 */
export class FiveEightApp implements Target {
  readonly transport = "promote" as const;
  readonly dir = mkdtempSync(join(tmpdir(), "kestrel-ops-5.8.1-app-"));
  readonly file = join(this.dir, "kestrel.db");
  running = false;
  restoredFrom: string | null = null;

  /** `clock` names the generation the app starts, as the app host's clock would; the default is this machine's clock. */
  constructor(
    private readonly store: ObjectStore,
    private readonly clock: () => number = Date.now,
  ) {}

  async describe(): Promise<TargetFacts> {
    return { kind: "fixture", packages: fixture.packages };
  }

  async status(): Promise<TargetStatus> {
    return this.running ? { state: "started", instances: 1 } : { state: "stopped", instances: 0 };
  }

  async stop(): Promise<{ stoppedAt: number }> {
    this.running = false;
    return { stoppedAt: Date.now() };
  }

  async start(): Promise<void> {
    const newest = (await listGenerations(this.store, FIXTURE_REPLICA)).at(-1);
    if (!newest) throw new Error("the fixture replica has no generation");
    rmSync(this.file, { force: true });
    await buildDatabase(this.store, FIXTURE_REPLICA, await completeGeneration(this.store, FIXTURE_REPLICA, newest), this.file);
    this.restoredFrom = newest.name;
    await snapshotOnlyGeneration(this.store, this.clock(), this.file);
    this.running = true;
  }

  async waitReady(): Promise<boolean> {
    return this.running;
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** One run of the tool against the fixture. */
export interface FixtureRun {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

/** A project directory whose environment `prod` names the fixture's prefixes in `bucket` and the given target. */
export function fixtureProject(bucket: MemoryBucket, target: () => Target): { root: string; run: (args: string[]) => Promise<FixtureRun>; answers: (values: Record<string, string>) => string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "kestrel-ops-fixture-"));
  const environments = {
    environments: {
      prod: {
        target: { adapter: "fixture" },
        storage: { bucket: bucket.name },
        app: { replicaPrefix: FIXTURE_REPLICA, mediaPrefix: "media/", deliveryPrefix: "site/", derivedPrefixes: ["media-variants/"] },
        backups: { prefix: FIXTURE_LOCATION },
      },
    },
  };
  writeFileSync(join(root, "kestrel.environments.json"), JSON.stringify(environments, null, 2));
  let answerFiles = 0;
  return {
    root,
    async run(args) {
      let stdout = "";
      let stderr = "";
      const store = memoryStore(bucket);
      const code = await runOps(args, {
        cwd: root,
        env: {},
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
        targets: { fixture: target },
        stores: () => store,
        stateRoot: join(root, "state"),
        poll: { delayMs: 1, attempts: 20 },
        readyTimeoutMs: 100,
        project: { versions: fixture.packages, lockfileSha256: null },
      });
      const start = stdout.lastIndexOf('{\n  "schema"');
      const json = start < 0 ? {} : boundaryCast<Record<string, unknown>>(JSON.parse(stdout.slice(start)), "json");
      return { code, stdout, stderr, json };
    },
    answers(values) {
      answerFiles += 1;
      const file = join(root, `answers-${answerFiles}.json`);
      writeFileSync(file, JSON.stringify(values));
      return file;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
