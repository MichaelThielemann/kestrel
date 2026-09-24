import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { BACKEND_PACKAGE_NAMES } from "./backendPackages.ts";

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function realPackageNames(): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const pkgFile = join(PACKAGES_DIR, entry, "package.json");
    if (!statSync(join(PACKAGES_DIR, entry)).isDirectory()) continue;
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    } catch {
      continue;
    }
    const name = boundaryCast<{ name?: unknown }>(pkg, "host").name;
    if (typeof name === "string") names.push(name);
  }
  return names.sort();
}

describe("BACKEND_PACKAGE_NAMES", () => {
  it("names exactly the packages this repo ships, so a new one is never mistaken for a plugin's own", () => {
    expect([...BACKEND_PACKAGE_NAMES].sort()).toEqual(realPackageNames());
  });
});
