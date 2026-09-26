import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { CheckReport } from "../src/commands/check.ts";
import { copyProject, FIXTURES, MINIMAL, removeDir, runCli, tempDir } from "./harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

function report(stdout: string): CheckReport {
  return boundaryCast<CheckReport>(JSON.parse(stdout), "json");
}

describe("kestrel check", { timeout: 60_000 }, () => {
  it("passes on the minimal example and leaves the project byte-identical", async () => {
    const dir = copyProject(MINIMAL, "check");
    dirs.push(dir);
    const before = snapshot(dir);
    const result = await runCli(["check", "--json"], { cwd: dir });
    expect(result.code).toBe(0);
    const parsed = report(result.stdout);
    expect(parsed).toMatchObject({ schema: 1, tool: { name: "kestrel" }, project: { kind: "backend" }, plugins: [], errors: [], issues: [] });
    expect(parsed.sandbox.outside).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("fails a pipeline whose step argument its module refuses, naming the pipeline, the module and the reason", async () => {
    const dir = copyProject(MINIMAL, "check-broken");
    dirs.push(dir);
    writeFileSync(join(dir, "pipelines", "broken.ts"), 'import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";\nexport default definePipeline({ name: "broken", steps: ["content.get:pages?fallback=true&status=published"] });\n');
    const before = snapshot(dir);
    const json = await runCli(["check", "--json", "--root", dir]);
    expect(json.code).toBe(1);
    const error = report(json.stdout).errors.find((e) => e.pipeline === "broken");
    expect(error).toMatchObject({ code: "step-argument", pipeline: "broken", module: "content/default" });
    expect(error?.reason.length).toBeGreaterThan(0);
    const human = await runCli(["check", "--root", dir]);
    expect(human.code).toBe(1);
    const line = human.stdout.split("\n").findIndex((l) => l.startsWith("error    step-argument"));
    expect(human.stdout.split("\n")[line]).toContain("module content/default");
    expect(human.stdout.split("\n")[line + 1]).toContain("fallback=true is refused");
    expect(snapshot(dir)).toEqual(before);
  });

  it("runs a consented module's setup with the scratch copy as its cwd, never the project", async () => {
    const dir = copyProject(join(FIXTURES, "setup-marker"), "check-marker");
    dirs.push(dir);
    const log = join(tempDir("marker-log"), "cwd.txt");
    dirs.push(join(log, ".."));
    const skipped = await runCli(["check", "--json", "--root", dir], { env: { KESTREL_MARKER_LOG: log } });
    expect(skipped.code).toBe(0);
    expect(report(skipped.stdout).sandbox.outside).toEqual(["./modules/marker.ts"]);
    expect(existsSync(log)).toBe(false);

    const consented = await runCli(["check", "--json", "--root", dir, "--run-setup", "./modules/marker.ts"], { env: { KESTREL_MARKER_LOG: log } });
    expect(consented.code).toBe(0);
    const cwd = readFileSync(log, "utf8").trim();
    expect(cwd).not.toBe(dir);
    expect(cwd).toContain("kestrel-upgrade-");
    expect(existsSync(join(dir, "out", "marker"))).toBe(false);
    expect(existsSync(cwd)).toBe(false);
  });

  it("fails warnings and not-checked items with --fail-on warning, and refuses --fail-on info", async () => {
    const dir = copyProject(join(FIXTURES, "setup-marker"), "check-fail-on");
    dirs.push(dir);
    expect((await runCli(["check", "--root", dir])).code).toBe(0);
    expect((await runCli(["check", "--root", dir, "--fail-on", "warning"])).code).toBe(1);
    expect((await runCli(["check", "--root", dir, "--fail-on", "warning", "--run-setup", "./modules/marker.ts"])).code).toBe(0);
    expect((await runCli(["check", "--root", dir, "--fail-on", "info"])).code).toBe(2);
    expect((await runCli(["check", "--root", dir, "--bogus"])).code).toBe(2);
  });

  it("exits 2 when the directory is not a kestrel project", async () => {
    const dir = tempDir("check-empty");
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), "{}");
    const result = await runCli(["check", "--root", dir]);
    expect(result.code).toBe(2);
  });
});
