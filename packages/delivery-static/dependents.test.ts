import { afterEach, describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import type { EventData, Events } from "@michaelthielemann/kestrel-contracts/events";
import type { Document, Filter, FindOptions, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { renderFailed } from "@michaelthielemann/kestrel-contracts/helpers/renderer";
import type { Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { createFakePersistence, type FakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createSiteDefault } from "@michaelthielemann/kestrel-site-default/impl";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { observeReads } from "@michaelthielemann/kestrel/reads";
import { CHANGES, DEPENDENCIES, DEPENDENCY_SETS, LLMS_STALE, OUTPUT_STALE, STATE, STATUS, createDeliveryStatic, keyFor, type Delivery, type StatusRow } from "./impl.ts";
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
  const nextHolds: Array<ReturnType<typeof gate>> = [];
  let delayMs = 0;
  const pause = async (id: string): Promise<void> => {
    const hold = holds.get(id) ?? nextHolds.shift();
    if (hold === undefined) return;
    holds.delete(id);
    hold.arrive();
    await hold.wait;
  };
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
            if (speaker.name === "FAIL") {
              await pause(input.id);
              return err(renderFailed("a speaker made the block fail"));
            }
            if (speaker.name === "HANG") await new Promise(() => {});
            names.push(String(speaker.name));
          }
        }
        if (block.type === "page" && block.id !== undefined) {
          const other = expectOk(await content.get("pages", block.id, input.locale === undefined ? {} : { locale: input.locale }));
          names.push(typeof other?.title === "string" ? other.title : "");
        }
        if (block.type === "speakers") {
          const listed = expectOk(await content.list("speakers", block.filter ?? {}, { sort: { name: "asc" } }));
          names.push(...listed.items.map((s) => String(s.name)));
        }
      }
      await pause(input.id);
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
    holdNext(): Gate {
      const g = gate();
      nextHolds.push(g);
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

function failingRemoveOnce(blobs: ReturnType<typeof memoryBlobs>, key: string): ReturnType<typeof memoryBlobs> {
  let armed = true;
  return {
    ...blobs,
    async remove(k) {
      if (armed && k === key) {
        armed = false;
        return err(failure("TRANSIENT", "disk unavailable"));
      }
      return blobs.remove(k);
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
  formats?: string[];
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
  const config = configSchema.parse({ types: { pages: {} }, prefix: "site/", ...(options.formats ? { formats: options.formats } : {}), dependencies: { render: options.render ?? "events", rendererReadsDocument: true, ...options.dependencies } });
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

describe("delivery/static dependencies: cycles and repeated build checks", () => {
  it("two pages that show each other: saving one renders the other once, and that render marks nothing", async () => {
    const h = await harness();
    await seed(h);
    const a = await h.page({ slug: "a", title: "A", status: "published", body: [] });
    const b = await h.page({ slug: "b", title: "B", status: "published", body: [{ type: "page", id: a }] });
    expectOk(await h.content.update("pages", a, { body: [{ type: "page", id: b }] }, { locale: "de" }));
    expectOk(await h.delivery.publish("pages", a));
    expectOk(await h.delivery.publish("pages", b));
    expectOk(await h.content.update("pages", a, { title: "A2" }, { locale: "de" }));
    expectOk(await h.delivery.publish("pages", a));
    h.emitted.length = 0;
    expectOk(await h.delivery.markDependents("pages", [a]));
    expect(h.jobs()).toEqual([`${b}/de`]);
    const calls = h.reading.calls.length;
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: b, locale: "de" }));
    expect(h.reading.calls.slice(calls)).toEqual([`${b}/de`]);
    expect(h.html("/b")).toContain("A2");
    expect(h.emitted.filter((e) => e.name !== LLMS_STALE).map((e) => e.name)).toEqual([OUTPUT_STALE]);
    expect(await h.marked()).toEqual([]);
  });

  it("two processes that see a new build both mark, and every output is rendered and the build stored", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault(model, db);
    const blobs = memoryBlobs();
    const one = await harness({ render: "background", db, content, blobs });
    const two = await harness({ render: "background", db, content, blobs });
    const ids = await seed(one);
    await one.settle();
    const [first, second] = await Promise.all([one.delivery.checkBuild("build-9"), two.delivery.checkBuild("build-9")]);
    expect(expectOk(first).changed || expectOk(second).changed).toBe(true);
    await one.settle();
    await two.settle();
    expect(expectOk(await db.findOne<{ id: string; value: string }>(STATE, { id: "build" }))?.value).toBe("build-9");
    expect(expectOk(await one.delivery.checkBuild("build-9"))).toEqual({ changed: false, marked: 0 });
    expect(one.html("/programm")).toContain("Programm");
    expect(one.html("/entwurf")).toBeNull();
    expect((await one.row(ids.programm))?.depSet).not.toBeNull();
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

  it("a change marked while a render that newly reads the document is still running marks that output too", async () => {
    const h = await harness();
    const ids = await seed(h);
    const fresh = expectOk(await h.content.create("speakers", { name: "Hedy", status: "published" })).id;
    const lineup = expectOk(await h.content.create("lineups", { title: "Late", speakers: [fresh] })).id;
    expectOk(await h.content.update("pages", ids.kontakt, { body: [{ type: "lineup", id: lineup }] }, { locale: "de" }));
    const held = h.reading.hold(ids.kontakt);
    const publishing = h.delivery.publish("pages", ids.kontakt);
    await held.reached;
    expectOk(await h.content.update("speakers", fresh, { name: "Hedy L." }));
    expectOk(await h.delivery.markDependents("speakers", [fresh]));
    held.release();
    expectOk(await publishing);
    expect(h.html("/kontakt")).toContain("Hedy");
    expect(await h.marked()).toContain(`${ids.kontakt}/de`);
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" }));
    expect(h.html("/kontakt")).toContain("Hedy L.");
  });

  it("a change the running render did not read leaves its output unmarked", async () => {
    const h = await harness();
    const ids = await seed(h);
    const held = h.reading.hold(ids.kontakt);
    const publishing = h.delivery.publish("pages", ids.kontakt);
    await held.reached;
    expectOk(await h.content.update("speakers", ids.ada, { name: "Ada L." }));
    expectOk(await h.delivery.markDependents("speakers", [ids.ada]));
    held.release();
    expectOk(await publishing);
    expect(await h.marked()).not.toContain(`${ids.kontakt}/de`);
  });

  it("the same holds for the first render of a page that has no status row yet", async () => {
    const h = await harness();
    await seed(h);
    const fresh = expectOk(await h.content.create("speakers", { name: "Hedy", status: "published" })).id;
    const lineup = expectOk(await h.content.create("lineups", { title: "Late", speakers: [fresh] })).id;
    const neu = await h.page({ slug: "neu", title: "Neu", status: "published", body: [{ type: "lineup", id: lineup }] });
    const held = h.reading.hold(neu);
    const publishing = h.delivery.publish("pages", neu);
    await held.reached;
    expectOk(await h.content.update("speakers", fresh, { name: "Hedy L." }));
    expectOk(await h.delivery.markDependents("speakers", [fresh]));
    held.release();
    expectOk(await publishing);
    expect(await h.marked()).toContain(`${neu}/de`);
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

describe("delivery/static dependencies: the change sequence cannot be bumped", () => {
  it("markDependents answers the error, marks nothing, and a later call recovers", async () => {
    const fake = createFakePersistence();
    const db = failingOnce(fake, "updateMany", STATE);
    const h = await harness({ db });
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("pages", []));
    expect(db.tripped()).toBe(false);
    expectErr(await h.delivery.markDependents("speakers", [ids.grace]), "TRANSIENT");
    expect(db.tripped()).toBe(true);
    expect(await h.marked()).toEqual([]);
    expect(expectOk(await h.delivery.markDependents("speakers", [ids.grace]))).toEqual({ marked: 2 });
    expect(await h.marked()).toEqual([`${ids.programm}/de`, `${ids.programm}/en`].sort());
  });
});

describe("delivery/static dependencies: a failed render whose own rows cannot be written", () => {
  it("leaves the previous set's rows in place until its status write, and the output then counts as unknown", async () => {
    const fake = createFakePersistence();
    const content = await createContentDefault(model, fake);
    const h0 = await harness({ db: fake, content });
    const ids = await seed(h0);
    const before = (await h0.row(ids.programm))!;
    const failing = failingOnce(fake, "createMany", DEPENDENCIES);
    const db = pausingSwaps(fake);
    const h = await harness({ db: { ...db, createMany: (c, d) => failing.createMany(c, d) }, content, blobs: h0.blobs });
    expectOk(await content.update("speakers", ids.grace, { name: "FAIL" }));
    const swap = db.pauseNextSwap();
    const publishing = h.delivery.publish("pages", ids.programm);
    await swap.reached;
    expect(failing.tripped()).toBe(true);
    expect(await setKeysExist(fake, before.depSet!)).toBe(true);
    swap.release();
    const [de] = expectOk(await publishing);
    expect(de).toMatchObject({ state: "error", dependencies: null });
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

  it("a rebuild after the format list shrank removes the keys the previous build wrote but the new one does not", async () => {
    const fake = createFakePersistence();
    const content = await createContentDefault(model, fake);
    const renderer: Renderer = {
      formats: () => ["html", "json"],
      async render(input) {
        return ok({ data: `<h1>${String(input.document.title)}</h1>`, contentType: "text/html", extension: input.format });
      },
    };
    const wide = await harness({ db: fake, content, renderer, formats: ["html", "json"], render: "background" });
    const page = await wide.page({ slug: "seite", title: "Seite", status: "published", body: [] });
    expectOk(await wide.delivery.publish("pages", page));
    expect(wide.blobs.files.has("site/seite/index.json")).toBe(true);
    await wide.delivery.close();

    const narrow = await harness({ db: fake, content, blobs: wide.blobs, renderer, formats: ["html"], render: "background" });
    expectOk(await narrow.delivery.markAll("pages"));
    await narrow.settle();
    expect(narrow.blobs.files.has("site/seite/index.json")).toBe(false);
    expect(narrow.blobs.files.has("site/seite/index.html")).toBe(true);
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

function pausingSwaps(fake: FakePersistence): Persistence & { pauseNextSwap(): Gate } {
  let pending: ReturnType<typeof gate> | null = null;
  return {
    ...fake,
    updateMany: async (c, f, p) => {
      if (pending !== null && c === STATUS && "version" in f) {
        const g = pending;
        pending = null;
        g.arrive();
        await g.wait;
      }
      return fake.updateMany(c, f, p);
    },
    pauseNextSwap() {
      const g = gate();
      pending = g;
      return g;
    },
  };
}

describe("delivery/static dependencies: a newer write that loses to an older render", () => {
  it("the page's own publish of a new slug loses to an older re-render: the output is marked and ends at the new slug", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const older = h.reading.hold(ids.programm);
    const rerender = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await older.reached;
    expectOk(await h.content.update("pages", ids.programm, { slug: "programm-neu", title: "Programm Neu" }, { locale: "de" }));
    const newer = h.reading.hold(ids.programm);
    const own = h.delivery.publish("pages", ids.programm);
    await newer.reached;
    older.release();
    expectOk(await rerender);
    newer.release();
    const [de] = expectOk(await own);
    expect(de).toMatchObject({ stale: true });
    expect(await h.marked()).toContain(`${ids.programm}/de`);
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }));
    expect(h.html("/programm")).toBeNull();
    expect(h.html("/programm-neu")).toContain("Programm Neu");
    expect(await h.row(ids.programm)).toMatchObject({ state: "live", path: "/programm-neu" });
  });

  it("the page's own switch to draft loses to an older re-render: the output is marked and the withdrawn file removed", async () => {
    const fake = createFakePersistence();
    const db = pausingSwaps(fake);
    const h = await harness({ db, content: await createContentDefault(model, fake) });
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const older = h.reading.hold(ids.programm);
    const rerender = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await older.reached;
    expectOk(await h.content.update("pages", ids.programm, { status: "draft" }, { locale: "de" }));
    const swap = db.pauseNextSwap();
    const own = h.delivery.publish("pages", ids.programm);
    await swap.reached;
    older.release();
    expectOk(await rerender);
    swap.release();
    expectOk(await own);
    expect(await h.marked()).toContain(`${ids.programm}/de`);
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }));
    expect(h.html("/programm")).toBeNull();
    expect((await h.row(ids.programm))?.state).toBe("draft");
  });
});

describe("delivery/static dependencies: overlapping changes across processes", () => {
  it("a render in one process that newly reads a document another process changed and marked meanwhile marks its output", async () => {
    const h = await harness();
    const ids = await seed(h);
    const other = await harness({ db: h.db, content: h.content, blobs: h.blobs });
    const fresh = expectOk(await h.content.create("speakers", { name: "Hedy", status: "published" })).id;
    const lineup = expectOk(await h.content.create("lineups", { title: "Late", speakers: [fresh] })).id;
    expectOk(await h.content.update("pages", ids.kontakt, { body: [{ type: "lineup", id: lineup }] }, { locale: "de" }));
    const held = h.reading.hold(ids.kontakt);
    const publishing = h.delivery.publish("pages", ids.kontakt);
    await held.reached;
    expectOk(await h.content.update("speakers", fresh, { name: "Hedy L." }));
    expectOk(await other.delivery.markDependents("speakers", [fresh]));
    held.release();
    expectOk(await publishing);
    expect(await h.marked()).toContain(`${ids.kontakt}/de`);
  });

  it("a change recorded before a render started never marks that render's output again", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.content.update("speakers", ids.grace, { name: "Grace H." }));
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }));
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "en" }));
    expect(await h.marked()).toEqual([]);
    expect(h.html("/programm")).toContain("Grace H.");
  });
});

