import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { runDataStep } from "./data.ts";
import type { LoadedProject, LoadResult, UpgradePlugin } from "./plugin.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MODULES = [
  { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./blobs" } },
  { use: "@michaelthielemann/kestrel-delivery-static", config: { prefix: "site/", media: { target: "media/" } } },
  { use: "@michaelthielemann/kestrel-redirects-default", config: {} },
  { use: "@michaelthielemann/kestrel-content-default", config: { types: { page: { fields: { title: {}, _hint: {} } } } } },
];

let dir: string;
const roots: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-data-host-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function aliasProject(): Promise<string> {
  const root = await mkdtemp(join(PACKAGE_ROOT, "__fixtures__", ".tmp-data-host-config-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
  await writeFile(join(root, "kestrel.config.ts"), `import { modules } from "#kestrel/config";\nexport default { modules, triggers: [] };\n`);
  return root;
}

function hostPlugin(root: string, calls: { load: number }, loaded?: LoadResult): UpgradePlugin {
  const project = { kind: "test-host", configFile: join(root, "kestrel.config.ts"), moduleFiles: new Map(), pipelineFiles: [], input: { config: { modules: MODULES, triggers: [] }, modules: [], pipelines: [], root } };
  return {
    kind: "test-host",
    detect: (candidate) => candidate === root,
    load: () => {
      calls.load += 1;
      return Promise.resolve(loaded ?? { project: boundaryCast<LoadedProject>(project, "host"), issues: [] });
    },
  };
}

async function storedData(root: string): Promise<string> {
  const leftovers = join(root, "blobs", "site", "media");
  await mkdir(leftovers, { recursive: true });
  await writeFile(join(leftovers, "orphan.jpg"), "x");
  await writeFile(join(root, "blobs", "hero.jpg.kestrel-tmp"), "x");
  const file = join(dir, "kestrel.db");
  const db = createPersistenceSqlite({ file });
  await db.ensureCollection("redirects", { rules: "json" });
  await db.createOne("redirects", { id: "redirects", rules: [{ from: "/admin/login", to: "/x" }] });
  await db.ensureCollection("page", { title: "string", _hint: "string" });
  await db.createOne("page", { id: "1", title: "Home", _hint: "kept" });
  db.close();
  return file;
}

describe("runDataStep with a config that loads only through the host plugin", () => {
  it("takes every module config from the host plugin, loading the project once", async () => {
    const root = await aliasProject();
    const file = await storedData(root);
    const calls = { load: 0 };
    const result = await runDataStep(file, root, [hostPlugin(root, calls)]);
    const rules = new Set(result.report?.findings.map((f) => f.rule));
    expect(rules).toEqual(new Set(["data/redirect-reserved-paths", "data/site-media-leftovers", "data/blobstore-tmp-suffix", "data/underscore-field-stored"]));
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: 1 } });
    expect(calls.load).toBe(1);
  });

  it("names the modules whose checks did not run and both causes when the host plugin cannot load the project either", async () => {
    const root = await aliasProject();
    const file = await storedData(root);
    const calls = { load: 0 };
    const result = await runDataStep(file, root, [hostPlugin(root, calls, { issues: [{ message: "the host could not read its settings" }] })]);
    const failed = result.report?.findings.filter((f) => f.rule === "data/config-load-failed") ?? [];
    expect(failed).toHaveLength(1);
    expect(failed[0]?.severity).toBe("warning");
    for (const text of ["#kestrel/config", "the host could not read its settings", "test-host", "redirects-default", "blobstore-filesystem", "delivery-static", "content-default", "data/redirect-reserved-paths", "data/site-media-leftovers", "data/blobstore-tmp-suffix"]) {
      expect(failed[0]?.message).toContain(text);
    }
    expect(result.report?.findings.filter((f) => f.rule !== "data/config-load-failed")).toEqual([]);
  });

  it("reports the module configs as not loaded although the host plugin supplies the content model", async () => {
    const root = await aliasProject();
    const file = await storedData(root);
    const calls = { load: 0 };
    const plugin = { ...hostPlugin(root, calls, { issues: [{ message: "the host could not read its settings" }] }), dataModel: () => Promise.resolve({ types: { page: { fields: { _hint: {} } } } }) };
    const result = await runDataStep(file, root, [plugin]);
    const failed = result.report?.findings.find((f) => f.rule === "data/config-load-failed");
    expect(failed?.message).toContain("redirects-default");
    expect(failed?.message).not.toContain("content-default");
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: 1 } });
  });

  it("is an error naming the modules and the cause when there is no host plugin", async () => {
    const root = await aliasProject();
    const file = await storedData(root);
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(1);
    const failed = result.report?.findings.filter((f) => f.rule === "data/config-load-failed") ?? [];
    expect(failed).toHaveLength(1);
    expect(failed[0]?.severity).toBe("error");
    expect(failed[0]?.message).toContain("#kestrel/config");
    expect(failed[0]?.message).toContain("redirects-default");
  });
});
