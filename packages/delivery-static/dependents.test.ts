import { afterEach, describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import type { EventData, Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { renderFailed, type Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createSiteDefault } from "@michaelthielemann/kestrel-site-default/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { observeReads } from "@michaelthielemann/kestrel/reads";
import { DEPENDENCIES, DEPENDENCY_SETS, LLMS_STALE, OUTPUT_STALE, STATE, STATUS, createDeliveryStatic, keyFor, type Delivery, type StatusRow } from "./impl.ts";
import { configSchema } from "./module.ts";

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
        body: { type: "json", localized: true },
      },
    },
    speakers: { kind: "multi", fields: { name: { type: "text", required: true }, status: { type: "enum", options: ["draft", "published"] }, rank: { type: "number" } } },
    lineups: { kind: "multi", fields: { title: { type: "text" }, speakers: { type: "json" } } },
    settings: { kind: "single", fields: { title: { type: "text", localized: true } } },
  },
};

interface Gate {
  reached: Promise<void>;
  release(): void;
}

function gate(): Gate & { wait: Promise<void>; arrive(): void } {
  let release: () => void = () => {};
  let arrive: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return { wait, reached, release, arrive };
}

interface Block {
  type: string;
  id?: string;
  filter?: Record<string, unknown>;
  link?: string;
}

function blocksOf(value: unknown): Block[] {
  return Array.isArray(value) ? boundaryCast<Block[]>(value, "json") : [];
}

function readingRenderer(content: Content) {
  const calls: string[] = [];
  const holds = new Map<string, ReturnType<typeof gate>>();
  let delayMs = 0;
  const renderer: Renderer = {
    formats: () => ["html"],
    async render(input) {
      calls.push(`${input.id}/${input.locale ?? ""}`);
      const own = expectOk(await content.get("pages", input.id, input.locale === undefined ? {} : { locale: input.locale }));
      const settings = expectOk(await content.get("settings", undefined, input.locale === undefined ? {} : { locale: input.locale }));
      const names: string[] = [];
      for (const block of blocksOf(own?.body)) {
        if (block.type === "lineup" && block.id !== undefined) {
          const lineup = expectOk(await content.get("lineups", block.id));
          for (const speakerId of boundaryCast<string[]>(lineup?.speakers ?? [], "json")) {
            const speaker = expectOk(await content.get("speakers", speakerId));
            if (speaker?.status !== "published") continue;
            if (speaker.name === "FAIL") return err(renderFailed("a speaker made the block fail"));
            if (speaker.name === "HANG") await new Promise(() => {});
            names.push(String(speaker.name));
          }
        }
        if (block.type === "speakers") {
          const listed = expectOk(await content.list("speakers", block.filter ?? {}, { sort: { name: "asc" } }));
          names.push(...listed.items.map((s) => String(s.name)));
        }
      }
      const hold = holds.get(input.id);
      if (hold !== undefined) {
        holds.delete(input.id);
        hold.arrive();
        await hold.wait;
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const links = JSON.stringify(input.document._links ?? {});
      return ok({ data: `<h1>${String(input.document.title)}</h1><p>${typeof settings?.title === "string" ? settings.title : ""}</p><ul>${names.join(",")}</ul><nav>${links}</nav>`, contentType: "text/html", extension: "html" });
    },
  };
  return {
    renderer,
    calls,
    hold(id: string): Gate {
      const g = gate();
      holds.set(id, g);
      return g;
    },
    delay(ms: number) {
      delayMs = ms;
    },
  };
}

function memoryBlobs(): Blobstore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async put(key, data) {
      files.set(key, typeof data === "string" ? data : new TextDecoder().decode(data));
      return ok();
    },
    async get(key) {
      const file = files.get(key);
      return ok(file === undefined ? null : new TextEncoder().encode(file));
    },
    async remove(key) {
      files.delete(key);
      return ok();
    },
    async move(from, to) {
      const file = files.get(from);
      if (file !== undefined) files.set(to, file);
      files.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...files].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length })));
    },
  };
}

function recordingLogger(): Logger & { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  return {
    errors,
    warnings,
    step() {},
    info() {},
    error(message) {
      errors.push(message);
    },
    warn(message) {
      warnings.push(message);
    },
  };
}

type Dependencies = Partial<ReturnType<typeof configSchema.parse>["dependencies"]>;

interface HarnessOptions {
  render?: "events" | "background";
  dependencies?: Dependencies;
  db?: Persistence;
  content?: Content;
  blobs?: ReturnType<typeof memoryBlobs>;
  renderer?: Renderer;
}

const instances: Delivery[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
});

