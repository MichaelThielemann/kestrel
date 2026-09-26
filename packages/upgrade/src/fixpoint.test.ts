import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli-run.ts";
import type { LoadResult, SourceRule, UpgradePlugin } from "./plugin.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-fixpoint-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
  await writeFile(join(dir, "steps.txt"), "start\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function appendRule(id: string, needs: string | undefined, adds: string): SourceRule {
  return {
    id,
    needs: "source",
    check(ctx) {
      const file = join(ctx.root, "steps.txt");
      const text = ctx.readFile(file);
      if (text === undefined || text.includes(adds) || (needs !== undefined && !text.includes(needs))) return [];
      return [{ id, rule: id, severity: "error", tier: "source", where: { file }, message: `${adds} is missing`, suggestion: `append ${adds}`, fix: { kind: "auto", edits: [{ file, start: text.length, end: text.length, text: `${adds}\n` }] }, docs: "n/a" }];
    },
  };
}

function askRule(): SourceRule {
  return {
    id: "chain/ask",
    needs: "source",
    check(ctx) {
      const answer = ctx.answers.get("chain-keep");
      if (answer === "yes") return [];
      return [{ id: "chain/ask", rule: "chain/ask", severity: "warning", tier: "source", where: {}, message: "keep the chain?", suggestion: "answer", fix: { kind: "ask", question: "chain-keep", prompt: "keep the chain?", choices: ["no", "yes"], closedChoices: true, defaultValue: "no" }, docs: "n/a" }];
    },
  };
}

function plugin(extra: SourceRule[] = []): UpgradePlugin {
  const project = (): LoadResult => ({
    project: { input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [] }, kind: "chain-host", configFile: join(dir, "host.config.ts"), moduleFiles: new Map(), pipelineFiles: [] },
    issues: [],
  });
  return { kind: "chain-host", detect: () => true, load: () => Promise.resolve(project()), rules: [appendRule("chain/one", undefined, "one"), appendRule("chain/two", "one", "two"), appendRule("chain/three", "two", "three"), ...extra] };
}

describe("kestrel-upgrade fix --write", () => {
  it("applies edits that only appear after earlier edits in the same invocation, up to a fixpoint", async () => {
    const lines: string[] = [];
    const code = await runCli(["fix", "--root", dir, "--write", "--yes", "--allow-dirty"], { stdout: (l) => lines.push(l), stderr: (l) => lines.push(l), isInteractive: false, plugins: [plugin()] });
    expect(await readFile(join(dir, "steps.txt"), "utf8")).toBe("start\none\ntwo\nthree\n");
    expect(lines.filter((l) => l.startsWith("wrote "))).toEqual(["wrote steps.txt"]);
    expect(code).toBe(1);
  });

  it("warns about an answer whose question was not asked, instead of refusing to run", async () => {
    const answersFile = join(dir, "answers.json");
    await writeFile(answersFile, JSON.stringify({ "some-plugin:question-of-a-later-pass": "yes" }));
    const lines: string[] = [];
    const code = await runCli(["fix", "--root", dir, "--write", "--yes", "--allow-dirty", "--answers", answersFile], { stdout: (l) => lines.push(l), stderr: (l) => lines.push(l), isInteractive: false, plugins: [plugin()] });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("some-plugin:question-of-a-later-pass") && l.includes("never asked"))).toBe(true);
    expect(await readFile(join(dir, "steps.txt"), "utf8")).toContain("three");
  });

  it("asks a question answered at the terminal only once across passes", async () => {
    const prompts: string[] = [];
    await runCli(["fix", "--root", dir, "--write", "--allow-dirty"], {
      stdout: () => undefined,
      stderr: () => undefined,
      isInteractive: true,
      prompt: (question, _choices, fallback) => {
        prompts.push(question);
        return Promise.resolve(question.startsWith("write") ? "y" : (fallback ?? ""));
      },
      plugins: [plugin([askRule()])],
    });
    expect(prompts.filter((q) => q.includes("keep the chain?"))).toHaveLength(1);
    expect(await readFile(join(dir, "steps.txt"), "utf8")).toContain("three");
  });
});
