import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
// eslint-disable-next-line no-restricted-imports -- the stand-in app replicates with the real replication package
import { createReplicationSqlite, restoreFromBlobs, type Replication } from "@michaelthielemann/kestrel-replication-sqlite/impl";
import { isErr } from "@michaelthielemann/kestrel/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { blobstoreOf, listGenerations } from "./replica.ts";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { ObjectStore } from "./store.ts";
import type { Target, TargetFacts, TargetStatus } from "./target.ts";

/** Prefixes of the stand-in app in its bucket. */
export interface FakePrefixes {
  replica: string;
  media: string;
  delivery: string;
  derived: string;
}

/** Options of {@link FakeApp}. */
export interface FakeAppOptions {
  store: ObjectStore;
  dir: string;
  prefixes: FakePrefixes;
  /** The replication runtime version the app reports; from the sealing major on it seals at teardown and acknowledges promoted generations. */
  runtime: string;
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS pages ("id" TEXT PRIMARY KEY, "title" TEXT, "body" TEXT)`,
  `CREATE TABLE IF NOT EXISTS media_items ("id" TEXT PRIMARY KEY, "filename" TEXT, "key" TEXT UNIQUE, "checksum" TEXT, "size" REAL)`,
  `CREATE TABLE IF NOT EXISTS authn_users ("id" TEXT PRIMARY KEY, "username" TEXT UNIQUE, "passwordHash" TEXT, "roles" TEXT, "active" INTEGER, "createdAt" REAL)`,
  `CREATE TABLE IF NOT EXISTS authn_sessions ("id" TEXT PRIMARY KEY, "userId" TEXT, "expiresAt" REAL, "authTime" REAL)`,
  `CREATE TABLE IF NOT EXISTS audit_entries ("id" TEXT PRIMARY KEY, "eventId" TEXT, "event" TEXT, "at" REAL, "identityId" TEXT, "ip" TEXT, "params" TEXT)`,
  `CREATE TABLE IF NOT EXISTS mfa_factors ("id" TEXT PRIMARY KEY, "userId" TEXT UNIQUE, "secret" TEXT, "confirmed" INTEGER)`,
];

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * An in-process stand-in for a Kestrel app on an ephemeral disk: it rebuilds its database from the newest replica
 * generation at every start, replicates with the real replication code, and, from the sealing runtime major on,
 * writes `sealed.json` at teardown and `applied.json` after restoring a generation that carries `origin.json`.
 */
export class FakeApp implements Target {
  readonly transport = "promote" as const;
  readonly file: string;
  db: DatabaseSync | null = null;
  replication: Replication | null = null;
  starts = 0;
  restoredFrom: string | null = null;
  private readonly segmentKeys = new Map<string, Set<string>>();

  constructor(readonly options: FakeAppOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.file = join(options.dir, "app.db");
  }

  get sealing(): boolean {
    return Number(this.options.runtime.split(".")[0]) >= 6;
  }

  async describe(): Promise<TargetFacts> {
    return { kind: "fake", packages: { "@michaelthielemann/kestrel-replication-sqlite": this.options.runtime, "@michaelthielemann/kestrel": this.options.runtime } };
  }

  async status(): Promise<TargetStatus> {
    return this.db === null ? { state: "stopped", instances: 0 } : { state: "started", instances: 1 };
  }

  async start(): Promise<void> {
    if (this.db !== null) throw new Error("already running");
    const { store, prefixes } = this.options;
    for (const suffix of ["", "-wal", "-shm", ".instance"]) rmSync(this.file + suffix, { force: true });
    const newest = (await listGenerations(store, prefixes.replica)).at(-1);
    this.restoredFrom = null;
    if (newest) {
      const restored = await restoreFromBlobs(blobstoreOf(store), prefixes.replica, {}, this.file);
      if (isErr(restored)) throw new Error(restored.error.message);
      this.restoredFrom = restored.value.generation;
      const origin = newest.files["origin.json"];
      if (this.sealing && origin && newest.name === restored.value.generation) {
        const data = await store.get(origin.key);
        const parsed = boundaryCast<{ nonce: string }>(JSON.parse(new TextDecoder().decode(data ?? new Uint8Array())), "json");
        await store.put(`${prefixes.replica}gen/${newest.name}/applied.json`, encode(JSON.stringify({ generation: newest.name, nonce: parsed.nonce, restoredAt: Date.now() })));
      }
    }
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    for (const sql of TABLES) this.db.exec(sql);
    const blobs = blobstoreOf(store);
    const counting: Blobstore = {
      ...blobs,
      put: async (key, data, options) => {
        const put = await blobs.put(key, data, options);
        const generation = /\/gen\/([^/]+)\/wal\//.exec(key)?.[1];
        if (!isErr(put) && generation !== undefined) this.segmentKeys.set(generation, (this.segmentKeys.get(generation) ?? new Set()).add(key));
        return put;
      },
    };
    this.replication = createReplicationSqlite({ file: this.file, prefix: prefixes.replica, checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 86400, retentionSeconds: 172800, restoreOnStart: true }, counting, Date.now, { checkIntervalMs: 60_000 });
    await this.sync();
    this.starts += 1;
  }

  async sync(): Promise<void> {
    const synced = await this.replication?.sync();
    if (synced && isErr(synced)) throw new Error(synced.error.message);
  }

  async stop(): Promise<{ stoppedAt: number }> {
    if (this.db !== null && this.replication !== null) {
      await this.sync();
      const state = await this.replication.status();
      if (this.sealing && state.generation !== null) await this.options.store.put(`${this.options.prefixes.replica}gen/${state.generation}/sealed.json`, encode(JSON.stringify({ lineage: state.lineage, lastFrame: state.shippedFrames, segments: this.segmentKeys.get(state.generation)?.size ?? 0, at: Date.now() })));
    }
    this.close();
    return { stoppedAt: Date.now() };
  }

  /** Ends the process without teardown: nothing written since the last sync reaches the replica. */
  kill(): void {
    this.close();
  }

  private close(): void {
    this.replication?.close();
    this.db?.close();
    this.replication = null;
    this.db = null;
  }

  async waitReady(): Promise<boolean> {
    return this.db !== null;
  }

  async stopEvidence(): Promise<string[]> {
    return ["stand-in app: no platform events"];
  }

  private get live(): DatabaseSync {
    if (this.db === null) throw new Error("the app is not running");
    return this.db;
  }

  run(sql: string, ...params: Array<string | number | null>): void {
    this.live.prepare(sql).run(...params);
  }

  rows(table: string): unknown[] {
    return this.live.prepare(`SELECT * FROM "${table}" ORDER BY "id"`).all();
  }

  async upload(id: string, name: string, bytes: Uint8Array): Promise<string> {
    const key = `${this.options.prefixes.media}${id}/${name}`;
    await this.options.store.put(key, bytes);
    this.run(`INSERT INTO media_items ("id", "filename", "key", "checksum", "size") VALUES (?, ?, ?, ?, ?)`, id, name, key, createHash("sha256").update(bytes).digest("hex"), bytes.byteLength);
    return key;
  }

  async deleteMedia(id: string): Promise<void> {
    const row = boundaryCast<{ key: string } | undefined>(this.live.prepare(`SELECT "key" FROM media_items WHERE "id" = ?`).get(id), "host");
    if (row) await this.options.store.delete(row.key);
    this.run(`DELETE FROM media_items WHERE "id" = ?`, id);
  }

  /** Renders every page to the delivery prefix and removes outputs of pages that are gone, as a full export does. */
  async export(): Promise<void> {
    const { store, prefixes } = this.options;
    const pages = boundaryCast<Array<{ id: string; title: string; body: string }>>(this.rows("pages"), "host");
    const wanted = new Set<string>();
    for (const page of pages) {
      const key = `${prefixes.delivery}${page.id}/index.html`;
      wanted.add(key);
      await store.put(key, encode(`<h1>${page.title}</h1><p>${page.body}</p>`), { contentType: "text/html; charset=utf-8" });
    }
    await store.put(`${prefixes.delivery}sitemap.xml`, encode(pages.map((p) => `/${p.id}/`).join("\n")), { contentType: "application/xml" });
    wanted.add(`${prefixes.delivery}sitemap.xml`);
    for (const info of await store.list(prefixes.delivery)) if (!wanted.has(info.key)) await store.delete(info.key);
    for (const page of pages) await store.put(`${prefixes.derived}${page.id}/thumb.webp`, encode(`thumb ${page.id} ${page.title}`));
  }

  /** Seeds pages, media, users with sessions, a second factor and audit entries, then exports and syncs. */
  async seed(): Promise<void> {
    this.run(`INSERT INTO pages VALUES ('home', 'Home', 'Welcome')`);
    this.run(`INSERT INTO pages VALUES ('about', 'About', 'A small studio')`);
    this.run(`INSERT INTO pages VALUES ('contact', 'Contact', 'Write to us')`);
    await this.upload("m1", "harbour.jpg", encode("harbour image bytes"));
    await this.upload("m2", "plan.pdf", encode("floor plan bytes"));
    await this.upload("m3", "logo.svg", encode("<svg>logo</svg>"));
    this.run(`INSERT INTO authn_users VALUES ('u1', 'editor', 'hash-1', '["editor"]', 1, 1)`);
    this.run(`INSERT INTO authn_users VALUES ('u2', 'admin', 'hash-2', '["admin"]', 1, 1)`);
    this.run(`INSERT INTO authn_sessions VALUES ('s1', 'u1', 9999999999999, 1)`);
    this.run(`INSERT INTO mfa_factors VALUES ('f1', 'u2', 'secret-one', 1)`);
    this.run(`INSERT INTO audit_entries VALUES ('a1', 'e1', 'login', 1, 'u1', '127.0.0.1', '{}')`);
    await this.export();
    await this.sync();
  }

  /** True when the database file exists next to its instance-lock sidecar path. */
  hasFile(suffix: string): boolean {
    return existsSync(this.file + suffix);
  }
}