describe("delivery/static dependencies: rows the loop cannot render", () => {
  it("a row whose locale left the model is never marked, and the other rows render", async () => {
    const h = await harness({ render: "background" });
    const ids = await seed(h);
    const at = Date.now() - 1000;
    expectOk(await h.db.createOne<StatusRow>(STATUS, { id: `pages/${ids.programm}/fr`, type: "pages", docId: ids.programm, locale: "fr", state: "live", path: "/fr/programm", error: null, publishedAt: at, updatedAt: at, version: 0, depSet: null, depCount: null, staleAt: null, staleToken: null, staleRetryAt: null, staleAttempts: 0, staleError: null, claimedBy: null, claimedAt: null }));
    expectOk(await h.content.update("speakers", ids.grace, { name: "Grace H." }));
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    expect((await h.row(ids.programm, "fr"))?.staleToken).toBeNull();
    await h.settle();
    expect(h.html("/programm")).toContain("Grace H.");
    expect(h.html("/en/program")).toContain("Grace H.");
    expectOk(await h.delivery.markAll("pages"));
    expect((await h.row(ids.programm, "fr"))?.staleToken).toBeNull();
    await h.settle();
  });

  it("a render that throws records an attempt, releases its claim and never stalls the other rows of the pass", async () => {
    const db = createFakePersistence();
    const real = await createContentDefault(model, db);
    let broken = "";
    const content: Content = {
      ...real,
      get: (type, id, options) => (type === "pages" && id === broken ? Promise.resolve(err(failure("VALIDATION", "stored row no longer fits the model"))) : real.get(type, id, options)),
    };
    const h = await harness({ render: "background", db, content, dependencies: { maxAttempts: 1 } });
    const ids = await seed(h);
    broken = ids.info;
    expectOk(await h.content.set("settings", { title: "Festival 2027" }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("settings", []));
    await pollUntilOk(async () => expectOk(await h.delivery.readStaleStatus()).stale === 0);
    expect(h.html("/programm")).toContain("Festival 2027");
    expect(h.html("/kontakt")).toContain("Festival 2027");
    const info = (await h.row(ids.info))!;
    expect(info).toMatchObject({ claimedBy: null, staleAttempts: 1 });
    expect(info.staleError).toContain("threw");
    expect(expectOk(await h.db.count(STATUS, { claimedBy: { ne: null } }))).toBe(0);
  });

  it("a row of a type that is no longer delivered is never marked", async () => {
    const h = await harness();
    const ids = await seed(h);
    const at = Date.now();
    expectOk(await h.db.createOne<StatusRow>(STATUS, { id: `posts/${ids.programm}/de`, type: "posts", docId: ids.programm, locale: "de", state: "live", path: "/posts/x", error: null, publishedAt: at, updatedAt: at, version: 0, depSet: null, depCount: null, staleAt: null, staleToken: null, staleRetryAt: null, staleAttempts: 0, staleError: null, claimedBy: null, claimedAt: null }));
    expectOk(await h.delivery.markDependents("lineups", ["nothing"]));
    expect(await h.marked()).toEqual([]);
  });
});

async function pollUntilOk(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("delivery/static dependencies: restores, sweeps and shared paths", () => {
  it("a page that takes over a path while the previous owner's files there are being removed is marked and writes them again", async () => {
    const fake = createFakePersistence();
    let pauseRemoval: ReturnType<typeof gate> | null = null;
    const blobs = memoryBlobs();
    const pausing: typeof blobs = {
      ...blobs,
      files: blobs.files,
      async remove(key) {
        if (pauseRemoval !== null && key === "site/kontakt/index.html") {
          const g = pauseRemoval;
          pauseRemoval = null;
          g.arrive();
          await g.wait;
        }
        return blobs.remove(key);
      },
    };
    const h = await harness({ db: fake, content: await createContentDefault(model, fake), blobs: pausing });
    const ids = await seed(h);
    expectOk(await h.content.update("pages", ids.kontakt, { slug: "kontakt-alt" }, { locale: "de" }));
    const removal = gate();
    pauseRemoval = removal;
    const moving = h.delivery.publish("pages", ids.kontakt);
    await removal.reached;
    const successor = await h.page({ slug: "kontakt", title: "Neuer Kontakt", status: "published", body: [] });
    expectOk(await h.delivery.publish("pages", successor));
    removal.release();
    expectOk(await moving);
    expect(await h.marked()).toContain(`${successor}/de`);
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: successor, locale: "de" }));
    expect(h.html("/kontakt")).toContain("Neuer Kontakt");
    expect(h.html("/kontakt-alt")).toContain("Kontakt");
  });

  it("a restore that commits after an unpublish removed its freshly written file marks itself and writes it again", async () => {
    const fake = createFakePersistence();
    let pauseRemoval: ReturnType<typeof gate> | null = null;
    const blobs = memoryBlobs();
    const pausing: typeof blobs = {
      ...blobs,
      files: blobs.files,
      async remove(key) {
        if (pauseRemoval !== null && key === "site/kontakt/index.html") {
          const g = pauseRemoval;
          pauseRemoval = null;
          g.arrive();
          await g.wait;
        }
        return blobs.remove(key);
      },
    };
    const db = pausingSwaps(fake);
    const h = await harness({ db, content: await createContentDefault(model, fake), blobs: pausing });
    const ids = await seed(h);
    const removal = gate();
    pauseRemoval = removal;
    const unpublishing = h.delivery.unpublish("pages", ids.kontakt);
    await removal.reached;
    const swap = db.pauseNextSwap();
    const restoring = h.delivery.publish("pages", ids.kontakt);
    await swap.reached;
    removal.release();
    expectOk(await unpublishing);
    expect(h.html("/kontakt")).toBeNull();
    swap.release();
    const [de] = expectOk(await restoring);
    expect(de).toMatchObject({ state: "live", path: "/kontakt", stale: true });
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" }));
    expect(h.html("/kontakt")).toContain("Kontakt");
  });

  it("a restore whose tombstone is swept while it renders is still published", async () => {
    const h = await harness({ dependencies: { claimTtlSeconds: 120 } });
    const ids = await seed(h);
    expectOk(await h.delivery.unpublish("pages", ids.kontakt));
    h.advance(121_000);
    const held = h.reading.hold(ids.kontakt);
    const restoring = h.delivery.publish("pages", ids.kontakt);
    await held.reached;
    expect(expectOk(await h.delivery.resumeStale()).swept).toBeGreaterThanOrEqual(1);
    held.release();
    const [de] = expectOk(await restoring);
    expect(de).toMatchObject({ state: "live", path: "/kontakt" });
    expect(h.html("/kontakt")).toContain("Kontakt");
  });

  it("an unpublish whose file removal overlaps a restore of the same page marks the revived page, which writes its file again", async () => {
    const fake = createFakePersistence();
    let pauseRemoval: ReturnType<typeof gate> | null = null;
    const blobs = memoryBlobs();
    const pausing: typeof blobs = {
      ...blobs,
      files: blobs.files,
      async remove(key) {
        if (pauseRemoval !== null && key === "site/kontakt/index.html") {
          const g = pauseRemoval;
          pauseRemoval = null;
          g.arrive();
          await g.wait;
        }
        return blobs.remove(key);
      },
    };
    const h = await harness({ db: fake, content: await createContentDefault(model, fake), blobs: pausing });
    const ids = await seed(h);
    const removal = gate();
    pauseRemoval = removal;
    const unpublishing = h.delivery.unpublish("pages", ids.kontakt);
    await removal.reached;
    expect((await h.row(ids.kontakt))?.state).toBe("deleted");
    const restored = expectOk(await h.delivery.publish("pages", ids.kontakt));
    expect(restored[0]).toMatchObject({ state: "live", path: "/kontakt" });
    removal.release();
    expectOk(await unpublishing);
    expect((await h.row(ids.kontakt))).toMatchObject({ state: "live", path: "/kontakt" });
    expect(await h.marked()).toEqual([`${ids.kontakt}/de`]);
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" }));
    expect(h.html("/kontakt")).toContain("Kontakt");
    expect(h.html("/kontakt")).toContain("Kontakt");
  });
});