async function harness(options: HarnessOptions = {}) {
  const db = options.db ?? createFakePersistence();
  const content = options.content ?? (await createContentDefault(model, db));
  const site = createSiteDefault(content);
  const reading = readingRenderer(content);
  const blobs = options.blobs ?? memoryBlobs();
  const emitted: Array<{ name: string; data: EventData }> = [];
  const events: Events = {
    async emit(name, data) {
      emitted.push({ name, data });
    },
    on: () => () => {},
  };
  const logger = recordingLogger();
  let offset = 0;
  const now = () => Date.now() + offset;
  const config = configSchema.parse({ types: { pages: {} }, prefix: "site/", dependencies: { render: options.render ?? "events", rendererReadsDocument: true, ...options.dependencies } });
  const delivery = await createDeliveryStatic(config, { content, site, renderer: options.renderer ?? reading.renderer, blobs, db, logger, events }, now);
  instances.push(delivery);

  const page = async (fields: Record<string, unknown>, locale = "de"): Promise<string> => expectOk(await content.create("pages", fields, { locale })).id;
  const html = (path: string): string | null => blobs.files.get(keyFor("site/", path, "html")) ?? null;
  const row = async (docId: string, locale = "de"): Promise<StatusRow | null> => expectOk(await db.findOne<StatusRow>(STATUS, { type: "pages", docId, locale }));
  const marked = async (): Promise<string[]> => expectOk(await db.findMany<StatusRow>(STATUS, { staleToken: { ne: null } }, { sort: { docId: "asc", locale: "asc" } })).items.map((r) => `${r.docId}/${r.locale}`);
  const jobs = () => emitted.filter((e) => e.name === OUTPUT_STALE).map((e) => `${String(e.data.docId)}/${String(e.data.locale)}`);
  const settle = async (timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = expectOk(await delivery.readStaleStatus());
      if (status.stale === 0 && status.rendering === 0) return;
      if (Date.now() > deadline) throw new Error(`still stale: ${JSON.stringify(status)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    db,
    content,
    site,
    blobs,
    delivery,
    reading,
    emitted,
    logger,
    page,
    html,
    row,
    marked,
    jobs,
    settle,
    advance(ms: number) {
      offset += ms;
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function seed(h: Harness) {
  const { content } = h;
  expectOk(await content.set("settings", { title: "Festival" }, { locale: "de" }));
  expectOk(await content.set("settings", { title: "Festival EN" }, { locale: "en" }));
  const ada = expectOk(await content.create("speakers", { name: "Ada", status: "published", rank: 1 })).id;
  const grace = expectOk(await content.create("speakers", { name: "Grace", status: "published", rank: 2 })).id;
  const linus = expectOk(await content.create("speakers", { name: "Linus", status: "draft", rank: 3 })).id;
  const lineup = expectOk(await content.create("lineups", { title: "Main", speakers: [ada, grace, linus] })).id;
  const programm = await h.page({ slug: "programm", title: "Programm", status: "published", body: [{ type: "lineup", id: lineup }] });
  expectOk(await content.update("pages", programm, { slug: "program", title: "Program", status: "published", body: [{ type: "lineup", id: lineup }] }, { locale: "en" }));
  const info = await h.page({ slug: "info", title: "Info", status: "published", body: [{ type: "teaser", link: `kestrel:pages:${programm}` }] });
  const kontakt = await h.page({ slug: "kontakt", title: "Kontakt", status: "published", body: [] });
  const entwurf = await h.page({ slug: "entwurf", title: "Entwurf", status: "draft", body: [{ type: "lineup", id: lineup }] });
  for (const id of [programm, info, kontakt, entwurf]) expectOk(await h.delivery.publish("pages", id));
  return { ada, grace, linus, lineup, programm, info, kontakt, entwurf };
}

describe("delivery/static dependencies: what a render records", () => {
  it("records the reads of the render and of its links, never the published document itself", async () => {
    const h = await harness();
    const ids = await seed(h);
    const programm = (await h.row(ids.programm))!;
    expect(programm.state).toBe("live");
    const rows = expectOk(await h.db.findMany<{ id: string; kind: string; depType: string; depId: string | null }>(DEPENDENCIES, { output: programm.id }));
    expect(rows.items.map((r) => `${r.kind} ${r.depType} ${r.depId ?? "-"}`).sort()).toEqual([`document lineups ${ids.lineup}`, `document speakers ${ids.ada}`, `document speakers ${ids.grace}`, `document speakers ${ids.linus}`, "type settings -"].sort());
    expect(programm.depCount).toBe(5);
    const info = (await h.row(ids.info))!;
    const infoRows = expectOk(await h.db.findMany<{ id: string; kind: string; depId: string | null; path: string | null }>(DEPENDENCIES, { output: info.id }));
    expect(infoRows.items.filter((r) => r.kind === "path").map((r) => [r.depId, r.path])).toEqual([[ids.programm, "/programm"]]);
    expect(expectOk(await h.delivery.status("pages", ids.programm)).map((s) => [s.locale, s.state, s.dependencies, s.stale])).toEqual([
      ["de", "live", 5, false],
      ["en", "live", 5, false],
    ]);
  });

  it("a render that did not read its own document through the instance is stored with unknown dependencies, with one warning per type", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(model, db);
    const blind: Renderer = { formats: () => ["html"], render: async (input) => ok({ data: `<h1>${String(input.document.title)}</h1>`, contentType: "text/html", extension: "html" }) };
    const h = await harness({ db, content, renderer: blind });
    const a = await h.page({ slug: "a", title: "A", status: "published" });
    const b = await h.page({ slug: "b", title: "B", status: "published" });
    expectOk(await h.delivery.publish("pages", a));
    expectOk(await h.delivery.publish("pages", b));
    expect((await h.row(a))?.depSet).toBeNull();
    expect(expectOk(await h.delivery.status("pages", a))[0]?.dependencies).toBeNull();
    expect(h.logger.warnings.length).toBe(1);
    expect(expectOk(await h.delivery.readStaleStatus()).unknown).toBe(2);
  });
});

describe("delivery/static dependencies: marking", () => {
  it("a changed speaker marks exactly the published outputs that read it, and raises one job per output", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.content.update("speakers", ids.grace, { name: "Grace H." }));
    expect(expectOk(await h.delivery.markDependents("speakers", [ids.grace]))).toEqual({ marked: 2 });
    expect(await h.marked()).toEqual([`${ids.programm}/de`, `${ids.programm}/en`].sort());
    expect(h.jobs().sort()).toEqual([`${ids.programm}/de`, `${ids.programm}/en`].sort());
    const job = h.emitted.find((e) => e.name === OUTPUT_STALE)!;
    expect(typeof job.data.coalesceKey).toBe("string");
  });

  it("a draft that read the speaker is never marked", async () => {
    const h = await harness();
    const ids = await seed(h);
    expect((await h.row(ids.entwurf))?.state).toBe("draft");
    expectOk(await h.delivery.markDependents("speakers", [ids.ada]));
    expect(await h.marked()).not.toContain(`${ids.entwurf}/de`);
  });

  it("a settings change marks every output that read settings", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("settings", []));
    expect(await h.marked()).toEqual([`${ids.programm}/de`, `${ids.programm}/en`, `${ids.info}/de`, `${ids.kontakt}/de`].sort());
  });

  it("reads the changed ids from id and ids, without a null id", async () => {
    const h = await harness();
    const ids = await seed(h);
    expect(expectOk(await h.delivery.markDependents("speakers", [ids.linus, ids.ada]))).toEqual({ marked: 2 });
    expect(expectOk(await h.delivery.markDependents("lineups", ["unknown-id"]))).toEqual({ marked: 0 });
  });

  it("a link marks its reader only when the target's path or published state changed", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.content.update("pages", ids.programm, { title: "Programm 2027" }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("pages", [ids.programm]));
    expect(await h.marked()).toEqual([]);
    expectOk(await h.content.update("pages", ids.programm, { slug: "programm-2027" }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("pages", [ids.programm]));
    expect(await h.marked()).toEqual([`${ids.info}/de`]);
  });

  it("a withdrawn link target marks its reader", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.content.update("pages", ids.programm, { status: "draft" }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("pages", [ids.programm]));
    expect(await h.marked()).toEqual([`${ids.info}/de`]);
  });

  it("a deleted document marks its readers", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.content.remove("lineups", ids.lineup));
    expectOk(await h.delivery.markDependents("lineups", [ids.lineup]));
    expect(await h.marked()).toEqual([`${ids.programm}/de`, `${ids.programm}/en`].sort());
  });

  it("marks unknown outputs, error rows without a set included, on every change", async () => {
    const h = await harness();
    const ids = await seed(h);
    const kontakt = (await h.row(ids.kontakt))!;
    expectOk(await h.db.updateMany<StatusRow>(STATUS, { id: kontakt.id }, { depSet: null, state: "error" }));
    expectOk(await h.delivery.markDependents("lineups", ["nothing-reads-this"]));
    expect(await h.marked()).toEqual([`${ids.kontakt}/de`]);
  });
});

describe("delivery/static dependencies: the store decides list membership", () => {
  async function listing(h: Harness, filter: Record<string, unknown>) {
    const id = await h.page({ slug: `list-${Math.random().toString(36).slice(2, 8)}`, title: "List", status: "published", body: [{ type: "speakers", filter }] });
    expectOk(await h.delivery.publish("pages", id));
    return id;
  }

  it("a new document that joins a recorded list marks it; one that does not join never does", async () => {
    const h = await harness();
    await seed(h);
    const list = await listing(h, { status: "published" });
    const draft = expectOk(await h.content.create("speakers", { name: "Draft", status: "draft" })).id;
    expectOk(await h.delivery.markDependents("speakers", [draft]));
    expect(await h.marked()).toEqual([]);
    const joined = expectOk(await h.content.create("speakers", { name: "New", status: "published" })).id;
    expectOk(await h.delivery.markDependents("speakers", [joined]));
    expect(await h.marked()).toEqual([`${list}/de`]);
  });

  it("agrees with content.list for like, ne and a numeric string", async () => {
    const h = await harness();
    await seed(h);
    const cases: Array<Record<string, unknown>> = [{ name: { like: "Z%" } }, { status: { ne: "draft" } }, { rank: "7" }, { rank: { gte: 7 } }];
    const lists = new Map<string, Record<string, unknown>>();
    for (const filter of cases) lists.set(await listing(h, filter), filter);
    const candidate = expectOk(await h.content.create("speakers", { name: "Zoe", status: "draft", rank: 7 })).id;
    expectOk(await h.delivery.markDependents("speakers", [candidate]));
    const marked = await h.marked();
    for (const [list, filter] of lists) {
      const member = expectOk(await h.content.list("speakers", { ...filter, id: candidate }, { locale: "de", limit: 1 })).items.length > 0;
      expect(marked.includes(`${list}/de`), JSON.stringify(filter)).toBe(member);
    }
  });

  it("a recorded list constrained to other ids is not asked about a change outside them", async () => {
    const h = await harness();
    const ids = await seed(h);
    const list = await listing(h, { id: { in: [ids.ada, ids.grace] } });
    const other = expectOk(await h.content.create("speakers", { name: "Other", status: "published" })).id;
    expectOk(await h.delivery.markDependents("speakers", [other]));
    expect(await h.marked()).not.toContain(`${list}/de`);
  });

  it("a list the store can no longer answer counts as a match", async () => {
    const h = await harness();
    const ids = await seed(h);
    const list = await listing(h, { status: "published" });
    const listRow = (await h.row(list))!;
    const query = expectOk(await h.db.findMany<{ id: string }>(DEPENDENCIES, { output: listRow.id, kind: "query" })).items[0]!;
    expectOk(await h.db.updateMany(DEPENDENCIES, { id: query.id }, { filter: { vanished: "x" } }));
    expectOk(await h.delivery.markDependents("speakers", [ids.linus]));
    expect(await h.marked()).toContain(`${list}/de`);
  });
});

describe("delivery/static dependencies: marks and renders", () => {
  it("a render clears the mark it covered", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.content.update("speakers", ids.grace, { name: "Grace H." }));
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    expect(expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }))).toEqual({ rendered: true, state: "live" });
    expect(h.html("/programm")).toContain("Ada,Grace H.");
    expect(await h.marked()).toEqual([`${ids.programm}/en`]);
    expect(h.emitted.filter((e) => e.name === LLMS_STALE).map((e) => e.data)).toEqual([{ coalesceKey: "llms" }]);
  });

  it("a mark made during the render survives it", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    expectOk(await h.content.update("speakers", ids.ada, { name: "Ada L." }));
    expectOk(await h.delivery.markDependents("speakers", [ids.ada]));
    held.release();
    expectOk(await rendering);
    expect(await h.marked()).toContain(`${ids.programm}/de`);
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }));
    expect(h.html("/programm")).toContain("Ada L.");
    expect(await h.marked()).not.toContain(`${ids.programm}/de`);
  });

  it("a job for an output that is not marked renders nothing", async () => {
    const h = await harness();
    const ids = await seed(h);
    const before = h.reading.calls.length;
    expect(expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }))).toEqual({ rendered: false, state: "live" });
    expect(h.reading.calls.length).toBe(before);
  });

  it("a job answers TRANSIENT while another render holds the output", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const first = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    expectErr(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }), "TRANSIENT");
    held.release();
    expectOk(await first);
  });

  it("a failed job records the attempt and the backoff on the output and answers an error", async () => {
    const h = await harness({ dependencies: { backoffSeconds: [30, 90] } });
    const ids = await seed(h);
    expectOk(await h.content.update("speakers", ids.grace, { name: "FAIL" }));
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const started = Date.now();
    expectErr(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }), "TRANSIENT");
    const row = (await h.row(ids.programm))!;
    expect(row).toMatchObject({ state: "error", path: "/programm", staleAttempts: 1, staleError: "a speaker made the block fail" });
    expect(row.staleRetryAt! - started).toBeGreaterThanOrEqual(30_000);
    expect(row.staleRetryAt! - started).toBeLessThan(31_000);
    expect(h.html("/programm")).toContain("Grace");
    expect(expectOk(await h.delivery.status("pages", ids.programm))[0]).toMatchObject({ stale: true, staleFailed: false, staleError: "a speaker made the block fail" });
  });

  it("a failed render keeps the reads it made: fixing the new dependency marks the output again", async () => {
    const h = await harness();
    const ids = await seed(h);
    const broken = expectOk(await h.content.create("speakers", { name: "FAIL", status: "published" })).id;
    const second = expectOk(await h.content.create("lineups", { title: "Late", speakers: [broken] })).id;
    expectOk(await h.content.update("pages", ids.kontakt, { body: [{ type: "lineup", id: second }] }, { locale: "de" }));
    const [kontakt] = expectOk(await h.delivery.publish("pages", ids.kontakt));
    expect(kontakt).toMatchObject({ state: "error", error: "a speaker made the block fail" });
    const row = (await h.row(ids.kontakt))!;
    expect(row.depSet).not.toBeNull();
    const recorded = expectOk(await h.db.findMany<{ id: string; kind: string; depType: string; depId: string | null }>(DEPENDENCIES, { output: row.id })).items.map((r) => `${r.kind} ${r.depType} ${r.depId ?? "-"}`);
    expect(recorded).toContain(`document speakers ${broken}`);
    expect(recorded).toContain("type settings -");
    expectOk(await h.delivery.markDependents("speakers", [ids.ada]));
    expect(await h.marked()).not.toContain(`${ids.kontakt}/de`);
    expectOk(await h.content.update("speakers", broken, { name: "Fixed" }));
    expectOk(await h.delivery.markDependents("speakers", [broken]));
    expect(await h.marked()).toContain(`${ids.kontakt}/de`);
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" }));
    expect(h.html("/kontakt")).toContain("Fixed");
  });

  it("a failed render of an unknown output stays unknown", async () => {
    const h = await harness();
    const ids = await seed(h);
    const kontakt = (await h.row(ids.kontakt))!;
    expectOk(await h.db.updateMany<StatusRow>(STATUS, { id: kontakt.id }, { depSet: null, depCount: null }));
    const broken = expectOk(await h.content.create("speakers", { name: "FAIL", status: "published" })).id;
    const lineup = expectOk(await h.content.create("lineups", { title: "Late", speakers: [broken] })).id;
    expectOk(await h.content.update("pages", ids.kontakt, { body: [{ type: "lineup", id: lineup }] }, { locale: "de" }));
    expectOk(await h.delivery.publish("pages", ids.kontakt));
    expect((await h.row(ids.kontakt))?.depSet).toBeNull();
  });
});

function failingOnce(db: FakePersistence, method: "createOne" | "createMany" | "deleteMany" | "updateMany", collection: string, mode: "error" | "throw" = "error"): Persistence & { tripped: () => boolean } {
  let armed = true;
  const trip = <T>(real: () => Promise<T>, name: string, target: string): Promise<T> => {
    if (armed && name === method && target === collection) {
      armed = false;
      if (mode === "throw") return Promise.reject(new Error("process stopped"));
      db.failNext("TRANSIENT");
    }
    return real();
  };
  return {
    ...db,
    createOne: (c, d) => trip(() => db.createOne(c, d), "createOne", c),
    createMany: (c, d) => trip(() => db.createMany(c, d), "createMany", c),
    deleteMany: (c, f) => trip(() => db.deleteMany(c, f), "deleteMany", c),
    updateMany: (c, f, p) => trip(() => db.updateMany(c, f, p), "updateMany", c),
    tripped: () => !armed,
  };
}

async function setKeysExist(db: Persistence, setId: string): Promise<boolean> {
  const set = expectOk(await db.findOne<{ id: string; keys: string[] }>(DEPENDENCY_SETS, { id: setId }));
  if (set === null) return false;
  const rows = expectOk(await db.count(DEPENDENCIES, { id: { in: set.keys } }));
  return rows === set.keys.length;
}

describe("delivery/static dependencies: a render that loses its compare-and-swap", () => {
  it("an unpublish during the render: the late render's file does not remain and the row is never live again", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    expect(expectOk(await h.delivery.unpublish("pages", ids.programm))).toBe(2);
    expect(h.html("/programm")).toBeNull();
    held.release();
    expectOk(await rendering);
    expect(h.html("/programm")).toBeNull();
    expect((await h.row(ids.programm))?.state).toBe("deleted");
    expect(expectOk(await h.delivery.status("pages", ids.programm))).toEqual([]);
  });

  it("an unpublish while the first render of a new page is in flight: its file does not remain", async () => {
    const h = await harness();
    await seed(h);
    const fresh = await h.page({ slug: "neu", title: "Neu", status: "published", body: [] });
    const held = h.reading.hold(fresh);
    const rendering = h.delivery.publish("pages", fresh);
    await held.reached;
    expect(await h.row(fresh)).toBeNull();
    expectOk(await h.delivery.unpublish("pages", fresh));
    held.release();
    expectOk(await rendering);
    expect(h.html("/neu")).toBeNull();
    expect((await h.row(fresh))?.state).toBe("deleted");
  });

  it("an unpublish and its sweep during the render: the late render finds no row and removes its file", async () => {
    const h = await harness({ dependencies: { claimTtlSeconds: 120 } });
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    expectOk(await h.delivery.unpublish("pages", ids.programm));
    h.advance(121_000);
    expect(expectOk(await h.delivery.resumeStale()).swept).toBeGreaterThanOrEqual(2);
    expect(await h.row(ids.programm)).toBeNull();
    held.release();
    expectOk(await rendering);
    expect(h.html("/programm")).toBeNull();
    expect(await h.row(ids.programm)).toBeNull();
  });

  it("a switch to draft during the render: the draft wins and the late file is removed", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    expectOk(await h.content.update("pages", ids.programm, { status: "draft" }, { locale: "de" }));
    expectOk(await h.delivery.publish("pages", ids.programm));
    held.release();
    expectOk(await rendering);
    expect(h.html("/programm")).toBeNull();
    expect((await h.row(ids.programm))?.state).toBe("draft");
  });

  it("a slug change during the render of the old slug: the old directory is gone afterwards", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    expectOk(await h.content.update("pages", ids.programm, { slug: "programm-neu" }, { locale: "de" }));
    expectOk(await h.delivery.publish("pages", ids.programm));
    held.release();
    expectOk(await rendering);
    expect(h.html("/programm")).toBeNull();
    expect(h.html("/programm-neu")).toContain("Programm");
    expect((await h.row(ids.programm))).toMatchObject({ state: "live", path: "/programm-neu" });
  });

  it("a newer render of the same path won: the loser may have overwritten it, so the output is marked again", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    expectOk(await h.content.update("speakers", ids.grace, { name: "Grace New" }));
    expectOk(await h.delivery.publish("pages", ids.programm));
    expect(h.html("/programm")).toContain("Grace New");
    held.release();
    expectOk(await rendering);
    expect(h.html("/programm")).not.toContain("Grace New");
    expect(await h.marked()).toContain(`${ids.programm}/de`);
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }));
    expect(h.html("/programm")).toContain("Grace New");
  });

  it("a newer render failed and kept the path: the loser marks the output again", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    expectOk(await h.content.update("speakers", ids.grace, { name: "FAIL" }));
    const [failed] = expectOk(await h.delivery.publish("pages", ids.programm));
    expect(failed).toMatchObject({ state: "error", path: "/programm" });
    const tokenBefore = (await h.row(ids.programm))?.staleToken;
    held.release();
    expectOk(await rendering);
    expect(h.html("/programm")).not.toBeNull();
    const after = (await h.row(ids.programm))!;
    expect(after.staleToken).not.toBeNull();
    expect(after.staleToken).not.toBe(tokenBefore);
  });

  it("two concurrent renders of one output: no CONFLICT, and exactly one complete dependency set remains", async () => {
    const h = await harness();
    const ids = await seed(h);
    const held = h.reading.hold(ids.kontakt);
    const first = h.delivery.publish("pages", ids.kontakt);
    await held.reached;
    expectOk(await h.delivery.publish("pages", ids.kontakt));
    held.release();
    expectOk(await first);
    const row = (await h.row(ids.kontakt))!;
    const sets = expectOk(await h.db.findMany<{ id: string }>(DEPENDENCY_SETS, { output: row.id }));
    expect(sets.items.map((s) => s.id)).toEqual([row.depSet]);
    expect(await setKeysExist(h.db, row.depSet!)).toBe(true);
  });
});

describe("delivery/static dependencies: dependency sets survive failures", () => {
  it("the dependency rows cannot be written: the output becomes unknown and nothing of the set is left", async () => {
    const fake = createFakePersistence();
    const db = failingOnce(fake, "createMany", DEPENDENCIES);
    const h = await harness({ db, content: await createContentDefault(model, fake) });
    const ids = await seed(h);
    expect(db.tripped()).toBe(true);
    const unknown = expectOk(await fake.findMany<StatusRow>(STATUS, { depSet: null, state: "live" })).items;
    expect(unknown.length).toBe(1);
    const leftover = expectOk(await fake.findMany<{ id: string }>(DEPENDENCY_SETS, { output: unknown[0]!.id }));
    expect(leftover.items).toEqual([]);
    expect(ids.programm).toBeDefined();
  });

  it("the set row cannot be written: the output becomes unknown and no dependency row exists without a set", async () => {
    const fake = createFakePersistence();
    const db = failingOnce(fake, "createOne", DEPENDENCY_SETS);
    const h = await harness({ db, content: await createContentDefault(model, fake) });
    await seed(h);
    const sets = expectOk(await fake.findMany<{ id: string; keys: string[] }>(DEPENDENCY_SETS, {})).items;
    const listed = new Set(sets.flatMap((s) => s.keys));
    const rows = expectOk(await fake.findMany<{ id: string }>(DEPENDENCIES, {})).items;
    expect(rows.every((r) => listed.has(r.id))).toBe(true);
    expect(expectOk(await fake.count(STATUS, { depSet: null, state: "live" }))).toBe(1);
  });

  it("the process stops after the set row: the output keeps its previous complete set, and the sweep removes the orphan", async () => {
    const fake = createFakePersistence();
    const h0 = await harness({ db: fake, dependencies: { claimTtlSeconds: 120 } });
    const ids = await seed(h0);
    const before = (await h0.row(ids.programm))!;
    const db = failingOnce(fake, "createMany", DEPENDENCIES, "throw");
    const h = await harness({ db, content: h0.content, blobs: h0.blobs, dependencies: { claimTtlSeconds: 120 } });
    await expect(h.delivery.publish("pages", ids.programm)).rejects.toThrow("process stopped");
    const after = (await h.row(ids.programm))!;
    expect(after.depSet).toBe(before.depSet);
    expect(await setKeysExist(fake, after.depSet!)).toBe(true);
    expect(expectOk(await fake.count(DEPENDENCY_SETS, { output: after.id }))).toBe(2);
    h.advance(121_000);
    expect(expectOk(await h.delivery.resumeStale()).swept).toBe(1);
    expect(expectOk(await fake.findMany<{ id: string }>(DEPENDENCY_SETS, { output: after.id })).items.map((s) => s.id)).toEqual([after.depSet]);
  });

  it("the previous set cannot be removed after the swap: the row has the new complete set, and the sweep removes the old one", async () => {
    const fake = createFakePersistence();
    const h0 = await harness({ db: fake, dependencies: { claimTtlSeconds: 120 } });
    const ids = await seed(h0);
    const before = (await h0.row(ids.programm))!;
    const db = failingOnce(fake, "deleteMany", DEPENDENCIES);
    const h = await harness({ db, content: h0.content, blobs: h0.blobs, dependencies: { claimTtlSeconds: 120 } });
    expectOk(await h.delivery.publish("pages", ids.programm));
    expect(db.tripped()).toBe(true);
    const after = (await h.row(ids.programm))!;
    expect(after.depSet).not.toBe(before.depSet);
    expect(await setKeysExist(fake, after.depSet!)).toBe(true);
    h.advance(121_000);
    expectOk(await h.delivery.resumeStale());
    expect(expectOk(await fake.findMany<{ id: string }>(DEPENDENCY_SETS, { output: after.id })).items.map((s) => s.id)).toEqual([after.depSet]);
    const set = expectOk(await fake.findOne<{ id: string; keys: string[] }>(DEPENDENCY_SETS, { id: after.depSet! }))!;
    expect(expectOk(await fake.count(DEPENDENCIES, { output: after.id }))).toBe(set.keys.length);
  });
});

describe("delivery/static dependencies: the render timeout", () => {
  it("a render that never resolves fails at the timeout and the next marked output still renders", async () => {
    const h = await harness({ render: "background", dependencies: { renderTimeoutSeconds: 1, claimTtlSeconds: 5, maxAttempts: 1 } });
    const ids = await seed(h);
    expectOk(await h.content.update("speakers", ids.grace, { name: "HANG" }));
    expectOk(await h.content.set("settings", { title: "Festival 2027" }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("settings", []));
    const deadline = Date.now() + 5000;
    while (!(h.html("/kontakt") ?? "").includes("Festival 2027") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(h.html("/kontakt")).toContain("Festival 2027");
    while ((await h.row(ids.programm))?.staleError === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(await h.row(ids.programm)).toMatchObject({ state: "error", path: "/programm", staleError: "render timed out after 1s" });
    expect(expectOk(await h.delivery.readStaleStatus()).abandoned).toBeGreaterThanOrEqual(1);
  }, 10_000);
});

function countingBlobs(): ReturnType<typeof memoryBlobs> & { llmsWrites: () => number } {
  const inner = memoryBlobs();
  let llms = 0;
  return {
    ...inner,
    files: inner.files,
    async put(key, data, options) {
      if (key === "site/llms.txt") llms += 1;
      return inner.put(key, data, options);
    },
    llmsWrites: () => llms,
  };
}

describe("delivery/static dependencies: the background loop", () => {
  it("renders marked outputs after the marking call returned, never inside it", async () => {
    const h = await harness({ render: "background" });
    const ids = await seed(h);
    expectOk(await h.content.update("speakers", ids.grace, { name: "Grace H." }));
    const held = h.reading.hold(ids.programm);
    const marking = h.delivery.markDependents("speakers", [ids.grace]);
    expect(expectOk(await marking)).toEqual({ marked: 2 });
    await held.reached;
    expect(h.html("/programm")).not.toContain("Grace H.");
    held.release();
    await h.settle();
    expect(h.html("/programm")).toContain("Grace H.");
    expect(h.html("/en/program")).toContain("Grace H.");
  });

  it("starts lazily: a mark written by another process waits for a wake, which the recovery pass gives", async () => {
    const h = await harness({ render: "background" });
    const ids = await seed(h);
    const row = (await h.row(ids.kontakt))!;
    const at = Date.now();
    expectOk(await h.db.updateMany<StatusRow>(STATUS, { id: row.id }, { staleToken: "elsewhere", staleAt: at, staleRetryAt: at, staleAttempts: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await h.marked()).toEqual([`${ids.kontakt}/de`]);
    h.advance(61_000);
    expect(expectOk(await h.delivery.resumeStale()).dispatched).toBe(1);
    await h.settle();
    expect(await h.marked()).toEqual([]);
  });

  it("is single-flight: however many wakes arrive, one render runs at a time", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(model, db);
    let running = 0;
    let most = 0;
    const slow: Renderer = {
      formats: () => ["html"],
      async render(input) {
        running += 1;
        most = Math.max(most, running);
        expectOk(await content.get("pages", input.id, { locale: input.locale ?? "de" }));
        expectOk(await content.get("settings", undefined, { locale: input.locale ?? "de" }));
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return ok({ data: `<h1>${String(input.document.title)}</h1>`, contentType: "text/html", extension: "html" });
      },
    };
    const h = await harness({ render: "background", db, content, renderer: slow });
    for (let i = 0; i < 6; i++) expectOk(await h.delivery.publish("pages", await h.page({ slug: `p${i}`, title: `P${i}`, status: "published" })));
    most = 0;
    for (let i = 0; i < 5; i++) expectOk(await h.delivery.markDependents("settings", []));
    await h.settle();
    expect(most).toBe(1);
  });

  it("backs off after a failed render and stops at maxAttempts", async () => {
    const h = await harness({ render: "background", dependencies: { maxAttempts: 2, backoffSeconds: [1] } });
    const ids = await seed(h);
    expectOk(await h.content.update("speakers", ids.grace, { name: "FAIL" }));
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const deadline = Date.now() + 5000;
    const calls = () => h.reading.calls.filter((c) => c === `${ids.programm}/de`).length;
    const initial = calls();
    while (expectOk(await h.delivery.readStaleStatus()).failed < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(calls() - initial).toBe(2);
    expect(expectOk(await h.delivery.readStaleStatus())).toMatchObject({ failed: 2, stale: 0 });
    expect(expectOk(await h.delivery.status("pages", ids.programm))[0]).toMatchObject({ stale: true, staleFailed: true, state: "error" });
    await new Promise((r) => setTimeout(r, 1200));
    expectOk(await h.delivery.requestLlms());
    await new Promise((r) => setTimeout(r, 100));
    expect(calls() - initial).toBe(2);
  }, 10_000);

  it("runs detached from the caller's async context: a scope open around the marking call sees none of the loop's reads", async () => {
    const h = await harness({ render: "background" });
    const ids = await seed(h);
    const held = h.reading.hold(ids.programm);
    const { reads } = await observeReads(async () => {
      expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
      await held.reached;
    });
    expect(reads.filter((r) => r.kind === "document" && (r.type === "speakers" || r.type === "lineups" || r.id === ids.programm))).toEqual([]);
    held.release();
    await h.settle();
    expect((await h.row(ids.programm))?.depCount).toBe(5);
  });

  it("two instances on one database render every marked output exactly once", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(model, db);
    const blobs = memoryBlobs();
    const rendered = new Map<string, number>();
    const counting: Renderer = {
      formats: () => ["html"],
      async render(input) {
        rendered.set(`${input.id}/${input.locale ?? ""}`, (rendered.get(`${input.id}/${input.locale ?? ""}`) ?? 0) + 1);
        expectOk(await content.get("pages", input.id, { locale: input.locale ?? "de" }));
        expectOk(await content.get("settings", undefined, { locale: input.locale ?? "de" }));
        await new Promise((resolve) => setTimeout(resolve, 3));
        return ok({ data: `<h1>${String(input.document.title)}</h1>`, contentType: "text/html", extension: "html" });
      },
    };
    const one = await harness({ render: "background", db, content, blobs, renderer: counting });
    const two = await harness({ render: "background", db, content, blobs, renderer: counting });
    for (let i = 0; i < 12; i++) expectOk(await one.delivery.publish("pages", await one.page({ slug: `p${i}`, title: `P${i}`, status: "published" })));
    await one.settle();
    rendered.clear();
    expectOk(await one.delivery.markDependents("settings", []));
    expectOk(await two.delivery.requestLlms());
    await one.settle();
    await two.settle();
    expect(rendered.size).toBe(12);
    expect([...rendered.values()].every((n) => n === 1)).toBe(true);
    const claims = expectOk(await db.count(STATUS, { claimedBy: { ne: null } }));
    expect(claims).toBe(0);
  });

  it("close waits for the render in progress and nothing renders afterwards", async () => {
    const h = await harness({ render: "background" });
    const ids = await seed(h);
    const held = h.reading.hold(ids.programm);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    await held.reached;
    let closed = false;
    const closing = h.delivery.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    held.release();
    await closing;
    const calls = h.reading.calls.length;
    expectOk(await h.delivery.markDependents("settings", []));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.reading.calls.length).toBe(calls);
  });

  it("exports llms.txt once when the backlog drains, not once per render", async () => {
    const blobs = countingBlobs();
    const h = await harness({ render: "background", blobs });
    await seed(h);
    await h.settle();
    const before = blobs.llmsWrites();
    expectOk(await h.content.set("settings", { title: "Festival 2027" }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("settings", []));
    expectOk(await h.delivery.requestLlms());
    await h.settle();
    const deadline = Date.now() + 2000;
    while (blobs.llmsWrites() === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    expect(blobs.llmsWrites() - before).toBe(1);
    expect(blobs.files.get("site/llms.txt")).toContain("# Festival 2027");
  });
});

describe("delivery/static dependencies: jobs through events@1", () => {
  it("requestLlms raises one coalesced llmsStale and exports nothing itself", async () => {
    const blobs = countingBlobs();
    const h = await harness({ blobs });
    await seed(h);
    expectOk(await h.delivery.requestLlms());
    expect(h.emitted.filter((e) => e.name === LLMS_STALE).map((e) => e.data)).toEqual([{ coalesceKey: "llms" }]);
    expect(blobs.llmsWrites()).toBe(0);
  });

  it("a job raise that fails answers TRANSIENT", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(model, db);
    const site = createSiteDefault(content);
    const failingEvents: Events = { emit: () => Promise.reject(new Error("queue down")), on: () => () => {} };
    const reading = readingRenderer(content);
    const delivery = await createDeliveryStatic(configSchema.parse({ types: { pages: {} }, prefix: "site/", dependencies: { render: "events" } }), { content, site, renderer: reading.renderer, blobs: memoryBlobs(), db, logger: recordingLogger(), events: failingEvents });
    instances.push(delivery);
    const id = expectOk(await content.create("pages", { slug: "a", title: "A", status: "published" }, { locale: "de" })).id;
    expectOk(await delivery.publish("pages", id));
    expectErr(await delivery.markAll("pages"), "TRANSIENT");
  });
});

describe("delivery/static dependencies: markAll, checkBuild and the recovery pass", () => {
  it("markAll marks every output, creates a marked draft row for a document never delivered, and never renders a draft", async () => {
    const h = await harness({ render: "background" });
    const ids = await seed(h);
    const never = await h.page({ slug: "nie", title: "Nie", status: "published" });
    const counted = expectOk(await h.delivery.markAll("pages"));
    expect(counted.marked).toBe(10);
    await h.settle();
    expect(h.html("/nie")).toContain("Nie");
    expect(h.html("/entwurf")).toBeNull();
    expect((await h.row(ids.entwurf))?.state).toBe("draft");
    expect((await h.row(never, "en"))?.state).toBe("draft");
  });

  it("checkBuild marks everything once per new build and stores the build only after marking succeeded", async () => {
    const fake = createFakePersistence();
    const content = await createContentDefault(model, fake);
    const h0 = await harness({ db: fake, content });
    await seed(h0);
    let failList = true;
    const flaky: Content = {
      ...content,
      list: (type, filter, options) => {
        if (failList && type === "pages" && filter !== undefined && Object.keys(filter).length === 0) {
          failList = false;
          return Promise.resolve(err(failure("TRANSIENT", "store busy")));
        }
        return content.list(type, filter, options);
      },
    };
    const h = await harness({ db: fake, content: flaky });
    expectErr(await h.delivery.checkBuild("build-2"), "TRANSIENT");
    expect(expectOk(await fake.findOne(STATE, { id: "build" }))).toBeNull();
    const first = expectOk(await h.delivery.checkBuild("build-2"));
    expect(first.changed).toBe(true);
    expect(first.marked).toBeGreaterThanOrEqual(8);
    expect(expectOk(await fake.findOne<{ id: string; value: string }>(STATE, { id: "build" }))?.value).toBe("build-2");
    expect(expectOk(await h.delivery.checkBuild("build-2"))).toEqual({ changed: false, marked: 0 });
    expect(expectOk(await h.delivery.checkBuild("build-3")).changed).toBe(true);
  });

  it("the recovery pass releases expired claims and re-raises only due, unclaimed marks older than a minute", async () => {
    const h = await harness({ dependencies: { maxAttempts: 3, claimTtlSeconds: 120 } });
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("settings", []));
    const programm = (await h.row(ids.programm))!;
    const info = (await h.row(ids.info))!;
    const kontakt = (await h.row(ids.kontakt))!;
    const at = Date.now();
    expectOk(await h.db.updateMany<StatusRow>(STATUS, { id: programm.id }, { claimedBy: "old", claimedAt: at }));
    expectOk(await h.db.updateMany<StatusRow>(STATUS, { id: info.id }, { staleRetryAt: at + 3_600_000 }));
    expectOk(await h.db.updateMany<StatusRow>(STATUS, { id: kontakt.id }, { staleAttempts: 3 }));
    h.emitted.length = 0;
    expect(expectOk(await h.delivery.resumeStale())).toMatchObject({ released: 0, dispatched: 0 });
    h.advance(61_000);
    expect(expectOk(await h.delivery.resumeStale())).toMatchObject({ released: 0, dispatched: 1 });
    expect(h.jobs()).toEqual([`${ids.programm}/en`]);
    h.advance(120_000);
    h.emitted.length = 0;
    const later = expectOk(await h.delivery.resumeStale());
    expect(later).toMatchObject({ released: 1, dispatched: 2 });
    expect(h.jobs().sort()).toEqual([`${ids.programm}/de`, `${ids.programm}/en`].sort());
  });

  it("maxAgeSeconds marks live outputs rendered longer ago", async () => {
    const h = await harness({ dependencies: { maxAgeSeconds: 3600 } });
    await seed(h);
    expect(expectOk(await h.delivery.resumeStale()).aged).toBe(0);
    h.advance(3_601_000);
    expect(expectOk(await h.delivery.resumeStale()).aged).toBe(4);
  });

  it("retryStale gives failed outputs their attempts back and raises their jobs again", async () => {
    const h = await harness({ dependencies: { maxAttempts: 1 } });
    const ids = await seed(h);
    expectOk(await h.content.update("speakers", ids.grace, { name: "FAIL" }));
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    expectErr(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }), "TRANSIENT");
    expect(expectOk(await h.delivery.readStaleStatus())).toMatchObject({ failed: 1, stale: 1 });
    h.emitted.length = 0;
    expect(expectOk(await h.delivery.retryStale())).toEqual({ retried: 1 });
    expect(h.jobs()).toEqual([`${ids.programm}/de`]);
    expect(expectOk(await h.delivery.readStaleStatus())).toMatchObject({ failed: 0, stale: 2 });
  });

  it("readStaleStatus counts waiting, failed, rendering and unknown outputs and the oldest mark", async () => {
    const h = await harness();
    const ids = await seed(h);
    expect(expectOk(await h.delivery.readStaleStatus())).toEqual({ stale: 0, failed: 0, rendering: 0, unknown: 0, oldestStaleAt: null, abandoned: 0 });
    const kontakt = (await h.row(ids.kontakt))!;
    expectOk(await h.db.updateMany<StatusRow>(STATUS, { id: kontakt.id }, { depSet: null }));
    const before = Date.now();
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    const status = expectOk(await h.delivery.readStaleStatus());
    expect(status).toMatchObject({ stale: 3, failed: 0, rendering: 1, unknown: 1, abandoned: 0 });
    expect(status.oldestStaleAt).toBeGreaterThanOrEqual(before);
    held.release();
    expectOk(await rendering);
  });
});
