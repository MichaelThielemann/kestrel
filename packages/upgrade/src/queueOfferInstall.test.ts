import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(HERE, "..", "..");

async function linkPackage(nodeModulesDir: string, name: string, packageDirName: string): Promise<void> {
  const scope = join(nodeModulesDir, "@michaelthielemann");
  await mkdir(scope, { recursive: true });
  await symlink(resolve(PACKAGES_DIR, packageDirName), join(scope, name), "dir");
}

async function buildDirectProject(dir: string, includeEventsQueue: boolean): Promise<void> {
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "app",
        type: "module",
        dependencies: {
          "@michaelthielemann/kestrel": "^6.0.0",
          "@michaelthielemann/kestrel-events-inmemory": "^6.0.0",
          "@michaelthielemann/kestrel-events-direct": "^6.0.0",
          "@michaelthielemann/kestrel-persistence-sqlite": "^6.0.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(dir, "kestrel.config.ts"),
    `import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-events-direct", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db", busyTimeoutMs: 20000 } },
    { use: "./notes.ts", config: {} },
  ],
  triggers: [
    { http: "POST /notes", pipeline: "createNote" },
    { event: "note.created", pipeline: "onNoteCreated" },
  ],
  pipelinesDir: "./pipelines",
});
`,
  );
  await writeFile(
    join(dir, "notes.ts"),
    `import { z } from "zod";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";

export default defineModule({
  name: "notes/local",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    create: async (ctx) => ok({ ...ctx, result: { id: "n1" } }),
    onCreated: async (ctx) => ok(ctx),
  }),
  describe: () => ({
    create: { summary: "create a note", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    onCreated: { summary: "react to note.created", reads: [], writes: [] },
  }),
});
`,
  );
  await mkdir(join(dir, "pipelines"), { recursive: true });
  await writeFile(
    join(dir, "pipelines", "createNote.ts"),
    `import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "createNote",
  steps: ["notes.create", "events.emit:note.created"],
});
`,
  );
  await writeFile(
    join(dir, "pipelines", "onNoteCreated.ts"),
    `import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "onNoteCreated",
  steps: ["notes.onCreated"],
});
`,
  );
  const nodeModules = join(dir, "node_modules");
  await linkPackage(nodeModules, "kestrel", "core");
  await linkPackage(nodeModules, "kestrel-contracts", "contracts");
  await linkPackage(nodeModules, "kestrel-events-inmemory", "events-inmemory");
  await linkPackage(nodeModules, "kestrel-events-direct", "events-direct");
  await linkPackage(nodeModules, "kestrel-persistence-sqlite", "persistence-sqlite");
  if (includeEventsQueue) await linkPackage(nodeModules, "kestrel-events-queue", "events-queue");
  await symlink(resolve(HERE, "..", "..", "..", "node_modules", "zod"), join(nodeModules, "zod"), "dir");
}