async function newlyReadSpeakerDuringRender(marker: Harness, renderer: Harness, ids: Awaited<ReturnType<typeof seed>>) {
  const fresh = expectOk(await marker.content.create("speakers", { name: "Hedy", status: "published" })).id;
  const lineup = expectOk(await marker.content.create("lineups", { title: "Late", speakers: [fresh] })).id;
  expectOk(await marker.content.update("pages", ids.kontakt, { body: [{ type: "lineup", id: lineup }] }, { locale: "de" }));
  const held = renderer.reading.hold(ids.kontakt);
  const publishing = renderer.delivery.publish("pages", ids.kontakt);
  await held.reached;
  expectOk(await marker.content.update("speakers", fresh, { name: "Hedy L." }));
  expect(expectOk(await marker.delivery.markDependents("speakers", [fresh])).marked).toBe(0);
  return { fresh, held, publishing };
}

describe("delivery/static dependencies: overlapping changes need no clock", () => {
  for (const [label, rendererAheadMs, markerAheadMs] of [
    ["the same clock", 0, 0],
    ["a renderer clock 120 s ahead", 120_000, 0],
    ["a marker clock 120 s ahead", 0, 120_000],
  ] as const) {
    it(`with ${label}, a newly read document changed and marked in another process marks the output`, async () => {
      const marker = await harness();
      const ids = await seed(marker);
      const renderer = await harness({ db: marker.db, content: marker.content, blobs: marker.blobs });
      renderer.advance(rendererAheadMs);
      marker.advance(markerAheadMs);
      const { held, publishing } = await newlyReadSpeakerDuringRender(marker, renderer, ids);
      held.release();
      expectOk(await publishing);
      expect(marker.html("/kontakt")).not.toContain("Hedy L.");
      expect(await marker.marked()).toContain(`${ids.kontakt}/de`);
      expectOk(await marker.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" }));
      expect(marker.html("/kontakt")).toContain("Hedy L.");
    });
  }

  it("a change recorded before a render started never marks that render's output again, whatever the clocks say", async () => {
    const marker = await harness();
    const ids = await seed(marker);
    const renderer = await harness({ db: marker.db, content: marker.content, blobs: marker.blobs });
    renderer.advance(-600_000);
    expectOk(await marker.content.update("speakers", ids.grace, { name: "Grace H." }));
    expectOk(await marker.delivery.markDependents("speakers", [ids.grace]));
    expectOk(await renderer.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" }));
    expectOk(await renderer.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "en" }));
    expect(await marker.marked()).toEqual([]);
  });
});

