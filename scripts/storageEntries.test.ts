import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_PACKAGES = ["zod"];

const BLOCKING_HOOKS = `
import { isBuiltin, registerHooks } from "node:module";
const allowed = new Set(${JSON.stringify(ALLOWED_PACKAGES)});
const packageOf = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
registerHooks({
  resolve(specifier, context, next) {
    const relative = /^(\\.{1,2}\\/|\\/|file:|data:)/.test(specifier);
    if (!relative && !isBuiltin(specifier) && !specifier.startsWith("@michaelthielemann/") && !allowed.has(packageOf(specifier))) {
      process.stderr.write("blocked: " + packageOf(specifier) + "\\n");
      throw Object.assign(new Error("Cannot find package '" + specifier + "'"), { code: "ERR_MODULE_NOT_FOUND" });
    }
    return next(specifier, context);
  },
});
`;

function storageEntries(): { name: string; entry: string }[] {
  return readdirSync(join(root, "packages"))
    .filter((dir) => existsSync(join(root, "packages", dir, "package.json")))
    .flatMap((dir) => {
      const pkg: unknown = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
      const exports: unknown = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "exports") : undefined;
      const entry: unknown = typeof exports === "object" && exports !== null ? Reflect.get(exports, "./storage") : undefined;
      return typeof entry === "string" ? [{ name: dir, entry: join(root, "packages", dir, entry) }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe("module ./storage entries", () => {
  const entries = storageEntries();

  it("include the media and image modules", () => {
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(["images-default", "media-default"]));
  });

  it.each(entries)("$name/storage loads with no third-party package resolvable but zod, so a storage migration runs without native image libraries", ({ entry }) => {
    const probe = `const mod = await import(${JSON.stringify(pathToFileURL(entry).href)}); if (typeof mod.storage !== "function") { process.stderr.write("no storage() export\\n"); process.exit(3); }`;
    const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", `data:text/javascript,${encodeURIComponent(BLOCKING_HOOKS)}`, "--input-type=module", "--eval", probe], { cwd: root, encoding: "utf8", timeout: 60_000 });
    expect(run.stderr.match(/^blocked: .*$/gm) ?? []).toEqual([]);
    expect(run.status, run.stderr).toBe(0);
  });
});
