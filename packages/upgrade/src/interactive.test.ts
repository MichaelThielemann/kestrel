import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { runUpgradeCli } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";
import { createScratchCopy } from "./scratch.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "verified-user-5.8");

const cleanupDirs: string[] = [];
afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function runJson(argv: string[], options: Parameters<typeof runUpgradeCli>[1] = {}): Promise<{ code: number; report: UpgradeReport }> {
  const lines: string[] = [];
  const code = await runUpgradeCli(argv, { stdout: (line) => lines.push(line), stderr: () => undefined, ...options });
  return { code, report: boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json") };
}

describe("non-interactive: never prompts", () => {
  it("check reports the ambiguous verified-user-path question without asking", async () => {
    const { report } = await runJson(["check", "--root", FIXTURE, "--json"]);
    const finding = report.findings.find((f) => f.rule === "pipelines/verified-user");
    expect(finding?.fix.kind).toBe("ask");
  });

  it("fix without --write previews and never asks", async () => {
    const lines: string[] = [];
    await runUpgradeCli(["fix", "--root", FIXTURE, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, isInteractive: false });
    const reportLine = lines.find((l) => l.startsWith("{"));
    const report = boundaryCast<UpgradeReport>(JSON.parse(reportLine ?? "{}"), "json");
    const finding = report.findings.find((f) => f.rule === "pipelines/verified-user");
    expect(finding?.fix.kind).toBe("ask");
  });

  it("fix --write without a TTY and without --yes writes nothing and exits 2", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const before = readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8");
    let errored = "";
    const code = await runUpgradeCli(["fix", "--root", scratch.dir, "--write"], { stdout: () => undefined, stderr: (l) => { errored = l; }, isInteractive: false });
    expect(code).toBe(2);
    expect(errored).toContain("TTY");
    expect(readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8")).toBe(before);
  });
});

describe("--answers resolves a question without a TTY", () => {
  it("applies the chosen path and writes under --yes", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const answersFile = join(scratch.dir, "answers.json");
    await writeFile(answersFile, JSON.stringify({ "verified-user-path:retryReassignRevisionAuthor": "reassignTo" }));
    const code = await runUpgradeCli(["fix", "--root", scratch.dir, "--write", "--yes", "--answers", answersFile], { stdout: () => undefined, stderr: () => undefined, isInteractive: false });
    expect(code).toBe(1);
    const text = await readFile(join(scratch.dir, "pipelines", "retryReassignRevisionAuthor.ts"), "utf8");
    expect(text).toContain('"authn.verifyUser:reassignTo", "revisions.reassignAuthor"');
  });

  it("exits 2 when the answers file names an id this run never asked", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const answersFile = join(scratch.dir, "answers.json");
    await writeFile(answersFile, JSON.stringify({ "nope:not-a-real-question": "yes" }));
    let errored = "";
    const code = await runUpgradeCli(["fix", "--root", scratch.dir, "--write", "--yes", "--answers", answersFile], { stdout: () => undefined, stderr: (l) => { errored = l; }, isInteractive: false });
    expect(code).toBe(2);
    expect(errored).toContain("nope:not-a-real-question");
  });

  it("notes, but does not refuse, a stale answer belonging to a known rule's question family", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const answersFile = join(scratch.dir, "answers.json");
    await writeFile(
      answersFile,
      JSON.stringify({ "verified-user-path:retryReassignRevisionAuthor": "reassignTo", "verified-user-path:aPipelineFromAnEarlierPass": "reassignTo" }),
    );
    const lines: string[] = [];
    const code = await runUpgradeCli(["fix", "--root", scratch.dir, "--write", "--yes", "--answers", answersFile], { stdout: (l) => lines.push(l), stderr: (l) => lines.push(l), isInteractive: false });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("verified-user-path:aPipelineFromAnEarlierPass") && l.includes("stale"))).toBe(true);
    const text = await readFile(join(scratch.dir, "pipelines", "retryReassignRevisionAuthor.ts"), "utf8");
    expect(text).toContain('"authn.verifyUser:reassignTo", "revisions.reassignAuthor"');
  });
});

describe("a scripted TTY prompt", () => {
  it("is asked the question, in order, and its answer is applied", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const asked: string[] = [];
    const code = await runUpgradeCli(["fix", "--root", scratch.dir, "--write"], {
      stdout: () => undefined,
      stderr: () => undefined,
      isInteractive: true,
      prompt: (question, choices, defaultValue) => {
        asked.push(question);
        if (question.includes("authn.verifyUser reads which path")) return Promise.resolve("reassignTo");
        return Promise.resolve(defaultValue ?? "y");
      },
    });
    expect(code).toBe(1);
    expect(asked.some((q) => q.includes("authn.verifyUser reads which path"))).toBe(true);
    const text = await readFile(join(scratch.dir, "pipelines", "retryReassignRevisionAuthor.ts"), "utf8");
    expect(text).toContain("authn.verifyUser:reassignTo");
  });

  it("shows a diff on demand (d) before asking again, then honours n to skip a file", async () => {
    const scratch = await createScratchCopy(FIXTURE);
    cleanupDirs.push(scratch.dir);
    const before = readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8");
    const seenDiffs: string[] = [];
    let fileAsked = 0;
    await runUpgradeCli(["fix", "--root", scratch.dir, "--write"], {
      stdout: () => undefined,
      stderr: () => undefined,
      isInteractive: true,
      prompt: (question, choices) => {
        if (question.includes("authn.verifyUser reads which path")) return Promise.resolve("reassignTo");
        if (choices.includes("d")) {
          fileAsked++;
          if (fileAsked === 1) return Promise.resolve("d");
          return Promise.resolve("n");
        }
        seenDiffs.push(question);
        return Promise.resolve("");
      },
    });
    expect(seenDiffs.some((d) => d.includes("---") || d.includes("no textual change"))).toBe(true);
    expect(existsSync(join(scratch.dir, "kestrel.config.ts")) && readFileSync(join(scratch.dir, "kestrel.config.ts"), "utf8")).toBe(before);
  });
});
