import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
// eslint-disable-next-line no-restricted-imports -- the stand-in app reaches the bucket the way the tool does
import { blobstoreOf, type ObjectStore } from "@michaelthielemann/kestrel-ops";
// eslint-disable-next-line no-restricted-imports -- the stand-in app replicates with the real replication package
import { createReplicationSqlite, listReplica, readOrigin, restoreFromBlobs, type PlacedRestore, type Replication } from "@michaelthielemann/kestrel-replication-sqlite/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isErr } from "@michaelthielemann/kestrel/result";

/** Prefixes of the stand-in app in its bucket. */
export interface StandInPrefixes {
  replica: string;
  media: string;
  delivery: string;
  derived: string;
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
 * An app instance on an empty disk, as a Cloud Foundry container runs it: every start restores the newest replica
 * generation, acknowledges a promoted one with `applied.json`, and every stop syncs and seals the replica.
 */
export class StandInApp {
  readonly dir = mkdtempSync(join(tmpdir(), "kestrel-cf-app-"));
  readonly file = join(this.dir, "kestrel.db");
  restoredFrom: string | null = null;
  acknowledged: string | null = null;
  private db: DatabaseSync | null = null;
  private replication: Replication | null = null;

  constructor(
    readonly store: ObjectStore,
    readonly prefixes: StandInPrefixes,
  ) {}

  get running(): boolean {
    return this.db !== null;
  }

  async start(): Promise<void> {
    if (this.db !== null) throw new Error("already running");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(this.file + suffix, { force: true });
    const blobs = blobstoreOf(this.store);
    const listing = await listReplica(blobs, this.prefixes.replica);
    if (isErr(listing)) throw new Error(listing.error.message);
    let placedRestore: PlacedRestore | undefined;
    this.restoredFrom = null;
    if (listing.value.points.length > 0) {
      const restored = await restoreFromBlobs(blobs, this.prefixes.replica, {}, this.file, listing.value.points);
      if (isErr(restored)) throw new Error(restored.error.message);
      this.restoredFrom = restored.value.generation;
      const origin = await readOrigin(blobs, this.prefixes.replica, restored.value.generation);
      if (!isErr(origin)) placedRestore = { applied: { generation: restored.value.generation, nonce: origin.value.nonce, restoredAt: Date.now() }, origin: origin.value.content };
    }
    const replication = createReplicationSqlite({ file: this.file, prefix: this.prefixes.replica, checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 86400, retentionSeconds: 172800, restoreOnStart: true }, blobs, Date.now, { checkIntervalMs: 60_000, ...(placedRestore ? { placedRestore } : {}) });
    this.replication = replication;
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    for (const sql of TABLES) this.db.exec(sql);
    if (placedRestore !== undefined) {
      replication.restoreHandled();
      this.acknowledged = placedRestore.applied.generation;
    }
    await this.sync();
  }

  async sync(): Promise<void> {
    const synced = await this.replication?.sync();
    if (synced && isErr(synced)) throw new Error(synced.error.message);
  }

  async stop(): Promise<void> {
    if (this.db === null || this.replication === null) return;
    await this.sync();
    const sealed = await this.replication.seal();
    if (isErr(sealed)) throw new Error(sealed.error.message);
    this.replication.close();
    this.db.close();
    this.replication = null;
    this.db = null;
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
    const key = `${this.prefixes.media}${id}/${name}`;
    await this.store.put(key, bytes);
    this.run(`INSERT INTO media_items ("id", "filename", "key", "checksum", "size") VALUES (?, ?, ?, ?, ?)`, id, name, key, createHash("sha256").update(bytes).digest("hex"), bytes.byteLength);
    return key;
  }

  async deleteMedia(id: string): Promise<void> {
    const row = boundaryCast<{ key: string } | undefined>(this.live.prepare(`SELECT "key" FROM media_items WHERE "id" = ?`).get(id), "host");
    if (row) await this.store.delete(row.key);
    this.run(`DELETE FROM media_items WHERE "id" = ?`, id);
  }

  /** Renders every page to the delivery prefix and removes outputs of pages that are gone, as a full export does. */
  async export(): Promise<void> {
    const pages = boundaryCast<Array<{ id: string; title: string; body: string }>>(this.rows("pages"), "host");
    const wanted = new Set<string>();
    for (const page of pages) {
      const key = `${this.prefixes.delivery}${page.id}/index.html`;
      wanted.add(key);
      await this.store.put(key, encode(`<h1>${page.title}</h1><p>${page.body}</p>`), { contentType: "text/html; charset=utf-8" });
    }
    await this.store.put(`${this.prefixes.delivery}sitemap.xml`, encode(pages.map((p) => `/${p.id}/`).join("\n")), { contentType: "application/xml" });
    wanted.add(`${this.prefixes.delivery}sitemap.xml`);
    for (const info of await this.store.list(this.prefixes.delivery)) if (!wanted.has(info.key)) await this.store.delete(info.key);
    for (const page of pages) await this.store.put(`${this.prefixes.derived}${page.id}/thumb.webp`, encode(`thumb ${page.id} ${page.title}`));
  }

  /** Seeds pages, media, users with a session, a second factor and an audit entry, then exports and syncs. */
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

  async dispose(): Promise<void> {
    await this.stop().catch(() => undefined);
    rmSync(this.dir, { recursive: true, force: true });
  }
}
