import { describe, it, expect } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { PERSISTENCE, type Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext, DONE } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { createRedirects, requestPath } from "./impl.ts";
import module from "./module.ts";
import { RedirectRuleError } from "./rules.ts";

const config = { type: "redirects", field: "rules", prefix: "site/", key: "redirects.json", reservedPaths: ["/admin", "/api"] };

function fakeContent(initial?: unknown): { content: Content; reads: () => number; set(rules: unknown, updatedAt: number): void } {
  let doc: ContentDocument | null = initial === undefined ? null : ({ id: "redirects", createdAt: 1, updatedAt: 1, rules: initial } as const);
  let reads = 0;
  const content: Pick<Content, "get"> = {
    async get(type: string) {
      reads += 1;
      return ok(type === "redirects" ? doc : null);
    },
  };
  return { content: boundaryCast<Content>(content, "host"), reads: () => reads, set: (rules, updatedAt) => (doc = { id: "redirects", createdAt: 1, updatedAt, rules } as const) };
}

function fakeBlobs(failPut = false): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
    async put(k, data, options) {
      if (failPut) return err(failure("TRANSIENT", "s3 down"));
      blobs.set(k, { data, contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(k) {
      return ok(blobs.get(k)?.data ?? null);
    },
    async remove(k) {
      blobs.delete(k);
      return ok();
    },
    async move(from, to) {
      const b = blobs.get(from);
      if (!b) return err(failure("NOT_FOUND", `${from} not found`));
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list() {
      return ok([]);
    },
  };
}

function stubLogger() {
  const errors: string[] = [];
  const logger: Logger = { step() {}, info() {}, error: (m) => errors.push(m) };
  return { logger, errors };
}

const rules = [{ from: "/blog/*", to: "/artikel/$1" }, { from: "/event", to: "/aktion", status: "302" }];

describe("requestPath", () => {
  it("adds the leading slash and strips the query", () => {
    expect(requestPath("blog/x?y=1")).toBe("/blog/x");
    expect(requestPath("")).toBe("/");
    expect(requestPath("/a/")).toBe("/a/");
  });
});

describe("validate", () => {
  it("accepts good rules and absent rules, rejects bad rows with the row number", async () => {
    const r = await createRedirects(config, { content: fakeContent().content, blobs: fakeBlobs(), db: createFakePersistence(), logger: stubLogger().logger });
    expect(expectOk(await r.validate(rules))).toBeUndefined();
    expect(expectOk(await r.validate(null))).toBeUndefined();
    await expect(r.validate([{ from: "/a", to: "/b/$1" }])).rejects.toThrow(RedirectRuleError);
    await expect(r.validate([{ from: "/a", to: "/b/$1" }])).rejects.toThrow(/^Row 1:/);
  });
});

describe("reserved paths", () => {
  it("validate rejects a source under a reserved path with the row number", async () => {
    const r = await createRedirects(config, { content: fakeContent().content, blobs: fakeBlobs(), db: createFakePersistence(), logger: stubLogger().logger });
    await expect(r.validate([{ from: "/a", to: "/b" }, { from: "/admin/x", to: "/c" }])).rejects.toThrow(/^Row 2: .*reserved path \/admin/);
  });
  it("lookup and export leave out a stored rule under a reserved path and log it", async () => {
    const stored = [{ from: "/admin/login", to: "/gone" }, { from: "/old", to: "/new" }];
    const { logger, errors } = stubLogger();
    const c = fakeContent(stored);
    const blobs = fakeBlobs();
    const r = await createRedirects(config, { content: c.content, blobs, db: createFakePersistence(), logger });
    expect(expectOk(await r.lookup("/admin/login"))).toBeNull();
    expect(expectOk(await r.lookup("/old"))).toEqual({ to: "/new", status: 301 });
    expect(errors.some((line) => /Row 1: .*reserved path \/admin/.test(line))).toBe(true);
    const exported = expectOk(await r.export());
    expect(exported.rules).toBe(1);
    expect(exported.skipped).toEqual([expect.stringMatching(/^Row 1: .*reserved path/)]);
  });
});

describe("lookup", () => {
  it("matches first-wins, substitutes $n, returns null without a hit or without a singleton", async () => {
    const c = fakeContent(rules);
    const r = await createRedirects(config, { content: c.content, blobs: fakeBlobs(), db: createFakePersistence(), logger: stubLogger().logger });
    expect(expectOk(await r.lookup("/blog/hallo"))).toEqual({ to: "/artikel/hallo", status: 301 });
    expect(expectOk(await r.lookup("/event/"))).toEqual({ to: "/aktion", status: 302 });
    expect(expectOk(await r.lookup("/nope"))).toBeNull();
    const empty = await createRedirects(config, { content: fakeContent().content, blobs: fakeBlobs(), db: createFakePersistence(), logger: stubLogger().logger });
    expect(expectOk(await empty.lookup("/blog/x"))).toBeNull();
  });
  it("recompiles only when updatedAt changes and skips broken rows once per version", async () => {
    const c = fakeContent(rules);
    const { logger, errors } = stubLogger();
    const r = await createRedirects(config, { content: c.content, blobs: fakeBlobs(), db: createFakePersistence(), logger });
    await r.lookup("/a");
    await r.lookup("/b");
    expect(c.reads()).toBe(2);
    c.set([{ from: "/bad?x", to: "/c" }, { from: "/neu", to: "/n" }], 2);
    expect(expectOk(await r.lookup("/neu"))).toEqual({ to: "/n", status: 301 });
    expect(expectOk(await r.lookup("/neu"))).toEqual({ to: "/n", status: 301 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Row 1/);
  });
  it("passes a persistence failure through as TRANSIENT", async () => {
    const content: Pick<Content, "get"> = { async get() { return err(failure("TRANSIENT", "db busy")); } };
    const r = await createRedirects(config, { content: boundaryCast<Content>(content, "host"), blobs: fakeBlobs(), db: createFakePersistence(), logger: stubLogger().logger });
    const error = expectErr(await r.lookup("/x"), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("lookup with a malformed rule list", () => {
  it("fails open (null, one logger error, no repeat on the second lookup)", async () => {
    const c = fakeContent({ a: 1 });
    const { logger, errors } = stubLogger();
    const r = await createRedirects(config, { content: c.content, blobs: fakeBlobs(), db: createFakePersistence(), logger });
    expect(expectOk(await r.lookup("/x"))).toBeNull();
    expect(expectOk(await r.lookup("/x"))).toBeNull();
    expect(errors).toHaveLength(1);
  });
  it("export still throws – a broken container must not silently publish []", async () => {
    const c = fakeContent({ a: 1 });
    const r = await createRedirects(config, { content: c.content, blobs: fakeBlobs(), db: createFakePersistence(), logger: stubLogger().logger });
    await expect(r.export()).rejects.toThrow(/must be a list/);
  });
});

describe("export", () => {
  it("writes the compiled list to prefix+key and reports skipped rows", async () => {
    const c = fakeContent([...rules, { from: "/bad?x", to: "/c" }]);
    const blobs = fakeBlobs();
    const { logger, errors } = stubLogger();
    const r = await createRedirects(config, { content: c.content, blobs, db: createFakePersistence(), logger });
    const out = expectOk(await r.export());
    expect(out).toEqual({ rules: 2, skipped: [expect.stringMatching(/^Row 3:/)] });
    expect(errors).toHaveLength(1);
    const blob = blobs.blobs.get("site/redirects.json");
    expect(blob?.contentType).toBe("application/json");
    const parsed = boundaryCast<Array<{ target: string; status: number }>>(JSON.parse(new TextDecoder().decode(blob?.data)), "json");
    expect(parsed.map((x) => [x.target, x.status])).toEqual([["/artikel/$1", 301], ["/aktion", 302]]);
  });
  it("writes [] when the singleton is absent and passes a blobstore failure through as TRANSIENT", async () => {
    const blobs = fakeBlobs();
    const r = await createRedirects(config, { content: fakeContent().content, blobs, db: createFakePersistence(), logger: stubLogger().logger });
    expect(expectOk(await r.export())).toEqual({ rules: 0, skipped: [] });
    expect(new TextDecoder().decode(blobs.blobs.get("site/redirects.json")?.data)).toBe("[]");
    const failing = await createRedirects(config, { content: fakeContent(rules).content, blobs: fakeBlobs(true), db: createFakePersistence(), logger: stubLogger().logger });
    const error = expectErr(await failing.export(), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("render", () => {
  it("returns the publishable rules", async () => {
    const r = await createRedirects(config, { content: fakeContent(rules).content, blobs: fakeBlobs(), db: createFakePersistence(), logger: stubLogger().logger });
    expect(expectOk(await r.render()).map((x) => x.target)).toEqual(["/artikel/$1", "/aktion"]);
    const empty = await createRedirects(config, { content: fakeContent().content, blobs: fakeBlobs(), db: createFakePersistence(), logger: stubLogger().logger });
    expect(expectOk(await empty.render())).toEqual([]);
  });
});

describe("module steps", () => {
  async function steps(initial?: unknown, blobs = fakeBlobs(), db: Persistence = createFakePersistence()) {
    const c = fakeContent(initial);
    const { logger } = stubLogger();
    const deps: Deps = {
      get<T>(contract: Contract<T>): T {
        if (contract.name === "content@1") return boundaryCast<T>(c.content, "host");
        if (contract.name === PERSISTENCE.name) return boundaryCast<T>(db, "host");
        return boundaryCast<T>(blobs, "host");
      },
      find: () => undefined,
      logger,
      root: process.cwd(),
      eventTriggers: [],
    };
    const instance = await module.setup(module.configSchema.parse({ prefix: "site/" }), deps);
    return module.steps!(instance);
  }
  const ctx = (params: Record<string, string> = {}, payload: Record<string, unknown> = {}) => createContext({ trigger: { kind: "http", name: "GET /site/*path" }, params, payload });

  it("lookup ends the pipeline with a redirect result, passes through otherwise", async () => {
    const s = await steps(rules);
    const done = expectOk(await s.lookup(ctx({ path: "blog/x?a=1" })));
    expect(done.result).toEqual({ redirect: { to: "/artikel/x", status: 301 } });
    expect(Reflect.get(done, DONE)).toBe(true);
    const passedThrough = expectOk(await s.lookup(ctx({ path: "kein-treffer" })));
    expect(passedThrough).toMatchObject({ params: { path: "kein-treffer" } });
    expect(Reflect.get(passedThrough, DONE)).toBeUndefined();
  });

  it("lookup wins over what a later site.resolve would find (ctx.done short-circuits the pipeline)", async () => {
    const s = await steps(rules);
    const done = expectOk(await s.lookup(ctx({ path: "event" })));
    expect(done.result).toEqual({ redirect: { to: "/aktion", status: 302 } });
  });

  it("lookup keeps an absolute https:// target unchanged, substituting $1", async () => {
    const s = await steps([{ from: "/old/*", to: "https://new.example.com/$1" }]);
    const done = expectOk(await s.lookup(ctx({ path: "old/hallo" })));
    expect(done.result).toEqual({ redirect: { to: "https://new.example.com/hallo", status: 301 } });
  });
  it("validate fails with VALIDATION and the row message, passes absent field", async () => {
    const s = await steps();
    const error = expectErr(await s.validate(ctx({}, { rules: [{ from: "/a", to: "/$1" }] })), "VALIDATION");
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^redirects: Row 1/);
    expect(error.details).toEqual({ row: 1 });
    expect(expectOk(await s.validate(ctx({}, {}))).result).toBeUndefined();
  });
  it("export returns a summary and passes a blobstore TRANSIENT failure through", async () => {
    const ok1 = await steps(rules);
    expect(expectOk(await ok1.export(ctx())).result).toMatchObject({ redirects: { rules: 2, skipped: [] } });
    const withPrevious = { ...ctx(), result: { documents: 3 } };
    const merged = expectOk(await ok1.export(withPrevious));
    expect(merged.result).toEqual({ documents: 3, redirects: { rules: 2, skipped: [] } });
    const bad = await steps(rules, fakeBlobs(true));
    const error = expectErr(await bad.export(ctx()), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
  it("render sets the rule list as result", async () => {
    const s = await steps(rules);
    const result = expectOk(await s.render(ctx())).result as Array<{ status: number }>;
    expect(result).toEqual([expect.objectContaining({ status: 301 }), expect.objectContaining({ status: 302 })]);
  });
});
