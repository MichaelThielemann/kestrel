import { describe, it, expect } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext, DONE } from "@michaelthielemann/kestrel/context";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { createRedirects, requestPath } from "./impl.ts";
import module from "./module.ts";
import { RedirectRuleError } from "./rules.ts";

const config = { type: "redirects", field: "rules", prefix: "site/", key: "redirects.json" };

function fakeContent(initial?: unknown): { content: Content; reads: () => number; set(rules: unknown, updatedAt: number): void } {
  let doc: ContentDocument | null = initial === undefined ? null : ({ id: "redirects", createdAt: 1, updatedAt: 1, rules: initial } as const);
  let reads = 0;
  const content: Pick<Content, "get"> = {
    async get(type: string) {
      reads += 1;
      return ok(type === "redirects" ? doc : null);
    },
  };
  return { content: content as Content, reads: () => reads, set: (rules, updatedAt) => (doc = { id: "redirects", createdAt: 1, updatedAt, rules } as const) };
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
  it("accepts good rules and absent rules, rejects bad rows with the row number", () => {
    const r = createRedirects(config, { content: fakeContent().content, blobs: fakeBlobs(), logger: stubLogger().logger });
    expect(() => r.validate(rules)).not.toThrow();
    expect(() => r.validate(null)).not.toThrow();
    expect(() => r.validate([{ from: "/a", to: "/b/$1" }])).toThrow(RedirectRuleError);
    expect(() => r.validate([{ from: "/a", to: "/b/$1" }])).toThrow(/^Row 1:/);
  });
});

describe("lookup", () => {
  it("matches first-wins, substitutes $n, returns null without a hit or without a singleton", async () => {
    const c = fakeContent(rules);
    const r = createRedirects(config, { content: c.content, blobs: fakeBlobs(), logger: stubLogger().logger });
    expect(expectOk(await r.lookup("/blog/hallo"))).toEqual({ to: "/artikel/hallo", status: 301 });
    expect(expectOk(await r.lookup("/event/"))).toEqual({ to: "/aktion", status: 302 });
    expect(expectOk(await r.lookup("/nope"))).toBeNull();
    const empty = createRedirects(config, { content: fakeContent().content, blobs: fakeBlobs(), logger: stubLogger().logger });
    expect(expectOk(await empty.lookup("/blog/x"))).toBeNull();
  });
  it("recompiles only when updatedAt changes and skips broken rows once per version", async () => {
    const c = fakeContent(rules);
    const { logger, errors } = stubLogger();
    const r = createRedirects(config, { content: c.content, blobs: fakeBlobs(), logger });
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
    const r = createRedirects(config, { content: content as Content, blobs: fakeBlobs(), logger: stubLogger().logger });
    const error = expectErr(await r.lookup("/x"), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("lookup with a malformed rule list", () => {
  it("fails open (null, one logger error, no repeat on the second lookup)", async () => {
    const c = fakeContent({ a: 1 });
    const { logger, errors } = stubLogger();
    const r = createRedirects(config, { content: c.content, blobs: fakeBlobs(), logger });
    expect(expectOk(await r.lookup("/x"))).toBeNull();
    expect(expectOk(await r.lookup("/x"))).toBeNull();
    expect(errors).toHaveLength(1);
  });
  it("export still throws – a broken container must not silently publish []", async () => {
    const c = fakeContent({ a: 1 });
    const r = createRedirects(config, { content: c.content, blobs: fakeBlobs(), logger: stubLogger().logger });
    await expect(r.export()).rejects.toThrow(/must be a list/);
  });
});

describe("export", () => {
  it("writes the compiled list to prefix+key and reports skipped rows", async () => {
    const c = fakeContent([...rules, { from: "/bad?x", to: "/c" }]);
    const blobs = fakeBlobs();
    const { logger, errors } = stubLogger();
    const r = createRedirects(config, { content: c.content, blobs, logger });
    const out = expectOk(await r.export());
    expect(out).toEqual({ rules: 2, skipped: [expect.stringMatching(/^Row 3:/)] });
    expect(errors).toHaveLength(1);
    const blob = blobs.blobs.get("site/redirects.json");
    expect(blob?.contentType).toBe("application/json");
    const parsed = JSON.parse(new TextDecoder().decode(blob?.data)) as Array<{ target: string; status: number }>;
    expect(parsed.map((x) => [x.target, x.status])).toEqual([["/artikel/$1", 301], ["/aktion", 302]]);
  });
  it("writes [] when the singleton is absent and passes a blobstore failure through as TRANSIENT", async () => {
    const blobs = fakeBlobs();
    const r = createRedirects(config, { content: fakeContent().content, blobs, logger: stubLogger().logger });
    expect(expectOk(await r.export())).toEqual({ rules: 0, skipped: [] });
    expect(new TextDecoder().decode(blobs.blobs.get("site/redirects.json")?.data)).toBe("[]");
    const failing = createRedirects(config, { content: fakeContent(rules).content, blobs: fakeBlobs(true), logger: stubLogger().logger });
    const error = expectErr(await failing.export(), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});

describe("render", () => {
  it("returns the publishable rules", async () => {
    const r = createRedirects(config, { content: fakeContent(rules).content, blobs: fakeBlobs(), logger: stubLogger().logger });
    expect(expectOk(await r.render()).map((x) => x.target)).toEqual(["/artikel/$1", "/aktion"]);
    const empty = createRedirects(config, { content: fakeContent().content, blobs: fakeBlobs(), logger: stubLogger().logger });
    expect(expectOk(await empty.render())).toEqual([]);
  });
});

describe("module steps", () => {
  async function steps(initial?: unknown, blobs = fakeBlobs()) {
    const c = fakeContent(initial);
    const { logger } = stubLogger();
    const deps: Deps = { get: (contract) => (contract.name === "content@1" ? c.content : blobs) as never, find: () => undefined, logger, root: process.cwd() };
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

  // Actual pipeline order (redirects.lookup before site.resolve) is asserted in
  // examples/minimal/config.test.ts; here we only pin what "wins" means: ctx.done short-circuits
  // the pipeline, so a matched path never reaches a later site.resolve step regardless of
  // whether that step would also have resolved a page under the same path.
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
