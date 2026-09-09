import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import type { RunResult } from "@michaelthielemann/kestrel/runner";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module, { configSchema } from "./module.ts";

const rules = [{ from: "/blog/*", to: "/artikel/$1" }, { from: "/event", to: "/aktion", status: "302" }];

function fakeContent(initial?: unknown): Content {
  const doc = (initial === undefined ? null : { id: "redirects", createdAt: 1, updatedAt: 1, rules: initial }) as ContentDocument | null;
  const notImplemented = () => Promise.reject(new Error("not needed"));
  return { model: () => ({ types: {} }), validate: () => ({ ok: true, data: {} }), async get() { return ok(doc); }, list: notImplemented, create: notImplemented, set: notImplemented, update: notImplemented, remove: notImplemented, removeTranslation: notImplemented };
}

function fakeBlobs(): Blobstore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(k, data) {
      blobs.set(k, data);
      return ok();
    },
    async get(k) {
      return ok(blobs.get(k) ?? null);
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

async function boot(initial?: unknown) {
  const providers = new Map<string, unknown>([[CONTENT.name, fakeContent(initial)], [BLOBSTORE.name, fakeBlobs()]]);
  const deps: Deps = {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return providers.get(contract.name) as T;
    },
    find: <T>(contract: Contract<T>): T | undefined => providers.get(contract.name) as T | undefined,
    logger: silentLogger,
    root: process.cwd(),
  };
  const config = configSchema.parse({ prefix: "site/" });
  const instance = await module.setup(config, deps);
  return { instance };
}

function run(steps: string[], input: Record<string, unknown>, instance: unknown): Promise<RunResult> {
  return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }] });
}

describe("redirects/default module steps", () => {
  it("validate accepts good rules and rejects a bad row with the row number", async () => {
    const { instance } = await boot();
    const good = await run(["redirects.validate"], { body: { rules } }, instance);
    expect(good.status).toBe(200);
    const bad = await run(["redirects.validate"], { body: { rules: [{ from: "/a", to: "/b/$1" }] } }, instance);
    expect(bad.status).toBe(400);
    expect(bad.code).toBe("VALIDATION");
    expect(bad.details).toEqual({ row: 1 });
  });

  it("lookup ends the pipeline with a redirect on a hit, passes through otherwise", async () => {
    const { instance } = await boot(rules);
    const hit = await run(["redirects.lookup"], { params: { path: "blog/x" } }, instance);
    expect(hit.status).toBe(200);
    expect(hit.result).toEqual({ redirect: { to: "/artikel/x", status: 301 } });
    const miss = await run(["redirects.lookup"], { params: { path: "nope" } }, instance);
    expect(miss.status).toBe(200);
    expect(miss.result).toBeUndefined();
  });

  it("export writes the compiled list and reports the summary", async () => {
    const { instance } = await boot(rules);
    const res = await run(["redirects.export"], {}, instance);
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ redirects: { rules: 2, skipped: [] } });
  });

  it("render answers the compiled rule list", async () => {
    const { instance } = await boot(rules);
    const res = await run(["redirects.render"], {}, instance);
    expect(res.status).toBe(200);
    expect((res.result as Array<{ status: number }>).map((r) => r.status)).toEqual([301, 302]);
  });

  it("rejects a rules field of the wrong type with 400 VALIDATION from the body schema", async () => {
    const { instance } = await boot();
    const res = await run(["redirects.validate"], { body: { rules: "nope" } }, instance);
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(res.details?.problems).toEqual([{ path: "$.rules", message: "expected array, got string" }]);
  });
});