describe("delivery/static dependencies: an output's own document", () => {
  it("a change of the output's own document during its render leaves it to that document's own publish", async () => {
    const h = await harness();
    const ids = await seed(h);
    const held = h.reading.hold(ids.kontakt);
    const publishing = h.delivery.publish("pages", ids.kontakt);
    await held.reached;
    expectOk(await h.content.update("pages", ids.kontakt, { title: "Kontakt 2" }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("pages", [ids.kontakt]));
    held.release();
    expectOk(await publishing);
    expect(await h.marked()).toEqual([]);
    expectOk(await h.delivery.publish("pages", ids.kontakt));
    expect(h.html("/kontakt")).toContain("Kontakt 2");
  });

  it("a change of the same type that also touches a document the render read still marks it", async () => {
    const h = await harness();
    const ids = await seed(h);
    const shown = await h.page({ slug: "gezeigt", title: "Gezeigt", status: "published", body: [] });
    expectOk(await h.content.update("pages", ids.kontakt, { body: [{ type: "page", id: shown }] }, { locale: "de" }));
    const held = h.reading.hold(ids.kontakt);
    const publishing = h.delivery.publish("pages", ids.kontakt);
    await held.reached;
    expectOk(await h.content.update("pages", shown, { title: "Gezeigt 2" }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("pages", [ids.kontakt, shown]));
    held.release();
    expectOk(await publishing);
    expect(await h.marked()).toContain(`${ids.kontakt}/de`);
  });
});

describe("delivery/static dependencies: a burst of changes", () => {
  async function burst(h: Harness, count: number): Promise<void> {
    for (let i = 0; i < count; i++) expectOk(await h.delivery.markDependents("speakers", [`imported-${i}`]));
  }

  it("more than a thousand changes during a render that touch nothing it read leave its output unmarked", async () => {
    const h = await harness();
    const ids = await seed(h);
    const held = h.reading.hold(ids.programm);
    expectOk(await h.content.update("speakers", ids.grace, { name: "Grace H." }));
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    await burst(h, 1100);
    held.release();
    expect(expectOk(await rendering)).toEqual({ rendered: true, state: "live" });
    expect(await h.marked()).toEqual([`${ids.programm}/en`]);
  }, 30_000);

  it("a failing output keeps its attempt count and backoff through a burst", async () => {
    const h = await harness({ dependencies: { backoffSeconds: [600] } });
    const ids = await seed(h);
    expectOk(await h.content.update("speakers", ids.grace, { name: "FAIL" }));
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    await burst(h, 1100);
    held.release();
    expectErr(await rendering, "TRANSIENT");
    const row = (await h.row(ids.programm))!;
    expect(row.staleAttempts).toBe(1);
    expect(row.staleRetryAt! - Date.now()).toBeGreaterThan(590_000);
  }, 30_000);

  it("a change a failing render newly read keeps its attempt count and backoff: the output stays marked for its retry", async () => {
    const h = await harness({ dependencies: { backoffSeconds: [600] } });
    const ids = await seed(h);
    const hedy = expectOk(await h.content.create("speakers", { name: "Hedy", status: "published" })).id;
    const broken = expectOk(await h.content.create("speakers", { name: "FAIL", status: "published" })).id;
    const late = expectOk(await h.content.create("lineups", { title: "Late", speakers: [hedy, broken] })).id;
    expectOk(await h.content.update("pages", ids.kontakt, { body: [{ type: "lineup", id: late }] }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("settings", []));
    const held = h.reading.hold(ids.kontakt);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" });
    await held.reached;
    expectOk(await h.content.update("speakers", hedy, { name: "Hedy L." }));
    expect(expectOk(await h.delivery.markDependents("speakers", [hedy])).marked).toBe(0);
    held.release();
    expectErr(await rendering, "TRANSIENT");
    const row = (await h.row(ids.kontakt))!;
    expect(row.staleToken).not.toBeNull();
    expect(row.staleAttempts).toBe(1);
    expect(row.staleRetryAt! - Date.now()).toBeGreaterThan(590_000);
  });

  it("keeps a bounded change log: rows far below the newest sequence are pruned, and a render that started before the pruned range marks its output", async () => {
    const h = await harness();
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("lineups", ["warm-up"]));
    const counter = expectOk(await h.db.findOne<{ id: string; seq: number }>(STATE, { id: "changes" }));
    const start = counter!.seq;
    const held = h.reading.hold(ids.kontakt);
    const publishing = h.delivery.publish("pages", ids.kontakt);
    await held.reached;
    const newest = Math.ceil((start + 10_050) / 100) * 100;
    expectOk(await h.db.updateMany(STATE, { id: "changes" }, { seq: newest - 1 }));
    expectOk(await h.delivery.markDependents("lineups", ["unrelated"]));
    const kept = expectOk(await h.db.findMany<{ id: string }>(CHANGES, {}, { sort: { id: "asc" } })).items.map((r) => Number(r.id));
    expect(kept).toEqual([newest]);
    held.release();
    expectOk(await publishing);
    expect(await h.marked()).toContain(`${ids.kontakt}/de`);
    expectOk(await h.db.createOne(CHANGES, { id: "0000000000000002", type: "lineups", ids: ["old"] }));
    expectOk(await h.delivery.resumeStale());
    expect(expectOk(await h.db.findOne(CHANGES, { id: "0000000000000002" }))).toBeNull();
  }, 30_000);
});

describe("delivery/static dependencies: a re-mark that cannot be written", () => {
  function failingMarks(fake: FakePersistence): Persistence & { armed: boolean } {
    const wrapped: Persistence & { armed: boolean } = {
      ...fake,
      armed: false,
      updateMany: (c, f, p) => {
        if (wrapped.armed && c === STATUS && typeof p.staleToken === "string") {
          wrapped.armed = false;
          fake.failNext("TRANSIENT");
        }
        return fake.updateMany(c, f, p);
      },
    };
    return wrapped;
  }

  it("an overlapping render whose re-mark fails answers an error and keeps the mark it had", async () => {
    const fake = createFakePersistence();
    const db = failingMarks(fake);
    const h = await harness({ db, content: await createContentDefault(model, fake) });
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("settings", []));
    const before = (await h.row(ids.kontakt))!.staleToken;
    const fresh = expectOk(await h.content.create("speakers", { name: "Hedy", status: "published" })).id;
    const lineup = expectOk(await h.content.create("lineups", { title: "Late", speakers: [fresh] })).id;
    expectOk(await h.content.update("pages", ids.kontakt, { body: [{ type: "lineup", id: lineup }] }, { locale: "de" }));
    const held = h.reading.hold(ids.kontakt);
    const rendering = h.delivery.republishOutput({ type: "pages", docId: ids.kontakt, locale: "de" });
    await held.reached;
    expectOk(await h.content.update("speakers", fresh, { name: "Hedy L." }));
    expectOk(await h.delivery.markDependents("speakers", [fresh]));
    db.armed = true;
    held.release();
    expectErr(await rendering, "TRANSIENT");
    expect((await h.row(ids.kontakt))?.staleToken).toBe(before);
    expect(h.logger.errors.join("\n")).not.toContain("the recovery pass marks it");
  });

  it("a losing render whose re-mark fails answers an error", async () => {
    const fake = createFakePersistence();
    const db = failingMarks(fake);
    const h = await harness({ db, content: await createContentDefault(model, fake) });
    const ids = await seed(h);
    expectOk(await h.delivery.markDependents("speakers", [ids.grace]));
    const held = h.reading.hold(ids.programm);
    const rerender = h.delivery.republishOutput({ type: "pages", docId: ids.programm, locale: "de" });
    await held.reached;
    expectOk(await h.content.update("speakers", ids.grace, { name: "Grace New" }));
    expectOk(await h.delivery.publish("pages", ids.programm));
    db.armed = true;
    held.release();
    expectErr(await rerender, "TRANSIENT");
  });
});

describe("delivery/static dependencies: two outputs racing for one path", () => {
  it("a page that moves onto a path while another page leaves it keeps its file or is marked", async () => {
    const fake = createFakePersistence();
    const db = pausingSwaps(fake);
    const h = await harness({ db, content: await createContentDefault(model, fake) });
    const ids = await seed(h);
    const successor = await h.page({ slug: "kontakt-neu", title: "Neuer Kontakt", status: "published", body: [] });
    expectOk(await h.delivery.publish("pages", successor));
    expectOk(await h.content.update("pages", ids.kontakt, { slug: "kontakt-alt" }, { locale: "de" }));
    expectOk(await h.content.update("pages", successor, { slug: "kontakt" }, { locale: "de" }));
    const held = h.reading.hold(successor);
    const moving = h.delivery.publish("pages", successor);
    await held.reached;
    const swap = db.pauseNextSwap();
    held.release();
    await swap.reached;
    expect(h.html("/kontakt")).toContain("Neuer Kontakt");
    expectOk(await h.delivery.publish("pages", ids.kontakt));
    expect(h.html("/kontakt")).toBeNull();
    swap.release();
    expectOk(await moving);
    expect((await h.row(successor))).toMatchObject({ state: "live", path: "/kontakt" });
    expect(h.html("/kontakt") !== null || (await h.marked()).includes(`${successor}/de`)).toBe(true);
    expectOk(await h.delivery.republishOutput({ type: "pages", docId: successor, locale: "de" }));
    expect(h.html("/kontakt")).toContain("Neuer Kontakt");
  });
});

describe("delivery/static dependencies: a failed render inherits the previous reads", () => {
  it("a document the previous render read, and the failing render never reached, still marks the output", async () => {
    const h = await harness();
    const ids = await seed(h);
    const broken = expectOk(await h.content.create("speakers", { name: "FAIL", status: "published" })).id;
    const early = expectOk(await h.content.create("lineups", { title: "Early", speakers: [broken] })).id;
    expectOk(await h.content.update("pages", ids.programm, { body: [{ type: "lineup", id: early }, { type: "lineup", id: ids.lineup }] }, { locale: "de" }));
    const [de] = expectOk(await h.delivery.publish("pages", ids.programm));
    expect(de).toMatchObject({ state: "error" });
    expectOk(await h.delivery.markDependents("speakers", [ids.ada]));
    expect(await h.marked()).toContain(`${ids.programm}/de`);
  });
});

describe("delivery/static dependencies: the loop's claims", () => {
  it("renews the claim before each render of a pass and skips a row whose claim another process took", async () => {
    const h = await harness({ render: "background" });
    await seed(h);
    const first = h.reading.holdNext();
    const at = Date.now();
    const callsBefore = h.reading.calls.length;
    expectOk(await h.delivery.markDependents("settings", []));
    await first.reached;
    const claimed = expectOk(await h.db.findMany<StatusRow>(STATUS, { claimedBy: { ne: null } })).items;
    expect(claimed.length).toBe(4);
    const rendering = h.reading.calls.at(-1)!;
    const victim = claimed.find((r) => `${r.docId}/${r.locale}` !== rendering)!;
    expectOk(await h.db.updateMany<StatusRow>(STATUS, { id: victim.id }, { claimedBy: "elsewhere", claimedAt: at }));
    h.advance(100_000);
    const second = h.reading.holdNext();
    first.release();
    await second.reached;
    const next = h.reading.calls.at(-1)!;
    const nextRow = claimed.find((r) => `${r.docId}/${r.locale}` === next)!;
    expect(expectOk(await h.db.findOne<StatusRow>(STATUS, { id: nextRow.id }))!.claimedAt! - at).toBeGreaterThanOrEqual(100_000);
    second.release();
    await pollUntilOk(async () => expectOk(await h.db.count(STATUS, { claimedBy: { ne: null } })) === 1);
    expect(h.reading.calls.slice(callsBefore)).toHaveLength(3);
    expect(h.reading.calls.slice(callsBefore)).not.toContain(`${victim.docId}/${victim.locale}`);
    expect(expectOk(await h.db.findOne<StatusRow>(STATUS, { id: victim.id }))?.claimedBy).toBe("elsewhere");
  });
});

describe("delivery/static dependencies: markAll and rows with older ids", () => {
  it("never creates a second row for an output whose row has an older id, however many rows of removed locales exist", async () => {
    const h = await harness();
    await seed(h);
    const late = await h.page({ slug: "spaet", title: "Spät", status: "published" });
    const at = Date.now();
    const row = (locale: string, id: string): StatusRow => ({ id, type: "pages", docId: late, locale, state: "draft", path: null, writtenKeys: {}, error: null, publishedAt: null, updatedAt: at, version: 0, depSet: null, depCount: null, staleAt: null, staleToken: null, staleRetryAt: null, staleAttempts: 0, staleError: null, claimedBy: null, claimedAt: null });
    for (const locale of ["fr", "it", "es", "nl", "pl", "pt", "sv", "da", "fi", "cs", "hu", "ro"]) expectOk(await h.db.createOne<StatusRow>(STATUS, row(locale, `old-${locale}`)));
    expectOk(await h.db.createOne<StatusRow>(STATUS, row("de", "zz-older-random-id")));
    expectOk(await h.delivery.markAll("pages"));
    expect(expectOk(await h.db.count(STATUS, { docId: late, locale: "de" }))).toBe(1);
  });
});

describe("delivery/static dependencies: the orphan sweep", () => {
  it("reads no dependency set that is in use", async () => {
    const fake = createFakePersistence();
    const h = await harness({ db: fake, dependencies: { claimTtlSeconds: 120 } });
    await seed(h);
    h.advance(121_000);
    let setsRead = 0;
    const counting: Persistence = {
      ...fake,
      findMany: async <T extends Document>(c: string, f: Filter, o?: FindOptions) => {
        const page = await fake.findMany<T>(c, f, o);
        if (c === DEPENDENCY_SETS && page.ok) setsRead += page.value.items.length;
        return page;
      },
      findOne: async <T extends Document>(c: string, f: Filter) => {
        const found = await fake.findOne<T>(c, f);
        if (c === DEPENDENCY_SETS && found.ok && found.value !== null) setsRead += 1;
        return found;
      },
    };
    const sweeper = await harness({ db: counting, content: h.content, blobs: h.blobs, dependencies: { claimTtlSeconds: 120 } });
    sweeper.advance(121_000);
    expectOk(await sweeper.delivery.resumeStale());
    expect(setsRead).toBe(0);
  });

  it("a process that stops right after its swap leaves the new set to be adopted and the replaced one to be removed", async () => {
    const fake = createFakePersistence();
    const h0 = await harness({ db: fake, dependencies: { claimTtlSeconds: 120 } });
    const ids = await seed(h0);
    const before = (await h0.row(ids.programm))!;
    let armed = true;
    const stopping: Persistence = {
      ...fake,
      updateMany: (c, f, p) => {
        if (armed && c === DEPENDENCY_SETS) {
          armed = false;
          return Promise.reject(new Error("process stopped"));
        }
        return fake.updateMany(c, f, p);
      },
    };
    const h = await harness({ db: stopping, content: h0.content, blobs: h0.blobs, dependencies: { claimTtlSeconds: 120 } });
    await expect(h.delivery.publish("pages", ids.programm)).rejects.toThrow("process stopped");
    const after = (await h0.row(ids.programm))!;
    expect(after.depSet).not.toBe(before.depSet);
    h0.advance(121_000);
    expectOk(await h0.delivery.resumeStale());
    expect(expectOk(await fake.findMany<{ id: string }>(DEPENDENCY_SETS, { output: after.id })).items.map((s) => s.id)).toEqual([after.depSet]);
    expect(await setKeysExist(fake, after.depSet!)).toBe(true);
    h0.advance(121_000);
    expect(expectOk(await h0.delivery.resumeStale()).swept).toBe(0);
    expect(await setKeysExist(fake, after.depSet!)).toBe(true);
  });
});

describe("delivery/static dependencies: links by internal object reference", () => {
  it("a broken link to a document whose id a kestrel: string cannot carry marks its reader once the target is published", async () => {
    const h = await harness();
    await seed(h);
    const targetId = "ziel_1";
    expectOk(await h.db.createOne(pagesTable, { id: targetId, slug__de: "ziel", title__de: "Ziel", status__de: "draft", createdAt: 1, updatedAt: 1 }));
    const linker = await h.page({ slug: "verweis", title: "Verweis", status: "published", body: [{ type: "teaser", link: { type: "internal", collection: "pages", id: targetId } }] });
    expectOk(await h.delivery.publish("pages", linker));
    expect(h.html("/verweis")).toContain('"broken":true');
    expectOk(await h.content.update("pages", targetId, { status: "published" }, { locale: "de" }));
    expectOk(await h.delivery.markDependents("pages", [targetId]));
    expect(await h.marked()).toContain(`${linker}/de`);
  });
});

describe("delivery/static dependencies: keys recorded before this version", () => {
  it("records the keys it derives for a row with none once, so a retry after a crash removes the same keys instead of deriving fewer from a since-shrunk format list", async () => {
    const fake = createFakePersistence();
    const content = await createContentDefault(model, fake);
    const renderer: Renderer = {
      formats: () => ["html", "json"],
      async render(input) {
        return ok({ data: `<h1>${String(input.document.title)}</h1>`, contentType: "text/html", extension: input.format });
      },
    };
    const h1 = await harness({ db: fake, content, renderer, formats: ["html", "json"] });
    const page = await h1.page({ slug: "seite", title: "Seite", status: "published", body: [] });
    expectOk(await h1.delivery.publish("pages", page));
    expect(h1.blobs.files.has("site/seite/index.json")).toBe(true);
    const row = (await h1.row(page))!;
    expectOk(await fake.updateMany(STATUS, { id: row.id }, { writtenKeys: null }));

    const brokenBlobs = failingRemoveOnce(h1.blobs, "site/seite/index.html");
    const h2 = await harness({ db: fake, content, blobs: brokenBlobs, renderer, formats: ["html", "json"] });
    expectErr(await h2.delivery.unpublish("pages", page), "TRANSIENT");
    expect(expectOk(await fake.findOne<StatusRow>(STATUS, { id: row.id }))?.writtenKeys).toEqual({ html: "site/seite/index.html", json: "site/seite/index.json" });
    expect(h1.blobs.files.has("site/seite/index.json")).toBe(true);

    const h3 = await harness({ db: fake, content, blobs: h1.blobs, renderer, formats: ["html"] });
    expectOk(await h3.delivery.unpublish("pages", page));
    expect(h1.blobs.files.has("site/seite/index.html")).toBe(false);
    expect(h1.blobs.files.has("site/seite/index.json")).toBe(false);
  });
});

const pagesTable = "pages";
