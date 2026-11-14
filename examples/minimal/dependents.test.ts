import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, defineModule, definePipeline, type Kestrel, type RunResult } from "@michaelthielemann/kestrel";
import { RENDERER, type Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { KestrelConfigInput } from "@michaelthielemann/kestrel/defineConfig";
import { loadConfig, loadModules, loadPipelines } from "@michaelthielemann/kestrel/load";
import { ok } from "@michaelthielemann/kestrel/result";

const root = dirname(fileURLToPath(import.meta.url));
const trigger = { kind: "http", name: "test" } as const;
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const TEST_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64",
);

type Mode = "direct" | "queue";

interface Gate {
  reached: Promise<void>;
  release(): void;
}

interface ReadingRenderer {
  calls: string[];
  delayMs: number;
  hold(path: string): Gate;
  instance?: Kestrel;
  via?: (path: string) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readingRendererModule(state: ReadingRenderer) {
  const holds = new Map<string, { wait: Promise<void>; arrive(): void }>();
  state.hold = (path) => {
    let release: () => void = () => {};
    let arrive: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    holds.set(path, { wait, arrive });
    return { reached, release };
  };
  const read = async (pipeline: string, input: { params?: Record<string, string>; payload?: Record<string, unknown> }): Promise<unknown> => {
    const run: RunResult = await state.instance!.run(pipeline, { trigger: { kind: "http", name: "render" }, ...input });
    return run.status === 200 ? run.result : null;
  };
  const renderer: Renderer = {
    formats: () => ["html"],
    async render(input) {
      state.calls.push(input.path);
      const locale = input.locale ?? "de";
      const page = state.via !== undefined ? await state.via(input.path) : await read("resolvePage", { params: { path: input.path.slice(1) } });
      const settings = await read("getSettings", { payload: { locale } });
      const names: string[] = [];
      const lineupIds = isRecord(page) && Array.isArray(page.lineups) ? page.lineups.filter((v): v is string => typeof v === "string") : [];
      for (const lineupId of lineupIds) {
        const lineup = await read("readLineup", { params: { id: lineupId }, payload: { locale } });
        if (!isRecord(lineup)) continue;
        const listed: unknown[] = Array.isArray(lineup.speakers) ? boundaryCast<unknown[]>(lineup.speakers, "json") : [];
        const speakerIds = [lineup.headliner, ...listed].filter((v): v is string => typeof v === "string");
        for (const speakerId of speakerIds) {
          const speaker = await read("readSpeaker", { params: { id: speakerId } });
          if (isRecord(speaker) && typeof speaker.name === "string") names.push(speaker.name);
        }
      }
      const hold = holds.get(input.path);
      if (hold !== undefined) {
        holds.delete(input.path);
        hold.arrive();
        await hold.wait;
      }
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      const title = isRecord(page) && typeof page.title === "string" ? page.title : String(input.document.title);
      const siteTitle = isRecord(settings) && typeof settings.title === "string" ? settings.title : "";
      const links = isRecord(page) && isRecord(page._links) ? Object.values(page._links).flatMap((l) => (isRecord(l) && typeof l.path === "string" ? [l.path] : [])) : [];
      return ok({ data: `<html><body><main><h1>${title}</h1><p class="site">${siteTitle}</p><ul>${names.map((n) => `<li>${n}</li>`).join("")}</ul><nav>${links.map((l) => `<a href="${l}"></a>`).join("")}</nav></main></body></html>`, contentType: "text/html; charset=utf-8", extension: "html" });
    },
  };
  return defineModule({
    name: "renderer/reading",
    provides: [RENDERER],
    requires: [],
    configSchema: z.object({}).strict(),
    async setup() {
      return renderer;
    },
  });
}

interface Options {
  mode: Mode;
  lanes?: Record<string, string[]>;
  relayPipelines?: string[];
  pollMs?: number;
  http?: boolean;
}

interface Example {
  kestrel: Kestrel;
  site: string;
  reading: ReadingRenderer;
  runs: Array<{ pipeline: string; phase: "start" | "end"; at: number }>;
  port: number | undefined;
  dispose(): Promise<void>;
}

async function bootExample(options: Options): Promise<Example> {
  const configInput = await loadConfig(join(root, "kestrel.config.ts"));
  const dataDir = mkdtempSync(join(tmpdir(), "kestrel-minimal-dependents-"));
  const queue = options.mode === "queue";
  const modulesConfig = configInput.modules.map((m) => {
    const config = boundaryCast<Record<string, unknown>>(m.config, "host");
    if (m.use === "@michaelthielemann/kestrel-persistence-sqlite") return { ...m, config: { ...config, file: ":memory:" } };
    if (m.use === "@michaelthielemann/kestrel-replication-sqlite") return { ...m, config: { ...config, file: join(dataDir, "replication.db") } };
    if (m.use === "@michaelthielemann/kestrel-blobstore-filesystem") return { ...m, config: { ...config, root: join(dataDir, "blobs") } };
    if (m.use === "@michaelthielemann/kestrel-renderer-plain") return { use: "renderer/reading", config: {} };
    if (m.use === "@michaelthielemann/kestrel-authz-roles") {
      const fields = boundaryCast<Record<string, string[]>>(config.anonymousFields, "host");
      return { ...m, config: { ...config, anonymous: [...boundaryCast<string[]>(config.anonymous, "host"), "speakers.read", "lineups.read"], anonymousFields: { ...fields, pages: [...(fields.pages ?? []), "lineups"] } } };
    }
    if (m.use === "@michaelthielemann/kestrel-delivery-static") return { ...m, config: { ...config, dependencies: { render: queue ? "events" : "background", rendererReadsDocument: true, renderTimeoutSeconds: 5, claimTtlSeconds: 30 } } };
    if (m.use === "@michaelthielemann/kestrel-content-default") {
      const content = boundaryCast<{ types: Record<string, { fields: Record<string, unknown> }> }>(config, "host");
      return {
        ...m,
        config: {
          ...content,
          types: {
            ...content.types,
            pages: { ...content.types.pages, fields: { ...content.types.pages!.fields, lineups: { type: "json" } } },
            speakers: { kind: "multi", fields: { name: { type: "text", required: true }, status: { type: "enum", options: ["draft", "published"], required: true } } },
            lineups: { kind: "multi", fields: { title: { type: "text", localized: true }, headliner: { type: "text" }, speakers: { type: "json" } } },
          },
        },
      };
    }
    if (queue && m.use === "@michaelthielemann/kestrel-events-direct") return { use: "@michaelthielemann/kestrel-events-queue", config: { pollMs: options.pollMs ?? 10, maxAttempts: 3, backoffSeconds: [1], relayMs: 5000, relayPipelines: options.relayPipelines ?? ["publishPage", "unpublishPage"], delayMs: { refreshIndexes: 1000, refreshLlms: 3000 }, lanes: options.lanes ?? { pages: ["republishOutput", "refreshLlms"], indexes: ["refreshIndexes"], variants: ["generateImageVariants"] } } };
    return m;
  });
  const reading: ReadingRenderer = { calls: [], delayMs: 0, hold: () => ({ reached: Promise.resolve(), release() {} }) };
  const loaded = await loadModules(root, { ...configInput, modules: modulesConfig.filter((m) => m.use !== "renderer/reading") });
  const readingModule = readingRendererModule(reading);
  let next = 0;
  const modules = modulesConfig.map((m) => (m.use === "renderer/reading" ? readingModule : loaded[next++]!));
  const pipelines = await loadPipelines(root, "pipelines");
  pipelines.push(
    definePipeline({ name: "readSpeaker", steps: ["authn.identifyUser", "authz.require:speakers.read", "content.get:speakers?status=published"] }),
    definePipeline({ name: "readLineup", steps: ["authn.identifyUser", "authz.require:lineups.read", "content.get:lineups"] }),
    definePipeline({ name: "createSpeaker", steps: ["authn.requireUser", "authz.requireRole", "authz.require:speakers.write", { atomic: ["content.create:speakers"] }, "events.emit:speaker.created", "events.relay"] }),
    definePipeline({ name: "updateSpeaker", steps: ["authn.requireUser", "authz.requireRole", "authz.require:speakers.write", { atomic: ["content.update:speakers"] }, "events.emit:speaker.updated", "events.relay"] }),
    definePipeline({ name: "createLineup", steps: ["authn.requireUser", "authz.requireRole", "authz.require:lineups.write", { atomic: ["content.create:lineups"] }, "events.emit:lineup.created", "events.relay"] }),
    definePipeline({ name: "updateLineup", steps: ["authn.requireUser", "authz.requireRole", "authz.require:lineups.write", { atomic: ["content.update:lineups"] }, "events.emit:lineup.updated", "events.relay"] }),
    definePipeline({ name: "speakerDependents", steps: ["delivery.markDependents:speakers"] }),
    definePipeline({ name: "lineupDependents", steps: ["delivery.markDependents:lineups"] }),
    definePipeline({ name: "staleStatus", steps: ["delivery.readStaleStatus"] }),
    definePipeline({ name: "buildCheck", steps: ["replication.checkRestored", "delivery.checkBuild"] }),
  );
  let triggers = [...configInput.triggers];
  triggers.push(
    { event: "speaker.created", pipeline: "speakerDependents" },
    { event: "speaker.updated", pipeline: "speakerDependents" },
    { event: "lineup.created", pipeline: "lineupDependents" },
    { event: "lineup.updated", pipeline: "lineupDependents" },
  );
  if (queue) {
    triggers = triggers.filter((t) => !("event" in t && t.event === "media.uploaded"));
    triggers.push({ event: "media.uploaded", pipeline: "planImageVariants" }, { event: "images.planned", pipeline: "generateImageVariants" }, { event: "delivery.outputStale", pipeline: "republishOutput" }, { event: "delivery.indexesStale", pipeline: "refreshIndexes" }, { event: "delivery.llmsStale", pipeline: "refreshLlms" });
    pipelines.push(
      definePipeline({ name: "planImageVariants", steps: ["images.plan", "events.emit:images.planned"] }),
      definePipeline({ name: "republishOutput", steps: ["delivery.republishOutput"] }),
      definePipeline({ name: "refreshIndexes", steps: ["delivery.exportIndexes"] }),
      definePipeline({ name: "refreshLlms", steps: ["delivery.exportLlmsFull"] }),
      definePipeline({ name: "queueStatus", steps: ["events.readQueueStatus"] }),
    );
  }
  const config: KestrelConfigInput = { ...configInput, http: options.http === true ? { port: 0, host: "127.0.0.1" } : null, modules: modulesConfig, triggers };
  const kestrel = await boot({ config, modules, pipelines, root, validateOutput: true });
  reading.instance = kestrel;
  const runs: Example["runs"] = [];
  kestrel.observe({
    runStart: (e) => runs.push({ pipeline: e.pipeline, phase: "start", at: Date.now() }),
    runEnd: (e) => runs.push({ pipeline: e.pipeline, phase: "end", at: Date.now() }),
  });
  const started = await kestrel.start();
  return {
    kestrel,
    site: join(dataDir, "blobs", "site"),
    reading,
    runs,
    port: started.http?.port,
    dispose: async () => {
      await kestrel.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function pollUntil(check: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("pollUntil: timed out waiting for the condition");
}

function page(example: Example, path: string): string | null {
  const file = join(example.site, path === "/" ? "" : path.slice(1), "index.html");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function exportedPages(example: Example): string[] {
  return readdirSync(example.site, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith("index.html"))
    .map((file) => readFileSync(join(example.site, file), "utf8"));
}

function mtime(example: Example, path: string): number | null {
  const file = join(example.site, path === "/" ? "" : path.slice(1), "index.html");
  return existsSync(file) ? statSync(file).mtimeMs : null;
}

async function call(example: Example, pipeline: string, input: { token?: string; params?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, string> } = {}): Promise<Record<string, unknown>> {
  const { token, body, ...rest } = input;
  const result = await example.kestrel.run(pipeline, { trigger, ...(token === undefined ? {} : { headers: bearer(token) }), ...(body === undefined ? {} : { body, payload: body }), ...rest });
  expect(result.status, `${pipeline}: ${result.error ?? ""}`).toBe(200);
  return boundaryCast<Record<string, unknown>>(result.result, "json");
}

interface StaleStatus {
  stale: number;
  failed: number;
  rendering: number;
  unknown: number;
  exports: { indexes: { at: number; entries: number; error: string | null } | null };
}

async function stale(example: Example): Promise<StaleStatus> {
  return boundaryCast<StaleStatus>(await call(example, "staleStatus"), "json");
}

async function indexesExported(example: Example, entries: number, timeoutMs?: number, intervalMs?: number): Promise<void> {
  await pollUntil(async () => {
    const indexes = (await stale(example)).exports.indexes;
    return indexes !== null && indexes.error === null && indexes.entries === entries;
  }, timeoutMs, intervalMs);
}

interface Seeded {
  token: string;
  ada: string;
  grace: string;
  linus: string;
  lineup: string;
  programm: string;
  info: string;
  entwurf: string;
}

async function seed(example: Example): Promise<Seeded> {
  const token = boundaryCast<{ token: string }>(await call(example, "login", { body: { username: "admin", password: "kestrel-demo" } }), "json").token;
  await call(example, "setSettings", { token, body: { title: "Festival", locale: "de" } });
  const speaker = async (name: string, status: string) => String((await call(example, "createSpeaker", { token, body: { name, status } })).id);
  const ada = await speaker("Ada", "published");
  const grace = await speaker("Grace", "published");
  const linus = await speaker("Linus", "draft");
  const lineup = String((await call(example, "createLineup", { token, body: { title: "Main", headliner: ada, speakers: [grace, linus] } })).id);
  const programm = String((await call(example, "createPage", { token, body: { slug: "programm", title: "Programm", status: "published", lineups: [lineup] } })).id);
  await call(example, "updatePage", { token, params: { id: programm }, body: { slug: "program", title: "Program", status: "published", locale: "en" } });
  const info = String((await call(example, "createPage", { token, body: { slug: "info", title: "Info", status: "published", body: [{ type: "prose", props: { body: `<p><a href="kestrel:pages:${programm}">Programm</a></p>` } }] } })).id);
  const entwurf = String((await call(example, "createPage", { token, body: { slug: "entwurf", title: "Entwurf", status: "draft", lineups: [lineup] } })).id);
  return { token, ada, grace, linus, lineup, programm, info, entwurf };
}

async function settled(example: Example): Promise<void> {
  await pollUntil(async () => {
    const status = await stale(example);
    if (status.stale !== 0 || status.rendering !== 0) return false;
    if (!example.kestrel.pipelines.has("queueStatus")) return true;
    const queue = boundaryCast<{ pending: number; running: number }>(await call(example, "queueStatus"), "json");
    return queue.pending === 0 && queue.running === 0;
  });
}

for (const mode of ["direct", "queue"] as const) {
  describe(`examples/minimal dependent pages (${mode === "direct" ? "events-direct, background loop" : "events-queue, render jobs"})`, () => {
    it("a changed speaker two references away updates the exported page without saving the page, and a draft is never published", async () => {
      const example = await bootExample({ mode });
      try {
        const ids = await seed(example);
        await settled(example);
        expect(page(example, "/programm")).toContain("<li>Ada</li><li>Grace</li>");
        expect(page(example, "/programm")).not.toContain("Linus");
        const infoBefore = mtime(example, "/info");
        const pageBefore = boundaryCast<{ updatedAt: number }>(await call(example, "readPage", { token: ids.token, params: { id: ids.programm } }), "json").updatedAt;

        await call(example, "updateSpeaker", { token: ids.token, params: { id: ids.grace }, body: { name: "Grace H." } });
        await pollUntil(() => (page(example, "/programm") ?? "").includes("<li>Grace H.</li>") && (page(example, "/en/program") ?? "").includes("<li>Grace H.</li>"));
        expect(boundaryCast<{ updatedAt: number }>(await call(example, "readPage", { token: ids.token, params: { id: ids.programm } }), "json").updatedAt).toBe(pageBefore);
        expect(mtime(example, "/info")).toBe(infoBefore);

        await call(example, "updateSpeaker", { token: ids.token, params: { id: ids.linus }, body: { status: "published" } });
        await pollUntil(() => (page(example, "/programm") ?? "").includes("<li>Linus</li>"));

        await call(example, "updateLineup", { token: ids.token, params: { id: ids.lineup }, body: { headliner: ids.grace } });
        await pollUntil(() => (page(example, "/programm") ?? "").includes("<li>Grace H.</li><li>Grace H.</li>"));

        await settled(example);
        expect(page(example, "/entwurf")).toBeNull();
        expect(example.reading.calls).not.toContain("/entwurf");
      } finally {
        await example.dispose();
      }
    }, 30_000);

    it("renaming a page moves its exported file, re-renders the pages linking to it and redirects the old path", async () => {
      const example = await bootExample({ mode });
      try {
        const ids = await seed(example);
        await settled(example);
        expect(page(example, "/info")).toContain('<a href="/programm">');
        await call(example, "updatePage", { token: ids.token, params: { id: ids.programm }, body: { slug: "festival" } });
        await pollUntil(() => page(example, "/programm") === null && (page(example, "/festival") ?? "").includes("<h1>Programm</h1>") && (page(example, "/info") ?? "").includes('<a href="/festival">'));
        expect(page(example, "/en/program")).toContain("<h1>Program</h1>");
        await pollUntil(async () => {
          const res = await example.kestrel.run("resolvePage", { trigger, params: { path: "programm" } });
          return JSON.stringify(res.result) === JSON.stringify({ redirect: { to: "/festival", status: 301 } });
        });
        const exported = boundaryCast<Array<{ target: string }>>(JSON.parse(readFileSync(join(example.site, "redirects.json"), "utf8")), "json");
        expect(exported.map((r) => r.target)).toContain("/festival");
        await settled(example);
      } finally {
        await example.dispose();
      }
    }, 30_000);

    it("a settings change re-renders every published page outside the request, then writes llms-full.txt once, and no page keeps the old title", async () => {
      const example = await bootExample({ mode, pollMs: 50 });
      try {
        const ids = await seed(example);
        await settled(example);
        const callsBefore = example.reading.calls.length;
        const putAt = Date.now();
        const held = mode === "direct" ? example.reading.hold("/programm") : undefined;
        const before = { programm: mtime(example, "/programm"), info: mtime(example, "/info") };
        const response = await call(example, "setSettings", { token: ids.token, body: { title: "Festival & Co 2027", locale: "de" } });
        expect(response._llms).toBeUndefined();
        if (mode === "queue") {
          expect(example.reading.calls.length).toBe(callsBefore);
          expect({ programm: mtime(example, "/programm"), info: mtime(example, "/info") }).toEqual(before);
        } else {
          await held!.reached;
          expect(page(example, "/programm")).not.toContain("Festival & Co 2027");
          held!.release();
        }
        await pollUntil(() => ["/programm", "/info"].every((p) => (page(example, p) ?? "").includes('<p class="site">Festival & Co 2027</p>')));
        await settled(example);
        const exported = exportedPages(example);
        expect(exported.length).toBeGreaterThanOrEqual(3);
        expect(exported.filter((html) => html.includes('<p class="site">Festival</p>'))).toEqual([]);
        const text = (file: string): string => (existsSync(join(example.site, file)) ? readFileSync(join(example.site, file), "utf8") : "");
        await pollUntil(() => text("llms.txt").includes("# Festival & Co 2027") && text("llms-full.txt").includes("# Festival & Co 2027"));
        for (const file of ["llms.txt", "llms-full.txt"]) expect(text(file), file).not.toMatch(/^# Festival$/m);
        expect(page(example, "/entwurf")).toBeNull();
        if (mode === "queue") {
          await pollUntil(() => example.runs.some((r) => r.at >= putAt && r.pipeline === "refreshLlms" && r.phase === "end"));
          const since = example.runs.filter((r) => r.at >= putAt);
          const refreshes = since.filter((r) => r.pipeline === "refreshLlms" && r.phase === "start");
          const renders = since.filter((r) => r.pipeline === "republishOutput" && r.phase === "end");
          expect(renders.length).toBeGreaterThanOrEqual(3);
          expect(refreshes.length).toBe(1);
          expect(refreshes[0]!.at).toBeGreaterThanOrEqual(renders.at(-1)!.at);
          expect(since.filter((r) => r.pipeline === "settingsDependents" && r.phase === "end").length).toBe(1);
        }
      } finally {
        await example.dispose();
      }
    }, 30_000);
  });
}

for (const mode of ["queue", "direct"] as const) {
  describe(`examples/minimal index files (${mode === "direct" ? "events-direct, background loop" : "events-queue, own lane"})`, () => {
    it("a page saved during the re-render backlog of a new build is in sitemap.xml and llms.txt within ten seconds, before the backlog drains", async () => {
      const example = await bootExample({ mode });
      try {
        const token = boundaryCast<{ token: string }>(await call(example, "login", { body: { username: "admin", password: "kestrel-demo" } }), "json").token;
        await call(example, "setSettings", { token, body: { title: "Festival", locale: "de" } });
        for (let i = 0; i < 30; i++) await call(example, "createPage", { token, body: { slug: `seite-${i}`, title: `Seite ${i}`, status: "published" } });
        await settled(example);
        const sitemap = (): string => (existsSync(join(example.site, "sitemap.xml")) ? readFileSync(join(example.site, "sitemap.xml"), "utf8") : "");
        await indexesExported(example, 30);
        expect(sitemap()).toContain("<loc>http://127.0.0.1:4000/seite-29</loc>");
        expect(readFileSync(join(example.site, "robots.txt"), "utf8")).toBe("User-agent: *\nDisallow: /\n\nSitemap: http://127.0.0.1:4000/sitemap.xml\n");

        example.reading.delayMs = 200;
        expect(await call(example, "buildCheck", { body: { build: "next" } })).toMatchObject({ changed: true, restored: false });
        await pollUntil(async () => (await stale(example)).stale >= 25);
        const savedAt = Date.now();
        await call(example, "createPage", { token, body: { slug: "neu", title: "Neu", status: "published" } });
        await indexesExported(example, 31, 10_000, 10);
        const elapsed = Date.now() - savedAt;
        expect(sitemap()).toContain("<loc>http://127.0.0.1:4000/neu</loc>");
        expect((await stale(example)).stale).toBeGreaterThan(0);
        expect(elapsed).toBeLessThanOrEqual(10_000);
        expect(readFileSync(join(example.site, "llms.txt"), "utf8")).toContain("[Neu](http://127.0.0.1:4000/neu)");
        example.reading.delayMs = 0;
        await settled(example);
      } finally {
        await example.dispose();
      }
    }, 60_000);
  });
}

describe("examples/minimal dependent pages: reads the instance cannot see", () => {
  it("a renderer that fetches its page over a socket leaves its outputs with unknown dependencies", async () => {
    const example = await bootExample({ mode: "direct", http: true });
    try {
      expect(example.port).toBeGreaterThan(0);
      example.reading.via = async (path) => {
        const response = await fetch(`http://127.0.0.1:${example.port}/site${path}`);
        return response.ok ? boundaryCast<unknown>(await response.json(), "json") : null;
      };
      const token = boundaryCast<{ token: string }>(await call(example, "login", { body: { username: "admin", password: "kestrel-demo" } }), "json").token;
      await call(example, "setSettings", { token, body: { title: "Festival", locale: "de" } });
      await call(example, "createPage", { token, body: { slug: "fern", title: "Fern", status: "published" } });
      await settled(example);
      expect(page(example, "/fern")).toContain("Fern");
      expect((await stale(example)).unknown).toBe(1);
    } finally {
      await example.dispose();
    }
  }, 30_000);
});

describe("examples/minimal dependent pages: lanes keep uploads ahead of re-renders", () => {
  async function uploadDuringRerender(lanes: Record<string, string[]>) {
    const example = await bootExample({ mode: "queue", lanes });
    try {
      const token = boundaryCast<{ token: string }>(await call(example, "login", { body: { username: "admin", password: "kestrel-demo" } }), "json").token;
      await call(example, "setSettings", { token, body: { title: "Festival", locale: "de" } });
      for (let i = 0; i < 30; i++) await call(example, "createPage", { token, body: { slug: `seite-${i}`, title: `Seite ${i}`, status: "published" } });
      await settled(example);
      example.reading.delayMs = 60;
      await call(example, "setSettings", { token, body: { title: "Festival 2027", locale: "de" } });
      await pollUntil(async () => (await stale(example)).stale === 30);
      const uploaded = await example.kestrel.run("uploadMedia", { trigger, headers: bearer(token), files: [{ field: "file", filename: "photo.jpg", contentType: "image/jpeg", data: TEST_JPEG }] });
      expect(uploaded.status).toBe(200);
      const id = boundaryCast<{ id: string }>(uploaded.result, "json").id;
      let staleWhenAvailable = -1;
      let staleWhenDone = -1;
      await pollUntil(async () => {
        const item = boundaryCast<{ available: boolean; variantCounts: { done: number; pending: number } }>(await call(example, "getMedia", { token, params: { id } }), "json");
        const now = (await stale(example)).stale;
        if (item.available && staleWhenAvailable < 0) staleWhenAvailable = now;
        if (item.variantCounts.pending === 0 && item.variantCounts.done > 0 && staleWhenDone < 0) staleWhenDone = now;
        return staleWhenAvailable >= 0 && staleWhenDone >= 0;
      }, 20_000, 10);
      await settled(example);
      return { staleWhenAvailable, staleWhenDone };
    } finally {
      await example.dispose();
    }
  }

  it("with the pages and variants lanes, the upload is insertable and its variants are done while the re-render backlog is still pending", async () => {
    const { staleWhenAvailable, staleWhenDone } = await uploadDuringRerender({ pages: ["republishOutput", "refreshLlms"], variants: ["generateImageVariants"] });
    expect(staleWhenAvailable).toBeGreaterThanOrEqual(15);
    expect(staleWhenDone).toBeGreaterThan(0);
  }, 40_000);

  it("control: with one lane shared by page renders and variants, the variants wait for every re-render queued before them", async () => {
    const { staleWhenAvailable, staleWhenDone } = await uploadDuringRerender({ pages: ["republishOutput", "refreshLlms", "generateImageVariants"] });
    expect(staleWhenAvailable).toBeGreaterThanOrEqual(15);
    expect(staleWhenDone).toBe(0);
  }, 40_000);

  it("control: without lanes, the upload waits for every re-render queued before it", async () => {
    const { staleWhenAvailable } = await uploadDuringRerender({});
    expect(staleWhenAvailable).toBe(0);
  }, 40_000);
});

describe("examples/minimal save response: publishing in its own lane", () => {
  const lanes = { render: ["publishPage", "unpublishPage"], pages: ["republishOutput", "refreshLlms"], indexes: ["refreshIndexes"], variants: ["generateImageVariants"] };

  async function saveWhileRenderIsHeld(options: Pick<Options, "lanes" | "relayPipelines">) {
    const example = await bootExample({ mode: "queue", ...options });
    try {
      const token = boundaryCast<{ token: string }>(await call(example, "login", { body: { username: "admin", password: "kestrel-demo" } }), "json").token;
      await call(example, "setSettings", { token, body: { title: "Festival", locale: "de" } });
      const id = String((await call(example, "createPage", { token, body: { slug: "schnell", title: "Alt", status: "published" } })).id);
      await settled(example);
      expect(page(example, "/schnell")).toContain("<h1>Alt</h1>");
      const gate = example.reading.hold("/schnell");
      const saved = call(example, "updatePage", { token, params: { id }, body: { title: "Neu", status: "published" } });
      const outcome = await Promise.race([saved.then((result) => ({ result })), gate.reached.then(() => "render-first" as const)]);
      const answeredFirst = outcome !== "render-first";
      gate.release();
      const response = await saved;
      await pollUntil(() => (page(example, "/schnell") ?? "").includes("<h1>Neu</h1>"));
      await settled(example);
      return { answeredFirst, response };
    } finally {
      await example.dispose();
    }
  }

  it("answers the save before the page is rendered and writes the output afterwards", async () => {
    const { answeredFirst, response } = await saveWhileRenderIsHeld({ lanes, relayPipelines: [] });
    expect(answeredFirst).toBe(true);
    const events = boundaryCast<{ status: string; pipelines: Array<{ pipeline: string; status: string }> }>(response._events, "json");
    expect(events.status).toBe("pending");
    expect(events.pipelines).toContainEqual(expect.objectContaining({ pipeline: "publishPage", status: "queued" }));
  }, 30_000);

  it("control: with the relay delivering publishPage, the render runs before the response", async () => {
    const { answeredFirst } = await saveWhileRenderIsHeld({});
    expect(answeredFirst).toBe(false);
  }, 30_000);
});
