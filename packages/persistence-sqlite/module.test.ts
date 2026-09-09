import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { PersistenceSqlite } from "./impl.ts";
import module, { configSchema } from "./module.ts";

const deps: Deps = {
  get<T>(contract: Contract<T>): T {
    throw new Error(`no provider for "${contract.name}"`);
  },
  find: <T>(): T | undefined => undefined,
  logger: silentLogger,
  root: process.cwd(),
};

async function boot(): Promise<PersistenceSqlite> {
  const instance = (await module.setup(configSchema.parse({ file: ":memory:" }), deps)) as PersistenceSqlite;
  await instance.ensureCollection("t", { a: "string" });
  return instance;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("persistence/sqlite module via runPipeline", () => {
  it("createOne stores the body and findOne reads it back by params.id", async () => {
    const instance = await boot();
    const create = definePipeline({ name: "create", steps: ["persistence.createOne:t"] });
    const created = await runPipeline(create, { body: { a: "x" } }, { modules: [{ module, instance }] });
    expect(created.status).toBe(200);
    const id = (created.result as { id: string }).id;

    const find = definePipeline({ name: "find", steps: ["persistence.findOne:t"] });
    const found = await runPipeline(find, { params: { id } }, { modules: [{ module, instance }] });
    expect(found.status).toBe(200);
    expect(found.result).toEqual({ id, a: "x" });
    instance.close();
  });

  it("createOne rejects a non-object body as VALIDATION before the step runs", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "create-invalid", steps: ["persistence.createOne:t"] });
    const result = await runPipeline(pipeline, { body: JSON.parse("[]") as Record<string, unknown> }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
    instance.close();
  });

  it("findMany lists every document", async () => {
    const instance = await boot();
    expectOk(await instance.createOne("t", { a: "x" }));
    const pipeline = definePipeline({ name: "findMany", steps: ["persistence.findMany:t"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect((result.result as { total: number }).total).toBe(1);
    instance.close();
  });

  it("updateOne patches the document named by params.id", async () => {
    const instance = await boot();
    const created = expectOk(await instance.createOne("t", { a: "x" }));
    const pipeline = definePipeline({ name: "update", steps: ["persistence.updateOne:t"] });
    const result = await runPipeline(pipeline, { params: { id: created.id }, body: { a: "y" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toEqual({ id: created.id, a: "y" });
    instance.close();
  });

  it("updateOne answers VALIDATION without params.id", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "update-no-id", steps: ["persistence.updateOne:t"] });
    const result = await runPipeline(pipeline, { body: { a: "y" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
    instance.close();
  });

  it("deleteOne removes the document named by params.id", async () => {
    const instance = await boot();
    const created = expectOk(await instance.createOne("t", { a: "x" }));
    const pipeline = definePipeline({ name: "delete", steps: ["persistence.deleteOne:t"] });
    const result = await runPipeline(pipeline, { params: { id: created.id } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toEqual({ ok: true });
    instance.close();
  });

  it("checkpoint runs without a payload", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "checkpoint", steps: ["persistence.checkpoint"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    instance.close();
  });

  it("snapshot writes a copy of the database to the given file", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-mod-"));
    dirs.push(dir);
    const instance = await boot();
    const file = join(dir, "copy.db");
    const pipeline = definePipeline({ name: "snapshot", steps: [`persistence.snapshot:${file}`] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toEqual({ file });
    instance.close();
  });
});
