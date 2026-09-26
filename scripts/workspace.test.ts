import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { ModuleDefinition } from "../packages/core/src/defineModule.ts";

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

function modulePackages(): string[] {
  return readdirSync(join(root, "packages"))
    .filter((name) => existsSync(join(root, "packages", name, "module.ts")))
    .sort();
}

describe("config secrets", () => {
  it("every package marks a credential-looking config variable in its schema, so the manifest shows no value for it", async () => {
    const { describeConfig } = await import("../packages/core/src/zodSchema.ts");
    const { canHoldSecret, isSecretName } = await import("../packages/core/src/configValue.ts");
    const unmarked: string[] = [];
    for (const name of modulePackages()) {
      const mod = (await import(pathToFileURL(join(root, "packages", name, "module.ts")).href)) as { default: ModuleDefinition };
      for (const variable of describeConfig(mod.default.configSchema, undefined).variables) {
        const key = variable.path.split(".").at(-1) ?? variable.path;
        if (isSecretName(key) && canHoldSecret(variable.type) && !variable.secret) unmarked.push(`${name}: ${variable.path}`);
      }
    }
    expect(unmarked).toEqual([]);
  });
});

interface BinManifest {
  name: string;
  version: string;
  bin?: Record<string, string> | string;
  publishConfig?: { bin?: Record<string, string> | string };
}

function manifests(): { dir: string; pkg: BinManifest }[] {
  return readdirSync(join(root, "packages"))
    .filter((name) => existsSync(join(root, "packages", name, "package.json")))
    .map((name) => ({ dir: name, pkg: JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf-8")) as BinManifest }));
}

describe("bins", () => {
  it("only the CLI package ships bins: kestrel-cli first, then kestrel, as two distinct files in bin and publishConfig.bin", () => {
    const withBins = manifests().filter(({ pkg }) => pkg.bin !== undefined || pkg.publishConfig?.bin !== undefined);
    expect(withBins.map(({ pkg }) => pkg.name)).toEqual(["@michaelthielemann/kestrel-cli"]);
    const cli = withBins[0]!.pkg;
    for (const bin of [cli.bin, cli.publishConfig?.bin]) {
      expect(typeof bin).toBe("object");
      const entries = Object.entries(bin as Record<string, string>);
      expect(entries.map(([name]) => name)).toEqual(["kestrel-cli", "kestrel"]);
      expect(new Set(entries.map(([, file]) => file)).size).toBe(2);
    }
    const source = readFileSync(join(root, "packages", "cli", (cli.bin as Record<string, string>)["kestrel-cli"]!), "utf-8");
    expect(source.trim().split("\n")).toEqual(["#!/usr/bin/env -S node --disable-warning=ExperimentalWarning", 'import "./cli.ts";']);
  });

  it("the CLI package has core's version, so kestrel --version names the kestrel release", () => {
    const byName = new Map(manifests().map(({ pkg }) => [pkg.name, pkg.version]));
    expect(byName.get("@michaelthielemann/kestrel-cli")).toBe(byName.get("@michaelthielemann/kestrel"));
  });
});
