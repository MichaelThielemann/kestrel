import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { runDataStep } from "./data.ts";
import type { LoadedProject, LoadResult, UpgradePlugin } from "./plugin.ts";
import type { Finding } from "./report.ts";

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

type ModuleList = Array<{ use: string; config: Record<string, unknown>; defaults?: { values: Record<string, unknown> } }>;

function hostPlugin(root: string, calls: { load: number }, loaded?: LoadResult, modulesFor: (scratch: string) => ModuleList = () => MODULES): UpgradePlugin {
  return {
    kind: "test-host",
    detect: (candidate) => candidate === root,
    load: (_root, scratch) => {
      calls.load += 1;
      const project = { kind: "test-host", configFile: join(scratch, "kestrel.config.ts"), moduleFiles: new Map(), pipelineFiles: [], input: { config: { modules: modulesFor(scratch), triggers: [] }, modules: [], pipelines: [], root: scratch } };
      return Promise.resolve(loaded ?? { project: boundaryCast<LoadedProject>(project, "host"), issues: [] });
    },
  };
}

function blobstoreAt(blobRoot: (scratch: string) => string, asDefault = false): (scratch: string) => ModuleList {
  return (scratch) => [
    asDefault
      ? { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: {}, defaults: { values: { root: blobRoot(scratch) } } }
      : { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: blobRoot(scratch) } },
    { use: "@michaelthielemann/kestrel-delivery-static", config: { prefix: "site/", media: { target: "media/" } } },
  ];
}

async function emptyDatabase(): Promise<string> {
  const file = join(dir, "kestrel.db");
  createPersistenceSqlite({ file }).close();
  return file;
}

function blobRules(findings: Finding[] | undefined): Finding[] {
  return (findings ?? []).filter((f) => f.rule === "data/site-media-leftovers" || f.rule === "data/blobstore-tmp-suffix" || f.rule === "data/blobstore-scan-incomplete");
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
    expect(failed[0]?.severity).toBe("error");
    expect(result.exitCode).toBe(1);
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

describe("runDataStep with blob paths the host plugin resolves inside its scratch copy", () => {
  async function blobData(root: string): Promise<void> {
    const leftovers = join(root, "data", "blobs", "site", "media");
    await mkdir(leftovers, { recursive: true });
    await writeFile(join(leftovers, "orphan.jpg"), "x");
    await writeFile(join(root, "data", "blobs", "hero.jpg.kestrel-tmp"), "x");
  }

  it("reads the blob store under the project when the plugin's blobstore root lies in the scratch copy", async () => {
    const root = await aliasProject();
    await blobData(root);
    const result = await runDataStep(await emptyDatabase(), root, [hostPlugin(root, { load: 0 }, undefined, blobstoreAt((scratch) => join(scratch, "data", "blobs")))]);
    const findings = blobRules(result.report?.findings);
    expect(findings.map((f) => f.rule).sort()).toEqual(["data/blobstore-tmp-suffix", "data/site-media-leftovers"]);
    expect(findings.find((f) => f.rule === "data/blobstore-tmp-suffix")?.where.path).toBe(join(root, "data", "blobs"));
    expect(findings.find((f) => f.rule === "data/site-media-leftovers")?.where.path).toBe(join(root, "data", "blobs", "site", "media"));
  });

  it("reads the blob store under the project when the scratch path comes from the entry's host defaults", async () => {
    const root = await aliasProject();
    await blobData(root);
    const result = await runDataStep(await emptyDatabase(), root, [hostPlugin(root, { load: 0 }, undefined, blobstoreAt((scratch) => join(scratch, "data", "blobs"), true))]);
    expect(blobRules(result.report?.findings).map((f) => f.rule).sort()).toEqual(["data/blobstore-tmp-suffix", "data/site-media-leftovers"]);
  });
});

describe("runDataStep when the blob store cannot be read", () => {
  const locked: string[] = [];
  afterEach(async () => {
    for (const path of locked.splice(0)) await chmod(path, 0o755);
  });

  it("names the resolved blobstore root as missing instead of reporting nothing", async () => {
    const root = await aliasProject();
    const result = await runDataStep(await emptyDatabase(), root, [hostPlugin(root, { load: 0 }, undefined, blobstoreAt(() => "./data/blobs"))]);
    const findings = blobRules(result.report?.findings);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("data/blobstore-scan-incomplete");
    expect(findings[0]?.severity).toBe("info");
    expect(findings[0]?.where.path).toBe(join(root, "data", "blobs"));
    expect(findings[0]?.message).toContain(join(root, "data", "blobs"));
    expect(findings[0]?.message).toContain("does not exist");
    expect(findings[0]?.message).toContain("data/site-media-leftovers");
    expect(findings[0]?.message).toContain("data/blobstore-tmp-suffix");
    expect(result.exitCode).toBe(0);
  });

  it("warns with the cause when the blobstore root is not a directory", async () => {
    const root = await aliasProject();
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "blobs"), "x");
    const result = await runDataStep(await emptyDatabase(), root, [hostPlugin(root, { load: 0 }, undefined, blobstoreAt(() => "./data/blobs"))]);
    const findings = blobRules(result.report?.findings);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("data/blobstore-scan-incomplete");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain("ENOTDIR");
  });

  it("warns with the cause when the delivery-static export directory cannot be read", async () => {
    const root = await aliasProject();
    await mkdir(join(root, "data", "blobs", "site"), { recursive: true });
    await writeFile(join(root, "data", "blobs", "site", "media"), "x");
    const result = await runDataStep(await emptyDatabase(), root, [hostPlugin(root, { load: 0 }, undefined, blobstoreAt(() => "./data/blobs"))]);
    const findings = blobRules(result.report?.findings);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("data/blobstore-scan-incomplete");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.where.path).toBe(join(root, "data", "blobs", "site", "media"));
    expect(findings[0]?.message).toContain("data/site-media-leftovers");
    expect(findings[0]?.message).toContain("ENOTDIR");
  });

  it("counts the directories below the blobstore root it could not read", async () => {
    const root = await aliasProject();
    const hidden = join(root, "data", "blobs", "private");
    await mkdir(hidden, { recursive: true });
    await writeFile(join(root, "data", "blobs", "hero.jpg.kestrel-tmp"), "x");
    await chmod(hidden, 0o000);
    locked.push(hidden);
    const result = await runDataStep(await emptyDatabase(), root, [hostPlugin(root, { load: 0 }, undefined, blobstoreAt(() => "./data/blobs"))]);
    const findings = blobRules(result.report?.findings);
    expect(findings.map((f) => f.rule).sort()).toEqual(["data/blobstore-scan-incomplete", "data/blobstore-tmp-suffix"]);
    const incomplete = findings.find((f) => f.rule === "data/blobstore-scan-incomplete");
    expect(incomplete?.severity).toBe("info");
    expect(incomplete?.message).toContain("1 directory");
    expect(incomplete?.message).toContain("data/blobstore-tmp-suffix");
  });
});
