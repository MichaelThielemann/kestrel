import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runCli } from "./cli-run.ts";
import type { UpgradePlugin } from "./plugin.ts";
import type { Finding, UpgradeReport } from "./report.ts";

const CLI = "@michaelthielemann/kestrel-cli";
const EMPTY_HOSTS = { loadable: [], outdated: [], refused: [] };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-binaries-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const hostPlugin: UpgradePlugin = {
  kind: "example-host",
  detect: () => true,
  load: (_root, scratch) => Promise.resolve({ project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "example-host", configFile: join(scratch, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: [] }, issues: [] }),
};

async function writePackage(pkg: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", private: true, ...pkg }, null, 2) + "\n");
}

async function check(plugins: readonly UpgradePlugin[] = []): Promise<Finding[]> {
  const lines: string[] = [];
  await runCli(["check", "--root", dir, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins, hosts: EMPTY_HOSTS });
  return boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json").findings;
}

async function fixWrite(plugins: readonly UpgradePlugin[] = []): Promise<Record<string, Record<string, string>>> {
  await runCli(["fix", "--root", dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined, plugins, hosts: EMPTY_HOSTS });
  return boundaryCast<Record<string, Record<string, string>>>(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), "json");
}

describe("deps/kestrel-range adds the kestrel CLI package", () => {
  it("puts it into dependencies of a backend project, next to the bumped ranges", async () => {
    await writePackage({ dependencies: { "@michaelthielemann/kestrel": "^5.8.0", "@michaelthielemann/kestrel-events-direct": "^5.8.0" } });
    const pkg = await fixWrite();
    expect(pkg.dependencies).toEqual({ "@michaelthielemann/kestrel": "^6.0.0", [CLI]: "^6.0.0", "@michaelthielemann/kestrel-events-direct": "^6.0.0" });
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("puts it into devDependencies of a project a host plugin loads", async () => {
    await writePackage({ dependencies: { "example-host": "^3.0.0" }, devDependencies: { typescript: "^5.0.0" } });
    const pkg = await fixWrite([hostPlugin]);
    expect(pkg.devDependencies).toEqual({ [CLI]: "^6.0.0", typescript: "^5.0.0" });
    expect(pkg.dependencies).toEqual({ "example-host": "^3.0.0" });
  });

  it("moves it out of the wrong block, also when it is the block's last entry", async () => {
    await writePackage({ dependencies: { "@michaelthielemann/kestrel": "^6.0.0" }, devDependencies: { typescript: "^5.0.0", [CLI]: "^6.0.0" } });
    const findings = (await check()).filter((f) => f.rule === "deps/kestrel-range");
    expect(findings.map((f) => f.id)).toEqual([`deps/kestrel-range:${CLI}`]);
    const pkg = await fixWrite();
    expect(pkg.dependencies).toEqual({ "@michaelthielemann/kestrel": "^6.0.0", [CLI]: "^6.0.0" });
    expect(pkg.devDependencies).toEqual({ typescript: "^5.0.0" });
  });

  it("leaves a project with no kestrel dependency and no host plugin alone", async () => {
    await writePackage({ dependencies: { lodash: "^4.0.0" } });
    expect((await check()).filter((f) => f.rule === "deps/kestrel-range")).toEqual([]);
  });
});

describe("scripts/kestrel-binaries", () => {
  it("rewrites the removed binaries in package.json scripts and leaves longer words alone", async () => {
    await writePackage({
      scripts: {
        start: "kestrel",
        openapi: "kestrel-openapi --out openapi.json --server http://127.0.0.1:4000",
        upgrade: "pnpm dlx @michaelthielemann/kestrel-upgrade@6 check",
        fix: "npx @michaelthielemann/kestrel-upgrade@6 fix --write",
        data: "./node_modules/.bin/kestrel-upgrade data --db x.db && echo done",
        both: "tsc && kestrel-openapi --out a.json;kestrel-upgrade check",
        other: "my-kestrel-openapi-tool && kestrel-openapi-extra",
      },
      dependencies: { "@michaelthielemann/kestrel": "^6.0.0", [CLI]: "^6.0.0" },
    });
    const pkg = await fixWrite();
    expect(pkg.scripts).toEqual({
      start: "kestrel",
      openapi: "kestrel openapi --out openapi.json --server http://127.0.0.1:4000",
      upgrade: "pnpm dlx @michaelthielemann/kestrel-cli@6 upgrade check",
      fix: "npx -y @michaelthielemann/kestrel-cli@6 upgrade fix --write",
      data: "./node_modules/.bin/kestrel upgrade data --db x.db && echo done",
      both: "tsc && kestrel openapi --out a.json;kestrel upgrade check",
      other: "my-kestrel-openapi-tool && kestrel-openapi-extra",
    });
  });

  it("warns about an openapi flag the command refuses, and still rewrites the line", async () => {
    await writePackage({ scripts: { openapi: "kestrel-openapi --pretty --out openapi.json" }, dependencies: { "@michaelthielemann/kestrel": "^6.0.0", [CLI]: "^6.0.0" } });
    const findings = (await check()).filter((f) => f.rule === "scripts/kestrel-binaries");
    expect(findings.find((f) => f.fix.kind === "auto")).toBeDefined();
    const warning = findings.find((f) => f.severity === "warning");
    expect(warning?.message).toContain("--pretty");
  });

  it("warns with file and line about an old binary in a Dockerfile, a unit file and a shell script, never in Markdown", async () => {
    await writePackage({ dependencies: { "@michaelthielemann/kestrel": "^6.0.0", [CLI]: "^6.0.0" } });
    await writeFile(join(dir, "Dockerfile"), 'FROM node:22\nRUN npx kestrel-openapi --out /tmp/openapi.json\nCMD ["node_modules/.bin/kestrel"]\n');
    await writeFile(join(dir, "app.service"), "[Service]\nExecStart=/srv/app/node_modules/.bin/kestrel-upgrade check\n");
    await writeFile(join(dir, "deploy.sh"), "#!/bin/sh\nset -e\nkestrel-upgrade data --db app.db\n");
    await writeFile(join(dir, "README.md"), "Run kestrel-openapi to write the document.\n");
    const findings = (await check()).filter((f) => f.rule === "scripts/kestrel-binaries");
    const located = findings.map((f) => [f.where.file?.slice(dir.length + 1), f.where.line, f.severity, f.fix.kind]).sort();
    expect(located).toEqual([
      ["Dockerfile", 2, "warning", "manual"],
      ["app.service", 2, "warning", "manual"],
      ["deploy.sh", 3, "warning", "manual"],
    ]);
    expect(findings.find((f) => f.where.file?.endsWith("Dockerfile"))?.suggestion).toContain("kestrel openapi");
  });

  it("finds nothing to do on a 6.x project that already uses the kestrel command", async () => {
    await writePackage({ scripts: { start: "kestrel", openapi: "kestrel openapi --out openapi.json", check: "kestrel check" }, dependencies: { "@michaelthielemann/kestrel": "^6.0.0", [CLI]: "^6.0.0" } });
    await writeFile(join(dir, "Dockerfile"), 'CMD ["node_modules/.bin/kestrel"]\n');
    const findings = (await check()).filter((f) => f.rule === "scripts/kestrel-binaries" || f.rule === "deps/kestrel-range");
    expect(findings).toEqual([]);
  });
});
