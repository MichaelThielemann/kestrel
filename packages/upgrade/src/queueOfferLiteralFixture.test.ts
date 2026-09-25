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
const FIXTURE = join(HERE, "..", "__fixtures__", "queue-offer-literal-5.8");
const RUN_SETUP = ["--run-setup", "./notes.ts"];

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("kestrel-upgrade against the queue-offer-literal-5.8 fixture (events-direct named literally in a separate const modules array, passed by shorthand)", () => {
  it("offers the switch, verified, once every condition is met", async () => {
    const lines: string[] = [];
    const code = await runCli(["check", "--root", FIXTURE, "--json", ...RUN_SETUP], { stdout: (line) => lines.push(line), stderr: () => undefined, forceInstalledMajor: 6 });
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    expect(report.tiers).toEqual({ source: "done", load: "done", boot: "done", data: "not-run" });
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).toBe("ask");
    expect(offer?.fix.kind === "ask" ? offer.fix.defaultValue : undefined).toBe("no");
    expect(report.findings.some((f) => f.rule.startsWith("boot/") && f.severity === "error")).toBe(false);
    expect(code).toBe(1);
  });

  it("applies the switch through fix --write, renaming the const modules array's own entry and producing a valid package.json", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const answersFile = join(scratch.dir, "answers.json");
    await writeFile(answersFile, JSON.stringify({ "switch-to-queue": "yes", "idempotent:onNoteCreated": "yes", "relay-pipelines": "" }));

    const code = await runCli(["fix", "--root", scratch.dir, "--write", "--yes", "--answers", answersFile, ...RUN_SETUP], {
      stdout: () => undefined,
      stderr: (line) => {
        throw new Error(line);
      },
      forceInstalledMajor: 6,
    });
    expect(code).toBe(1);

    const configText = readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8");
    expect(configText).toContain("const modules = [");
    expect(configText).toContain("@michaelthielemann/kestrel-events-queue");
    expect(configText).not.toContain("events-direct");

    const pkgText = readFileSync(join(scratch.dir, "package.json"), "utf8");
    const pkg = boundaryCast<{ dependencies: Record<string, string> }>(JSON.parse(pkgText), "json");
    expect(pkg.dependencies["@michaelthielemann/kestrel-events-queue"]).toBe("^6.0.0");
    expect(pkg.dependencies["@michaelthielemann/kestrel-events-direct"]).toBeUndefined();
  });
});
