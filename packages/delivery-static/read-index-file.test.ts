import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlobstoreFilesystem } from "@michaelthielemann/kestrel-blobstore-filesystem/impl";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { CONTENT, type ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { RENDERER, type Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { SITE, type Site } from "@michaelthielemann/kestrel-contracts/site";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { responseForRun } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isBinaryResult } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps, StepDescription } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { isKestrelBootError } from "@michaelthielemann/kestrel/errors";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { INDEX_FILE_NAMES, INDEX_FILE_TYPES, isIndexFileName, type Delivery } from "./impl.ts";
import module, { configSchema } from "./module.ts";

const model: ContentModel = {
  locales: ["de"],
  defaultLocale: "de",
  types: {
    pages: { kind: "multi", fields: { slug: { type: "slug", required: true }, title: { type: "text", required: true }, status: { type: "enum", options: ["draft", "published"] } } },
    settings: { kind: "single", fields: { title: { type: "text" }, description: { type: "text" } } },
  },
};

const site: Site = {
  resolve: () => Promise.reject(new Error("not used")),
  pathOf(_type, doc) {
    return typeof doc.slug === "string" && doc.slug !== "" ? (doc.slug === "home" ? "/" : `/${doc.slug}`) : null;
  },
  resolveLinks: async (_type, doc) => ok({ ...doc, _links: {} }),
};

const renderer: Renderer = {
  formats: () => ["html"],
  async render(input) {
    return ok({ data: `<html><body><main><h1>${String(input.document.title)}</h1></main></body></html>`, contentType: "text/html", extension: "html" });
  },
};

const roots: string[] = [];
const instances: Delivery[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-delivery-index-file-"));
  roots.push(root);
  return root;
}

