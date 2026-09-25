import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runCli } from "./cli-run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "..", "..");

async function runFixLines(root: string): Promise<string[]> {
  const lines: string[] = [];
  await runCli(["fix", "--root", root], { stdout: (l) => lines.push(l), stderr: () => undefined, forceInstalledMajor: 6 });
  return lines;
}

async function remainLine(fixture: string): Promise<string | undefined> {
  const lines = await runFixLines(join(HERE, "..", "__fixtures__", fixture));
  return lines.find((l) => l.startsWith("after these edits:"));
}

async function linkPackage(nodeModulesDir: string, name: string, packageDirName: string): Promise<void> {
  const scope = join(nodeModulesDir, "@michaelthielemann");
  await mkdir(scope, { recursive: true });
  await symlink(resolve(PACKAGES_DIR, packageDirName), join(scope, name), "dir");
}

async function projectMissingEventsDirect(dir: string): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "app", type: "module", dependencies: { "@michaelthielemann/kestrel": "^5.8.0", "@michaelthielemann/kestrel-events-inmemory": "^5.8.0", "@michaelthielemann/kestrel-persistence-sqlite": "^5.8.0" } }, null, 2),
  );
  await writeFile(
    join(dir, "kestrel.config.ts"),
    `import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db", busyTimeoutMs: 20000 } },
  ],
  triggers: [],
  pipelinesDir: "./pipelines",
});
`,
  );
  await mkdir(join(dir, "pipelines"), { recursive: true });
  await writeFile(
    join(dir, "pipelines", "publishNote.ts"),
    `import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "publishNote",
  steps: ["events.emit:note.published"],
});
`,
  );
  const nodeModules = join(dir, "node_modules");
  await linkPackage(nodeModules, "kestrel", "core");
  await linkPackage(nodeModules, "kestrel-contracts", "contracts");
  await linkPackage(nodeModules, "kestrel-events-inmemory", "events-inmemory");
  await linkPackage(nodeModules, "kestrel-persistence-sqlite", "persistence-sqlite");
  await symlink(resolve(HERE, "..", "..", "..", "node_modules", "zod"), join(nodeModules, "zod"), "dir");
}

async function runFixWithoutWorkspaceFallback(root: string, extraArgs: readonly string[] = []): Promise<{ lines: string[]; exitCode: number }> {
  const scriptFile = join(root, "__run-fix.mjs");
  const resultFile = join(root, "__result.json");
  const cliRunModule = join(PACKAGES_DIR, "upgrade", "src", "cli-run.ts");
  const argv = ["fix", "--root", root, ...extraArgs];
  await writeFile(
    scriptFile,
    `import { writeFile } from "node:fs/promises";
import { runCli } from ${JSON.stringify(cliRunModule)};
const lines = [];
const exitCode = await runCli(${JSON.stringify(argv)}, { stdout: (l) => lines.push(l), stderr: (l) => lines.push("STDERR: " + l), forceInstalledMajor: 6 });
await writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ lines, exitCode }));
`,
  );
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptFile], { env: { ...process.env, NODE_PATH: "" }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`child exited ${String(code)}: ${stderr}`))));
  });
  return boundaryCast<{ lines: string[]; exitCode: number }>(JSON.parse(await readFile(resultFile, "utf8")), "json");
}

describe("fix preview counts what a boot of the fully edited copy would still reject", () => {
  it("drops an unknown-step boot error that the matching source auto-fix resolves", async () => {
    expect(await remainLine("event-emit-5.8")).toBe("after these edits: 0 errors remain (0 need your answer, 0 manual)");
  });

  it("keeps an unknown-step boot error no edit resolves, and names the pipeline the failure left unchecked", async () => {
    expect(await remainLine("minimal-5.8")).toBe("after these edits: 1 errors remain (0 need your answer, 1 manual) (1 not checked)");
  });
});

describe("fix --json never mixes a plain-text line into stdout", () => {
  it("puts only the JSON report on stdout, and the human boot summary on stderr instead", async () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    await runCli(["fix", "--root", join(HERE, "..", "__fixtures__", "event-emit-5.8"), "--json"], { stdout: (l) => stdoutLines.push(l), stderr: (l) => stderrLines.push(l), forceInstalledMajor: 6 });
    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0]).toMatch(/^\{/);
    expect(() => {
      JSON.parse(stdoutLines[0]!);
    }).not.toThrow();
    expect(stderrLines).toContain("after these edits: 0 errors remain (0 need your answer, 0 manual)");
  });
});

describe("fix preview when an edit adds a package the project does not have installed", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("never counts a boot it could not load, names the missing package, and lists the unverified boot findings", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-missing-pkg-"));
    await projectMissingEventsDirect(dir);
    const { lines } = await runFixWithoutWorkspaceFallback(dir);
    expect(lines.some((l) => l.startsWith("after these edits:"))).toBe(false);
    expect(lines.some((l) => l.includes("@michaelthielemann/kestrel-events-direct") && l.includes("install") && l.includes("run `fix` again"))).toBe(true);
    expect(lines.some((l) => l.trim().startsWith("not verified:") && l.includes("boot/unknown-step"))).toBe(true);
  });

  it("stays on the existing install-it-then-run-fix-again line under --fail-on warning, without a spurious preview/edit-refused finding or exit", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-missing-pkg-warn-"));
    await projectMissingEventsDirect(dir);
    const { lines, exitCode } = await runFixWithoutWorkspaceFallback(dir, ["--json", "--fail-on", "warning"]);
    const reportLine = lines.find((l) => l.startsWith("{"));
    const report = boundaryCast<{ findings: Array<{ rule: string }> }>(JSON.parse(reportLine ?? "{}"), "json");
    expect(report.findings.some((f) => f.rule === "preview/edit-refused")).toBe(false);
    expect(lines.some((l) => l.includes("@michaelthielemann/kestrel-events-direct") && l.includes("install") && l.includes("run `fix` again"))).toBe(true);
    expect(exitCode).toBe(1);
  });
});
