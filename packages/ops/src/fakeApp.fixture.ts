import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { CONTENT, type Content, type ContentDocument, type ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { ok as okResult } from "@michaelthielemann/kestrel-contracts/errors";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { RENDERER, type Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { SITE, type Site } from "@michaelthielemann/kestrel-contracts/site";
import { createFakePersistence, matchesFilter } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
// eslint-disable-next-line no-restricted-imports -- the stand-in app renders with the real delivery package
import deliveryModule, { configSchema as deliveryConfig } from "@michaelthielemann/kestrel-delivery-static";
// eslint-disable-next-line no-restricted-imports -- the stand-in app replicates with the real replication package
import replicationModule, { configSchema as replicationConfig } from "@michaelthielemann/kestrel-replication-sqlite";
// eslint-disable-next-line no-restricted-imports -- the stand-in app replicates with the real replication package
import { createReplicationSqlite, restoreFromBlobs, type Replication } from "@michaelthielemann/kestrel-replication-sqlite/impl";
import type { Introspection, Manifest, RunObserver } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import type { Step } from "@michaelthielemann/kestrel/context";
import { isErr, ok as okStep } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { blobstoreOf, listGenerations } from "./replica.ts";
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
  `CREATE TABLE IF NOT EXISTS render_status ("id" TEXT PRIMARY KEY, "key" TEXT, "sha256" TEXT)`,
];

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const BOOT_STEPS = ["replication.checkRestored", "delivery.checkBuild"] as const;

const PAGES_MODEL: ContentModel = {
  locales: ["en"],
  defaultLocale: "en",
  types: { pages: { kind: "multi", fields: { slug: { type: "slug", required: true }, title: { type: "text" }, status: { type: "enum", options: ["draft", "published"] } } } },
};

const SITE_PATHS: Site = {
  resolve: () => Promise.reject(new Error("the stand-in site resolves nothing")),
  pathOf: (_type, doc) => (typeof doc.slug === "string" && doc.slug !== "" ? `/${doc.slug === "home" ? "" : doc.slug}` : null),
  resolveLinks: async (_type, doc) => okResult(doc),
};

const PLAIN_RENDERER: Renderer = {
  formats: () => ["html"],
  render: async (input) => okResult({ data: `<h1>${String(input.document.title)}</h1>`, contentType: "text/html", extension: "html" }),
};

function providers(entries: ReadonlyArray<readonly [Contract<unknown>, unknown]>): Deps {
  const byName = new Map(entries.map(([contract, value]) => [contract.name, value]));
  return {
    get<T>(contract: Contract<T>): T {
      if (!byName.has(contract.name)) throw new Error(`the stand-in app provides no ${contract.name}`);
      return boundaryCast<T>(byName.get(contract.name), "host");
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root: process.cwd(),
    eventTriggers: [],
  };
}

/**
 * An in-process stand-in for a Kestrel app on an ephemeral disk: it rebuilds its database from the newest replica
 * generation at every start and replicates with the real replication code. From the sealing runtime major on it
 * starts through the real `replication-sqlite` module, runs a boot pipeline of `replication.checkRestored` and the
 * real `delivery.checkBuild`, and seals the replica at teardown; the module then writes `applied.json` after a start
 * that restored a generation carrying `origin.json`.
 */
export class FakeApp implements Target {
  readonly transport = "promote" as const;
  readonly file: string;
  db: DatabaseSync | null = null;
  replication: Replication | null = null;
  starts = 0;
  restoredFrom: string | null = null;
  /** What the boot run of the last start answered: `replication.checkRestored` and `delivery.checkBuild`; null for a runtime before the sealing major. */
  lastBoot: { databaseRestoredAt: number | null; checkBuild: { changed: boolean; restored: boolean; marked: number } } | null = null;
  failNextBoot = false;
  private readonly deliveryState = createFakePersistence();
  private readonly observers = new Set<RunObserver>();
  private detach: (() => void) | null = null;

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
    const name = basename(this.file);
    for (const entry of readdirSync(this.options.dir)) if (entry === name || entry.startsWith(`${name}-`) || entry.startsWith(`${name}.`)) rmSync(join(this.options.dir, entry), { recursive: true, force: true });
    this.restoredFrom = null;
    this.lastBoot = null;
    if (this.sealing) await this.startThroughModule();
    else await this.startOnImpl();
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    for (const sql of TABLES) this.db.exec(sql);
    if (this.sealing) await this.boot();
    await this.sync();
    this.starts += 1;
  }

  private async startOnImpl(): Promise<void> {
    const { store, prefixes } = this.options;
    if ((await listGenerations(store, prefixes.replica)).length > 0) {
      const restored = await restoreFromBlobs(blobstoreOf(store), prefixes.replica, {}, this.file);
      if (isErr(restored)) throw new Error(restored.error.message);
      this.restoredFrom = restored.value.generation;
    }
    this.replication = createReplicationSqlite(this.replicationSettings(), blobstoreOf(store), Date.now, { checkIntervalMs: 60_000 });
  }

  private replicationSettings(): { file: string; prefix: string; checkpointBytes: number; checkpointSeconds: number; snapshotSeconds: number; retentionSeconds: number; restoreOnStart: boolean } {
    return { file: this.file, prefix: this.options.prefixes.replica, checkpointBytes: 4 * 1024 * 1024, checkpointSeconds: 300, snapshotSeconds: 86400, retentionSeconds: 172800, restoreOnStart: true };
  }

  private async startThroughModule(): Promise<void> {
    const blobs = blobstoreOf(this.options.store);
    const newest = (await listGenerations(this.options.store, this.options.prefixes.replica)).at(-1);
    const deps: Deps = { ...providers([[BLOBSTORE, blobs]]), bootStartedAt: Date.now() };
    const instance = boundaryCast<Replication>(await replicationModule.setup(replicationConfig.parse(this.replicationSettings()), deps), "host");
    this.replication = instance;
    this.observers.clear();
    const detach = replicationModule.attach?.(instance, this.introspection());
    this.detach = typeof detach === "function" ? detach : null;
    this.restoredFrom = existsSync(this.file) ? (newest?.name ?? null) : null;
  }

  private introspection(): Introspection {
    const steps = BOOT_STEPS.map((name) => ({ spec: name, name, module: name.startsWith("replication.") ? "replication/sqlite" : "delivery/static", description: { summary: name, reads: [], writes: name === "replication.checkRestored" ? ["result._databaseRestoredAt"] : [] } }));
    const manifest = boundaryCast<Manifest>({ pipelines: [{ name: "boot", steps }] }, "host");
    return {
      describe: () => manifest,
      observe: (observer) => {
        this.observers.add(observer);
        return () => this.observers.delete(observer);
      },
      health: () => ({ ok: true, restartRequired: false, modules: [] }),
    };
  }

  private async boot(): Promise<void> {
    const replication = this.replication;
    if (replication === null) throw new Error("the app is not running");
    const content = this.content();
    const delivery = await deliveryModule.setup(deliveryConfig.parse({ types: { pages: { home: "home" } }, prefix: this.options.prefixes.delivery }), providers([[CONTENT, content], [SITE, SITE_PATHS], [RENDERER, PLAIN_RENDERER], [BLOBSTORE, blobstoreOf(this.options.store)], [PERSISTENCE, this.deliveryState]]));
    try {
      let databaseRestoredAt: number | null = null;
      const capture: Step = async (ctx) => {
        const reported: unknown = boundaryCast<Record<string, unknown>>(ctx.result, "host")._databaseRestoredAt;
        databaseRestoredAt = typeof reported === "number" ? reported : null;
        return okStep(ctx);
      };
      const pipeline = definePipeline({ name: "boot", steps: [BOOT_STEPS[0], "boot.capture", BOOT_STEPS[1]] });
      const runId = `boot-${this.starts + 1}`;
      for (const observer of this.observers) observer.stepStart?.({ runId, pipeline: "boot", step: "replication.checkRestored", at: Date.now() });
      const run = await runPipeline(pipeline, { payload: { build: "stand-in-build" } }, { modules: [{ module: replicationModule, instance: replication }, { module: deliveryModule, instance: delivery }], steps: { "boot.capture": capture } });
      if (run.status !== 200) throw new Error(`the boot pipeline failed with ${run.status}`);
      const result = boundaryCast<{ changed: boolean; restored: boolean; marked: number }>(run.result, "host");
      this.lastBoot = { databaseRestoredAt, checkBuild: { changed: result.changed, restored: result.restored, marked: result.marked } };
      const outcome = this.failNextBoot ? "error" : "ok";
      this.failNextBoot = false;
      for (const observer of this.observers) observer.runEnd?.({ runId, pipeline: "boot", trigger: { kind: "http", name: "boot" }, at: Date.now(), ms: 1, status: outcome === "ok" ? 200 : 500, outcome });
    } finally {
      await boundaryCast<{ close(): Promise<void> }>(delivery, "host").close();
    }
  }

  private content(): Content {
    const documents = (): ContentDocument[] => boundaryCast<Array<{ id: string; title: string }>>(this.rows("pages"), "host").map((page) => ({ id: page.id, createdAt: 1, updatedAt: 1, slug: page.id, title: page.title, status: "published" }));
    const refuse = (): Promise<never> => Promise.reject(new Error("the stand-in content is read-only"));
    return {
      model: () => PAGES_MODEL,
      validate: () => ({ ok: true, data: {} }),
      get: async (_type, id) => okResult(documents().find((doc) => doc.id === id) ?? null),
      list: async (_type, filter = {}) => {
        const all = documents().filter((doc) => matchesFilter(doc, filter));
        return okResult({ items: all, total: all.length });
      },
      create: refuse,
      set: refuse,
      update: refuse,
      remove: refuse,
      removeTranslation: refuse,
    };
  }

  async sync(): Promise<void> {
    const synced = await this.replication?.sync();
    if (synced && isErr(synced)) throw new Error(synced.error.message);
  }

  async stop(): Promise<{ stoppedAt: number }> {
    if (this.db !== null && this.replication !== null) {
      await this.sync();
      if (this.sealing) {
        const sealed = await this.replication.seal();
        if (isErr(sealed)) throw new Error(sealed.error.message);
      }
    }
    this.close();
    return { stoppedAt: Date.now() };
  }

  /** Ends the process without teardown: nothing written since the last sync reaches the replica. */
  kill(): void {
    this.close();
  }

  private close(): void {
    this.detach?.();
    this.detach = null;
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

  /**
   * Renders every page to the delivery prefix and removes outputs of pages that are gone, as a full export does, and
   * with `record` records each output in `render_status` of the database, as the delivery's status rows do.
   */
  async export(record = true): Promise<void> {
    const { store, prefixes } = this.options;
    const pages = boundaryCast<Array<{ id: string; title: string; body: string }>>(this.rows("pages"), "host");
    const wanted = new Set<string>();
    for (const page of pages) {
      const key = `${prefixes.delivery}${page.id}/index.html`;
      wanted.add(key);
      const html = `<h1>${page.title}</h1><p>${page.body}</p>`;
      await store.put(key, encode(html), { contentType: "text/html; charset=utf-8" });
      if (record) this.run(`INSERT OR REPLACE INTO render_status VALUES (?, ?, ?)`, page.id, key, createHash("sha256").update(html).digest("hex"));
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
