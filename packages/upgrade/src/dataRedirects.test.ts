import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { runDataStep } from "./data.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let dir: string;
const projectRoots: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-redirects-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const root of projectRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function projectWithRedirects(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-data-redirects-test-"));
  projectRoots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
  await writeFile(join(root, "kestrel.config.ts"), `export default { modules: [{ use: "@michaelthielemann/kestrel-redirects-default", config: ${JSON.stringify(config)} }], triggers: [] };\n`);
  return root;
}

async function storeRules(file: string, rules: unknown, collection = "redirects"): Promise<void> {
  const db = createPersistenceSqlite({ file });
  await db.ensureCollection(collection, { rules: "json" });
  await db.createOne(collection, { id: "redirects", rules });
  db.close();
}

describe("runDataStep: data/redirect-reserved-paths", () => {
  it("names a stored rule at or below a reserved path and nothing else", async () => {
    const root = await projectWithRedirects({});
    const file = join(dir, "kestrel.db");
    await storeRules(file, [
      { from: "/blog/*", to: "/artikel/$1" },
      { from: "/admin/login", to: "/x" },
      { from: "/administration", to: "/y" },
      { from: "api", to: "/z" },
    ]);
    const result = await runDataStep(file, root);
    const found = result.report?.findings.filter((f) => f.rule === "data/redirect-reserved-paths") ?? [];
    expect(result.exitCode).toBe(0);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", tier: "data", where: { path: "redirects" } });
    expect(found[0]?.message).toContain("2 stored redirect rule(s)");
    expect(found[0]?.message).toContain("/admin/login");
    expect(found[0]?.message).toContain("/api");
    expect(found[0]?.message).not.toContain("/administration");
  });

  it("names a stored wildcard rule that can match a reserved path, including a catch-all", async () => {
    const root = await projectWithRedirects({});
    const file = join(dir, "kestrel.db");
    await storeRules(file, [
      { from: "/**", to: "https://new.example.org/$1" },
      { from: "/*", to: "/blog/$1" },
      { from: "/*/feed", to: "/rss/$1" },
      { from: "/blog/*", to: "/artikel/$1" },
      { from: "/news/**", to: "/n/$1" },
    ]);
    const result = await runDataStep(file, root);
    const found = result.report?.findings.filter((f) => f.rule === "data/redirect-reserved-paths") ?? [];
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("3 stored redirect rule(s)");
    expect(found[0]?.message).toContain("/**, /*, /*/feed");
    expect(found[0]?.message).not.toContain("/blog/*");
    expect(found[0]?.message).not.toContain("/news/**");
  });

  it("follows the configured reserved paths and collection", async () => {
    const root = await projectWithRedirects({ type: "forwards", reservedPaths: ["/shop"] });
    const file = join(dir, "kestrel.db");
    await storeRules(file, [{ from: "/shop/cart", to: "/x" }, { from: "/admin/x", to: "/y" }], "forwards");
    const result = await runDataStep(file, root);
    const found = result.report?.findings.filter((f) => f.rule === "data/redirect-reserved-paths") ?? [];
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("/shop/cart");
    expect(found[0]?.message).not.toContain("/admin/x");
  });

  it("names a stored automatic redirect whose source is at a reserved path", async () => {
    const root = await projectWithRedirects({});
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("redirects_auto_paths", { kind: "string", type: "string", docId: "string", locale: "string", seq: "number" });
    const row = { type: "page", docId: "d1", locale: "de", seq: 1 };
    await db.createOne("redirects_auto_paths", { id: "/api/x", kind: "redirect", ...row });
    await db.createOne("redirects_auto_paths", { id: "/media", kind: "redirect", ...row });
    await db.createOne("redirects_auto_paths", { id: "/old-news", kind: "redirect", ...row });
    await db.createOne("redirects_auto_paths", { id: "/admin/y", kind: "live", ...row });
    await db.createOne("redirects_auto_paths", { id: "/api/gone", kind: "removed", ...row });
    db.close();

    const result = await runDataStep(file, root);
    const found = result.report?.findings.filter((f) => f.rule === "data/redirect-reserved-paths") ?? [];
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", tier: "data", where: { path: "redirects_auto_paths" } });
    expect(found[0]?.message).toContain("2 stored automatic redirect(s)");
    expect(found[0]?.message).toContain("/api/x");
    expect(found[0]?.message).toContain("/media");
    expect(found[0]?.message).not.toContain("/old-news");
    expect(found[0]?.message).not.toContain("/admin/y");
    expect(found[0]?.message).not.toContain("/api/gone");
  });

  it("stays quiet without stored rules, without the module and for rules that are not a list", async () => {
    const withModule = await projectWithRedirects({});
    const file = join(dir, "kestrel.db");
    const result = await runDataStep(file.replace("kestrel.db", "missing.db"), withModule);
    expect(result.exitCode).toBe(2);

    await storeRules(file, "not a list");
    expect((await runDataStep(file, withModule)).report?.findings.filter((f) => f.rule === "data/redirect-reserved-paths")).toEqual([]);

    const bare = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-data-redirects-test-"));
    projectRoots.push(bare);
    await writeFile(join(bare, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
    await writeFile(join(bare, "kestrel.config.ts"), "export default { modules: [], triggers: [] };\n");
    const other = join(dir, "other.db");
    await storeRules(other, [{ from: "/admin/x", to: "/y" }]);
    expect((await runDataStep(other, bare)).report?.findings.filter((f) => f.rule === "data/redirect-reserved-paths")).toEqual([]);
  });
});
