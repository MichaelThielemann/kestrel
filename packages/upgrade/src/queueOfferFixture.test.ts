import { rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runCli } from "./cli-run.ts";
import type { UpgradeReport } from "./report.ts";
import { createScratchCopy } from "./scratch.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "queue-offer-5.8");
const RUN_SETUP = ["--run-setup", "./notes.ts"];

async function runJson(argv: string[]): Promise<{ code: number; report: UpgradeReport }> {
  const lines: string[] = [];
  const code = await runCli(argv, { stdout: (line) => lines.push(line), stderr: () => undefined, forceInstalledMajor: 6 });
  return { code, report: boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json") };
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("kestrel-upgrade against the queue-offer-5.8 fixture, with the installed major forced to 6", () => {
  it("runs the load and boot tiers and offers the queue switch once its own boot preview comes back clean", async () => {
    const { code, report } = await runJson(["check", "--root", FIXTURE, "--json", ...RUN_SETUP]);
    expect(report.tiers).toEqual({ source: "done", load: "done", boot: "done", data: "not-run" });
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).toBe("ask");
    expect(offer?.message).not.toContain("fails to boot");
    expect(report.findings.some((f) => f.rule.startsWith("boot/") && f.severity === "error")).toBe(false);
    expect(code).toBe(1);
  });

  it("applies the switch through fix --write on a scratch copy, producing a valid package.json and a booting config", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const answersFile = join(scratch.dir, "answers.json");
    await writeFile(answersFile, JSON.stringify({ "switch-to-queue": "yes", "idempotent:onNoteCreated": "yes", "relay-pipelines": "" }));

    const lines: string[] = [];
    const code = await runCli(["fix", "--root", scratch.dir, "--write", "--yes", "--answers", answersFile, ...RUN_SETUP], {
      stdout: (line) => lines.push(line),
      stderr: (line) => { throw new Error(line); },
      forceInstalledMajor: 6,
    });
    expect(code).toBe(1);

    const configText = readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8");
    expect(configText).toContain("@michaelthielemann/kestrel-events-queue");
    expect(configText).not.toContain("events-direct");

    const pkgText = readFileSync(join(scratch.dir, "package.json"), "utf8");
    const pkg = boundaryCast<{ dependencies: Record<string, string> }>(JSON.parse(pkgText), "json");
    expect(pkg.dependencies["@michaelthielemann/kestrel-events-queue"]).toBe("^6.0.0");
    expect(pkg.dependencies["@michaelthielemann/kestrel-events-direct"]).toBeUndefined();

    expect(lines.some((l) => l.includes("pnpm install"))).toBe(true);
  });

  it("exits 2, naming the id and the value, when the answers file gives a closed-choice question an answer outside its choices", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const answersFile = join(scratch.dir, "answers.json");
    await writeFile(answersFile, JSON.stringify({ "switch-to-queue": "maybe" }));
    let errored = "";
    const code = await runCli(["fix", "--root", scratch.dir, "--write", "--yes", "--answers", answersFile, ...RUN_SETUP], {
      stdout: () => undefined,
      stderr: (line) => {
        errored = line;
      },
      forceInstalledMajor: 6,
    });
    expect(code).toBe(2);
    expect(errored).toContain("switch-to-queue");
    expect(errored).toContain("maybe");
  });
});

describe("kestrel-upgrade check against the queue-offer-5.8 fixture, unforced", () => {
  it("leaves the checked-in fixture on the source tier only", async () => {
    const lines: string[] = [];
    const code = await runCli(["check", "--root", FIXTURE, "--json"], { stdout: (line) => lines.push(line), stderr: () => undefined });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    expect(report.tiers.load).toBe("not-run");
    expect(report.tiers.boot).toBe("not-run");
    expect(code).toBe(1);
  });
});
