import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { boundaryCast } from "../packages/core/src/cast.ts";

const contracts = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "contracts");
const src = join(contracts, "src");

type ExportTarget = string | null | Record<string, string>;
type ExportMap = Record<string, ExportTarget>;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith(".test.ts") ? [relative(src, path)] : [];
  });
}

const all = testFiles(src).sort();
const suites = all.filter((file) => file.endsWith(".contract.test.ts"));
const unitTests = all.filter((file) => !file.endsWith(".contract.test.ts"));

function subpath(file: string): string {
  return `./${file.replace(/\.ts$/, "")}`;
}

function resolveExport(map: ExportMap, request: string): ExportTarget | undefined {
  if (request in map) return map[request];
  const matches = Object.keys(map)
    .filter((key) => key.includes("*"))
    .filter((key) => {
      const [prefix = "", suffix = ""] = key.split("*");
      return request.length >= key.length && request.startsWith(prefix) && request.endsWith(suffix);
    })
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  const key = matches[0];
  return key === undefined ? undefined : map[key];
}

const pkg = boundaryCast<{ exports: ExportMap; publishConfig: { exports: ExportMap } }>(JSON.parse(readFileSync(join(contracts, "package.json"), "utf8")), "json");
const maps: Array<[string, ExportMap]> = [
  ["exports", pkg.exports],
  ["publishConfig.exports", pkg.publishConfig.exports],
];

describe("the contracts package", () => {
  it("has unit tests and shared suites to tell apart", () => {
    expect(suites.length).toBeGreaterThan(0);
    expect(unitTests.length).toBeGreaterThan(0);
  });

  it("builds every shared contract suite and none of its own unit tests", () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(join(contracts, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    const built = new Set((parsed?.fileNames ?? []).map((file) => relative(src, file)));
    expect(unitTests.filter((file) => built.has(file))).toEqual([]);
    expect(suites.filter((file) => !built.has(file))).toEqual([]);
  });

  it("points every shared suite's source export at its own source file", () => {
    for (const file of suites) expect(pkg.exports[subpath(file)], file).toBe(`./src/${file}`);
  });

  it("points every shared suite's published export at its own built declaration and module", () => {
    const base = (file: string): string => `./dist/${file.replace(/\.ts$/, "")}`;
    for (const file of suites) expect(pkg.publishConfig.exports[subpath(file)], file).toEqual({ types: `${base(file)}.d.ts`, default: `${base(file)}.js` });
  });

  it.each(maps)("%s leaves no unit test importable", (_, map) => {
    expect(unitTests.filter((file) => resolveExport(map, subpath(file)) !== null)).toEqual([]);
  });

  it.each(maps)("%s still exports the contracts, helpers and fakes", (_, map) => {
    for (const request of ["./persistence", "./errors", "./testing/fakePersistence", "./testing/result"]) {
      expect(resolveExport(map, request), request).toBeTruthy();
    }
  });
});