async function runInCleanProcess(root: string, argv: string[], answers: Record<string, string> | undefined, forceInstalledMajor: number | undefined): Promise<{ code: number; lines: string[] }> {
  const scriptFile = join(root, "__run.mjs");
  const resultFile = join(root, "__result.json");
  const cliRunModule = join(PACKAGES_DIR, "upgrade", "src", "cli-run.ts");
  let answersFileArg = "";
  if (answers !== undefined) {
    const answersFile = join(root, "__answers.json");
    await writeFile(answersFile, JSON.stringify(answers));
    answersFileArg = `, "--answers", ${JSON.stringify(answersFile)}`;
  }
  const forceMajorProp = forceInstalledMajor === undefined ? "" : `, forceInstalledMajor: ${forceInstalledMajor}`;
  await writeFile(
    scriptFile,
    `import { writeFile } from "node:fs/promises";
import { runCli } from ${JSON.stringify(cliRunModule)};
const lines = [];
const code = await runCli([${argv.map((a) => JSON.stringify(a)).join(", ")}${answersFileArg}], { stdout: (l) => lines.push(l), stderr: (l) => lines.push("STDERR: " + l)${forceMajorProp} });
await writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ code, lines }));
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
  return boundaryCast<{ code: number; lines: string[] }>(JSON.parse(await readFile(resultFile, "utf8")), "json");
}

describe("offer/event-queue when events-queue is not installed", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("asks with no default and names the package to install, instead of trusting an unverifiable preview", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-queue-offer-missing-"));
    await buildDirectProject(dir, false);
    const { lines } = await runInCleanProcess(dir, ["check", "--root", dir, "--json"], undefined, 6);
    const report = boundaryCast<{ findings: Array<{ rule: string; fix: { kind: string; prompt?: string; defaultValue?: string } }> }>(JSON.parse(lines.join("\n")), "json");
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).toBe("ask");
    expect(offer?.fix.defaultValue).toBeUndefined();
    expect(offer?.fix.prompt).toContain("@michaelthielemann/kestrel-events-queue");
    expect(offer?.fix.prompt).toContain("install");
    expect(offer?.fix.prompt).toContain("run `fix` again");
  });

  it("does not write the switch under --yes, since the offer has no default", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-queue-offer-missing-yes-"));
    await buildDirectProject(dir, false);
    await runInCleanProcess(dir, ["fix", "--root", dir, "--write", "--yes"], undefined, 6);
    const configText = await readFile(join(dir, "kestrel.config.ts"), "utf8");
    expect(configText).toContain("@michaelthielemann/kestrel-events-direct");
    expect(configText).not.toContain("@michaelthielemann/kestrel-events-queue");
  });

  it("reports manual, could-not-verify instead of writing, even when yes is answered explicitly", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-queue-offer-missing-explicit-"));
    await buildDirectProject(dir, false);
    const { lines } = await runInCleanProcess(dir, ["fix", "--root", dir, "--json"], { "switch-to-queue": "yes", "idempotent:onNoteCreated": "yes", "relay-pipelines": "" }, 6);
    const reportLine = lines.find((l) => l.startsWith("{"));
    const report = boundaryCast<{ findings: Array<{ rule: string; message: string; suggestion: string; fix: { kind: string } }> }>(JSON.parse(reportLine ?? "{}"), "json");
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).toBe("manual");
    expect(offer?.message).toContain("could not verify");
    expect(offer?.suggestion).toContain("@michaelthielemann/kestrel-events-queue");
  });
});

describe("offer/event-queue when events-queue is installed", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps the default no and offers no install hint", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-queue-offer-present-"));
    await buildDirectProject(dir, true);
    const { lines } = await runInCleanProcess(dir, ["check", "--root", dir, "--json"], undefined, 6);
    const report = boundaryCast<{ findings: Array<{ rule: string; fix: { kind: string; prompt?: string; defaultValue?: string } }> }>(JSON.parse(lines.join("\n")), "json");
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).toBe("ask");
    expect(offer?.fix.defaultValue).toBe("no");
    expect(offer?.fix.prompt).not.toContain("install");
  });

  it("writes the switch once every question is answered yes", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-queue-offer-present-write-"));
    await buildDirectProject(dir, true);
    await runInCleanProcess(dir, ["fix", "--root", dir, "--write", "--yes"], { "switch-to-queue": "yes", "idempotent:onNoteCreated": "yes", "relay-pipelines": "" }, 6);
    const configText = await readFile(join(dir, "kestrel.config.ts"), "utf8");
    expect(configText).toContain("@michaelthielemann/kestrel-events-queue");
    expect(configText).not.toContain("@michaelthielemann/kestrel-events-direct");
  });
});

describe("offer/event-queue when kestrel itself is not yet on 6 (no boot tier at all)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reports manual, could-not-verify on an explicit yes, naming the kestrel upgrade first", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-queue-offer-no-boot-tier-"));
    await buildDirectProject(dir, true);
    const { lines } = await runInCleanProcess(dir, ["fix", "--root", dir, "--json"], { "switch-to-queue": "yes", "idempotent:onNoteCreated": "yes", "relay-pipelines": "" }, 5);
    const reportLine = lines.find((l) => l.startsWith("{"));
    const report = boundaryCast<{ findings: Array<{ rule: string; message: string; suggestion: string; fix: { kind: string } }> }>(JSON.parse(reportLine ?? "{}"), "json");
    const offer = report.findings.find((f) => f.rule === "offer/event-queue");
    expect(offer?.fix.kind).toBe("manual");
    expect(offer?.message).toContain("could not verify");
    expect(offer?.suggestion).toContain("upgrade @michaelthielemann/kestrel to 6");
  });

  it("writes nothing under --yes, since the offer has no default", async () => {
    dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-queue-offer-no-boot-tier-yes-"));
    await buildDirectProject(dir, true);
    await runInCleanProcess(dir, ["fix", "--root", dir, "--write", "--yes"], undefined, 5);
    const configText = await readFile(join(dir, "kestrel.config.ts"), "utf8");
    expect(configText).toContain("@michaelthielemann/kestrel-events-direct");
    expect(configText).not.toContain("@michaelthielemann/kestrel-events-queue");
  });
});
