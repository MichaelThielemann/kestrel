import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runCli } from "./cli-run.ts";
import type { UpgradeReport } from "./report.ts";
import { createScratchCopy } from "./scratch.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "minimal-5.8");

async function runJson(argv: string[], forceInstalledMajor?: number): Promise<{ code: number; report: UpgradeReport }> {
  const lines: string[] = [];
  const code = await runCli(argv, { stdout: (line) => lines.push(line), stderr: () => undefined, ...(forceInstalledMajor === undefined ? {} : { forceInstalledMajor }) });
  return { code, report: boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json") };
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("kestrel-upgrade check against the minimal-5.8 fixture", () => {
  it("sees the source tier only while the 5.x packages are installed, and lists every known break", async () => {
    const { code, report } = await runJson(["check", "--root", FIXTURE, "--json"]);
    expect(report.tiers.source).toBe("done");
    expect(report.tiers.load).toBe("not-run");
    expect(report.tiers.boot).toBe("not-run");
    const rules = report.findings.map((f) => f.rule).sort();
    expect(rules).toEqual(expect.arrayContaining(["deps/kestrel-range", "modules/event-delivery", "steps/removed"]));
    expect(code).toBe(1);
  });

  it("opens the load and boot tiers end-to-end once forceInstalledMajor makes the gate see a 6.x install", async () => {
    const { code, report } = await runJson(["check", "--root", FIXTURE, "--json"], 6);
    expect(report.tiers).toEqual({ source: "done", load: "done", boot: "done", data: "not-run" });
    const byRule = new Map(report.findings.map((f) => [f.rule, f]));
    expect(byRule.get("boot/unknown-step")?.tier).toBe("boot");
    expect(byRule.get("boot/unknown-step")?.message).toContain("authn.requireUser");
    expect(byRule.get("boot/not-checked")?.tier).toBe("boot");
    expect(code).toBe(1);
  });
});

describe("kestrel-upgrade fix --write against a copy of the fixture", () => {
  it("bumps ranges, adds the delivery module and config, and renames the removed step", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);

    const code = await runCli(["fix", "--root", scratch.dir, "--write", "--yes"], { stdout: () => undefined, stderr: (line) => { throw new Error(line); } });
    expect(code).toBe(1);

    const configText = readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8");
    expect(configText).toContain("@michaelthielemann/kestrel-events-direct");
    expect(configText).not.toContain("acquireTimeoutMs");

    const pipelineText = readFileSync(join(scratch.dir, "pipelines", "deleteMediaFolder.ts"), "utf8");
    expect(pipelineText).toContain("media.listFolderItems");
    expect(pipelineText).not.toContain("media.folderItems");

    const pkg = boundaryCast<{ dependencies: Record<string, string> }>(JSON.parse(readFileSync(join(scratch.dir, "package.json"), "utf8")), "json");
    expect(pkg.dependencies["@michaelthielemann/kestrel"]).toBe("^6.0.0");
    expect(pkg.dependencies["@michaelthielemann/kestrel-persistence-sqlite"]).toBe("^6.0.0");
    expect(pkg.dependencies["@michaelthielemann/kestrel-events-inmemory"]).toBe("^6.0.0");
    expect(pkg.dependencies["@michaelthielemann/kestrel-events-direct"]).toBe("^6.0.0");
  });

  it("makes no further edit on a second run", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    await runCli(["fix", "--root", scratch.dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined });
    const before = readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8");
    const code = await runCli(["fix", "--root", scratch.dir, "--write", "--yes"], { stdout: () => undefined, stderr: () => undefined });
    const after = readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8");
    expect(after).toBe(before);
    expect(code).toBe(0);
  });

  it("leaves the checked-in fixture untouched", () => {
    const configText = readFileSync(join(FIXTURE, "kestrel.config.ts"), "utf8");
    expect(configText).not.toContain("events-direct");
  });
});

describe("kestrel-upgrade fix preview (no --write)", () => {
  it("counts what its own edits would still leave behind, not the pre-edit total", async () => {
    const lines: string[] = [];
    const code = await runCli(["fix", "--root", FIXTURE, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined, forceInstalledMajor: 6 });
    expect(code).toBe(1);
    const reportLine = lines.find((l) => l.startsWith("{"));
    const report = boundaryCast<UpgradeReport>(JSON.parse(reportLine ?? "{}"), "json");
    const nonAuto = report.findings.filter((f) => f.severity === "error" && f.fix.kind !== "auto");
    expect(nonAuto.map((f) => f.rule)).toEqual(["boot/unknown-step"]);
  });

  it("never prints a remaining-errors count when no boot tier ran at all", async () => {
    const lines: string[] = [];
    await runCli(["fix", "--root", FIXTURE], { stdout: (line) => lines.push(line), stderr: () => undefined });
    expect(lines.some((l) => l.startsWith("after these edits:"))).toBe(false);
    expect(lines).toContain("could not verify the boot result: no boot check ran; upgrade @michaelthielemann/kestrel to 6 first, then run `fix` again to verify");
  });
});
