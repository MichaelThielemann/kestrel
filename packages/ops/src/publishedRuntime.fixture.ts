import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import { isErr, type Result } from "@michaelthielemann/kestrel/result";
import { blobstoreOf } from "./replica.ts";
import type { ObjectStore } from "./store.ts";
import type { Target, TargetFacts, TargetStatus } from "./target.ts";
import { fixture, FIXTURE_REPLICA } from "./upgradeFixture.fixture.ts";

/** The environment variable naming a directory whose `node_modules` holds the published replication package of the fixture's release. */
export const PUBLISHED_RUNTIME_ENV = "KESTREL_OPS_PUBLISHED_RUNTIME";

/** What an app's start uses of the published replication package's `impl` export. */
export interface PublishedReplication {
  version: string;
  restoreFromBlobs(blobs: Blobstore, prefix: string, target: { generation?: string; at?: number }, outFile: string): Promise<Result<{ generation: string; at: number }, KestrelError>>;
  createReplicationSqlite(config: { file: string; prefix: string; checkpointBytes: number; checkpointSeconds: number; snapshotSeconds: number; retentionSeconds: number; restoreOnStart: boolean }, blobs: Blobstore): { sync(): Promise<Result<unknown, KestrelError>>; close(): void };
}

/** Loads the replication package installed under `dir` and refuses one whose version is not the fixture's. */
export async function loadPublishedReplication(dir: string): Promise<PublishedReplication> {
  const root = join(dir, "node_modules", "@michaelthielemann", "kestrel-replication-sqlite");
  const version = boundaryCast<{ version: string }>(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "json").version;
  if (version !== fixture.version) throw new Error(`${root} holds version ${version}, the fixture was written by ${fixture.version}`);
  const impl: unknown = await import(pathToFileURL(join(root, "dist", "impl.js")).href);
  const restore: unknown = typeof impl === "object" && impl !== null ? Reflect.get(impl, "restoreFromBlobs") : null;
  const create: unknown = typeof impl === "object" && impl !== null ? Reflect.get(impl, "createReplicationSqlite") : null;
  if (typeof restore !== "function" || typeof create !== "function") throw new Error(`${root} exports no restoreFromBlobs and createReplicationSqlite`);
  return { version, ...boundaryCast<Omit<PublishedReplication, "version">>({ restoreFromBlobs: restore, createReplicationSqlite: create }, "host") };
}

/**
 * An app on the published replication package of the fixture's release on an ephemeral disk: every start restores
 * the replica as that package's boot does when the database file is missing, then replicates through it, so the
 * generation it starts is named and written by the published code.
 */
export class PublishedRuntimeApp implements Target {
  readonly transport = "promote" as const;
  readonly dir = mkdtempSync(join(tmpdir(), "kestrel-ops-published-app-"));
  readonly file = join(this.dir, "kestrel.db");
  restoredFrom: string | null = null;
  private db: DatabaseSync | null = null;
  private replication: ReturnType<PublishedReplication["createReplicationSqlite"]> | null = null;

  constructor(
    private readonly store: ObjectStore,
    private readonly published: PublishedReplication,
  ) {}

  async describe(): Promise<TargetFacts> {
    return { kind: "fixture", packages: { ...fixture.packages, "@michaelthielemann/kestrel-replication-sqlite": this.published.version } };
  }

  async status(): Promise<TargetStatus> {
    return this.db === null ? { state: "stopped", instances: 0 } : { state: "started", instances: 1 };
  }

  async start(): Promise<void> {
    if (this.db !== null) throw new Error("already running");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(this.file + suffix, { force: true });
    const blobs = blobstoreOf(this.store);
    const restored = await this.published.restoreFromBlobs(blobs, FIXTURE_REPLICA, {}, this.file);
    if (isErr(restored)) throw new Error(restored.error.message);
    this.restoredFrom = restored.value.generation;
    this.replication = this.published.createReplicationSqlite({ file: this.file, prefix: FIXTURE_REPLICA, checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 86400, retentionSeconds: 172800, restoreOnStart: true }, blobs);
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    await this.sync();
  }

  async waitReady(): Promise<boolean> {
    return this.db !== null;
  }

  async sync(): Promise<void> {
    const synced = await this.replication?.sync();
    if (synced && isErr(synced)) throw new Error(synced.error.message);
  }

  async stop(): Promise<{ stoppedAt: number }> {
    if (this.db !== null) await this.sync();
    this.close();
    return { stoppedAt: Date.now() };
  }

  /** Runs `sql` on the app's database. */
  run(sql: string): void {
    if (this.db === null) throw new Error("not running");
    this.db.exec(sql);
  }

  private close(): void {
    this.replication?.close();
    this.db?.close();
    this.replication = null;
    this.db = null;
  }

  dispose(): void {
    this.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