async function setUp(options: { blobs?: Blobstore; config?: Record<string, unknown> } = {}) {
  const root = await freshRoot();
  const blobs = options.blobs ?? createBlobstoreFilesystem({ root });
  const db = createFakePersistence();
  const content = await createContentDefault(model, db);
  const providers = new Map<string, unknown>([
    [CONTENT.name, content],
    [SITE.name, site],
    [RENDERER.name, renderer],
    [BLOBSTORE.name, blobs],
    [PERSISTENCE.name, db],
  ]);
  const deps: Deps = {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(providers.get(contract.name), "host");
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root: process.cwd(),
    eventTriggers: [],
  };
  const config = configSchema.parse({ types: { pages: {} }, prefix: "site/", siteUrl: "https://example.org", robots: { policy: "allow" }, llms: { full: true }, ...options.config });
  const instance = boundaryCast<Delivery>(await module.setup(config, deps), "host");
  instances.push(instance);
  const publishPage = async (slug: string, title: string): Promise<void> => {
    const created = expectOk(await content.create("pages", { slug, title, status: "published" }));
    expectOk(await instance.publish("pages", created.id));
  };
  const read = (name: string) => runPipeline(definePipeline({ name: "readIndexFile", steps: [`delivery.readIndexFile:${name}`] }), {}, { modules: [{ module, instance }] });
  return { root, instance, publishPage, read };
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

const EXPECTED_TYPES: Record<string, string> = {
  "sitemap.xml": "application/xml; charset=utf-8",
  "robots.txt": "text/plain; charset=utf-8",
  "llms.txt": "text/plain; charset=utf-8",
  "llms-full.txt": "text/plain; charset=utf-8",
};

describe("delivery.readIndexFile", () => {
  it("answers each exported index file with the bytes under the prefix and the content type the export wrote it with", async () => {
    const s = await setUp();
    await s.publishPage("home", "Start");
    await s.publishPage("kontakt", "Kontakt");
    expectOk(await s.instance.exportIndexes());
    expectOk(await s.instance.exportLlmsFull());

    for (const [name, contentType] of Object.entries(EXPECTED_TYPES)) {
      const stored = new Uint8Array(await readFile(join(s.root, "site", name)));
      const run = await s.read(name);
      expect(run.status, name).toBe(200);
      const result = run.result;
      if (!isBinaryResult(result)) throw new Error(`${name}: the result is not a file`);
      expect(Buffer.from(result.data).equals(Buffer.from(stored)), name).toBe(true);
      expect(result.contentType, name).toBe(contentType);
      expect(result.filename, name).toBe(name);
      expect(result.headers, name).toEqual({ etag: `"${sha256(stored)}"`, "cache-control": "no-cache" });
    }
  });

  it("goes out over HTTP with the export's content type, its exact bytes and the step's caching headers", async () => {
    const s = await setUp();
    await s.publishPage("home", "Start");
    expectOk(await s.instance.exportIndexes());
    const stored = await readFile(join(s.root, "site", "sitemap.xml"));
    const response = responseForRun(await s.read("sitemap.xml"), ["application/xml", "text/plain"]);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/xml; charset=utf-8");
    expect(response.headers["content-length"]).toBe(String(stored.byteLength));
    expect(response.headers.etag).toBe(`"${sha256(stored)}"`);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["content-disposition"]).toBe('inline; filename="sitemap.xml"');
    expect(Buffer.from(response.body).equals(stored)).toBe(true);
  });

  it("answers 404 NOT_FOUND for a file no export wrote, and starts no export", async () => {
    const s = await setUp();
    await s.publishPage("home", "Start");
    for (const name of Object.keys(EXPECTED_TYPES)) {
      const run = await s.read(name);
      expect(run.status, name).toBe(404);
      expect(run.code, name).toBe("NOT_FOUND");
    }
    const written = await readdir(join(s.root, "site"));
    expect(written.filter((file) => file in EXPECTED_TYPES)).toEqual([]);
  });

  it("answers 404 for llms-full.txt while llms.full is off, next to the other three files", async () => {
    const s = await setUp({ config: { llms: { full: false } } });
    await s.publishPage("home", "Start");
    expectOk(await s.instance.exportIndexes());
    expect((await s.read("llms.txt")).status).toBe(200);
    expect((await s.read("llms-full.txt")).status).toBe(404);
  });

  it("reads under the configured prefix only", async () => {
    const s = await setUp();
    await writeFile(join(s.root, "robots.txt"), "User-agent: *\nDisallow: /\n");
    const run = await s.read("robots.txt");
    expect(run.status).toBe(404);
  });

  it("refuses any name outside the four index files when the pipeline is built", async () => {
    const s = await setUp();
    for (const name of ["index.html", "redirects.json", "../robots.txt", "site/robots.txt", "Sitemap.xml", "robots.txt/", "llms.txt?x=1"]) {
      let thrown: unknown;
      try {
        await s.read(name);
      } catch (error) {
        thrown = error;
      }
      expect(isKestrelBootError(thrown), name).toBe(true);
      if (isKestrelBootError(thrown)) {
        expect(thrown.code, name).toBe("step-argument");
        expect(thrown.reason, name).toContain("sitemap.xml, robots.txt, llms.txt, llms-full.txt");
      }
    }
  });

  it("keeps the list of readable names fixed at runtime", () => {
    expect(Object.isFrozen(INDEX_FILE_NAMES)).toBe(true);
    expect(Object.isFrozen(INDEX_FILE_TYPES)).toBe(true);
    expect(() => boundaryCast<string[]>(INDEX_FILE_NAMES, "host").push("index.html")).toThrow(TypeError);
    expect(isIndexFileName("index.html")).toBe(false);
  });

  it("answers 503 TRANSIENT when the blob store cannot be read", async () => {
    const failing: Blobstore = {
      put: async () => ok(),
      get: async () => err(failure("TRANSIENT", "store unavailable")),
      remove: async () => ok(),
      move: async () => ok(),
      list: async () => ok([]),
    };
    const s = await setUp({ blobs: failing });
    const run = await s.read("sitemap.xml");
    expect(run.status).toBe(503);
    expect(run.code).toBe("TRANSIENT");
  });

  it("hashes a file of several megabytes in slices, letting other work run in between", async () => {
    const data = new Uint8Array(3 * 1024 * 1024 + 7).map((_, index) => index % 251);
    const store: Blobstore = {
      put: async () => ok(),
      get: async () => ok(data),
      remove: async () => ok(),
      move: async () => ok(),
      list: async () => ok([]),
    };
    const s = await setUp({ blobs: store });
    let done = false;
    let turns = 0;
    const tick = (): void => {
      if (done) return;
      turns += 1;
      setImmediate(tick);
    };
    const reading = s.read("llms-full.txt");
    setImmediate(tick);
    const run = await reading;
    done = true;
    expect(run.status).toBe(200);
    const result = run.result;
    if (!isBinaryResult(result)) throw new Error("the result is not a file");
    expect(result.headers?.etag).toBe(`"${sha256(data)}"`);
    expect(turns).toBeGreaterThanOrEqual(3);
  });

  it("answers 404 when the blob store reports the key as not found", async () => {
    const missing: Blobstore = {
      put: async () => ok(),
      get: async () => err(failure("NOT_FOUND", "no such key")),
      remove: async () => ok(),
      move: async () => ok(),
      list: async () => ok([]),
    };
    const s = await setUp({ blobs: missing });
    const run = await s.read("llms.txt");
    expect(run.status).toBe(404);
    expect(run.code).toBe("NOT_FOUND");
  });

  it("is described as a public file read that needs no permission and writes nothing", async () => {
    const s = await setUp();
    const describeMap = boundaryCast<Record<string, StepDescription | ((arg: string) => StepDescription)>>(module.describe!(s.instance), "host");
    const entry = describeMap.readIndexFile;
    if (typeof entry !== "function") throw new Error("readIndexFile is not described per argument");
    const described = entry("sitemap.xml");
    expect(described).toMatchObject({ reads: [], writes: ["result"], binary: true });
    expect(Object.keys(described.errors ?? {}).sort()).toEqual(["404", "503"]);
    expect(described.summary).toContain("sitemap.xml");
    expect(described.summary).toContain("no permission check");
    expect(described.atomicSafe).not.toBe(true);
  });
});
