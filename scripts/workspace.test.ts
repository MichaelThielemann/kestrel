import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function buildablePackages(): string[] {
  return readdirSync(join(root, "packages"))
    .filter((name) => statSync(join(root, "packages", name)).isDirectory())
    .filter((name) => {
      try {
        statSync(join(root, "packages", name, "tsconfig.json"));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

describe("tsconfig.build.json", () => {
  it("references every package that has a tsconfig, so pnpm build emits a dist for all of them", () => {
    const config = JSON.parse(readFileSync(join(root, "tsconfig.build.json"), "utf-8")) as { references: { path: string }[] };
    const referenced = config.references.map((r) => r.path.replace("./packages/", "")).sort();
    expect(referenced).toEqual(buildablePackages());
  });
});

describe("core VERSION", () => {
  it("equals the core package.json version, so a bundled core reports the released number", async () => {
    const { VERSION } = await import("../packages/core/src/version.ts");
    const pkg = JSON.parse(readFileSync(join(root, "packages", "core", "package.json"), "utf-8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
