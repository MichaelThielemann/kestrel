import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importInstalled, resolveInstalled } from "./installed.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function project(dependencies: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kestrel-upgrade-installed-"));
  roots.push(root);
  write(join(root, "package.json"), JSON.stringify({ name: "app", type: "module", dependencies }));
  return root;
}

function storagePackage(dir: string, marker: string): void {
  write(join(dir, "package.json"), JSON.stringify({ name: "@example/storage-module", version: "1.0.0", type: "module", exports: { "./storage": "./storage.js" } }));
  write(join(dir, "storage.js"), `export const marker = ${JSON.stringify(marker)};\n`);
}

describe("resolving a package the way the project finds it", () => {
  it("prefers the project's own dependency", async () => {
    const root = project({ "@example/storage-module": "1.0.0" });
    storagePackage(join(root, "node_modules", "@example", "storage-module"), "own");
    expect(resolveInstalled(root, "@example/storage-module/storage")).toBe(join(root, "node_modules", "@example", "storage-module", "storage.js"));
    expect(await importInstalled(root, "@example/storage-module/storage")).toMatchObject({ marker: "own" });
  });

  it("finds a package that only a direct dependency brings along", async () => {
    const root = project({ "example-preset": "1.0.0" });
    const preset = join(root, "node_modules", "example-preset");
    write(join(preset, "package.json"), JSON.stringify({ name: "example-preset", version: "1.0.0", dependencies: { "@example/storage-module": "1.0.0" } }));
    storagePackage(join(preset, "node_modules", "@example", "storage-module"), "through the preset");
    expect(await importInstalled(root, "@example/storage-module/storage")).toMatchObject({ marker: "through the preset" });
  });

  it("answers undefined for a package nobody installed", async () => {
    const root = project({});
    expect(resolveInstalled(root, "@example/storage-module/storage")).toBeUndefined();
    expect(await importInstalled(root, "@example/storage-module/storage")).toBeUndefined();
  });
});
