import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { OpsError } from "../errors.ts";
import { LOCATION } from "../harness.fixture.ts";
import type { RunOptions } from "../run.ts";
import { runUpdate as fromRun, UPDATE_USAGE as usageFromRun } from "../run.ts";
import type { Target } from "../target.ts";
import { runUpdate, UPDATE_USAGE, type UpdateCommands } from "./command.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { readUpdateRun, RUN_STEP } from "./journal.ts";
import type { UpdateContext, UpdateExitCode, UpdateOutcome, UpdateRun } from "./types.ts";

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

function harness(): UpdateHarness {
  const h = createUpdateHarness();
  harnesses.push(h);
  return h;
}

const RELEASE = { "@michaelthielemann/kestrel": "6.0.0", "@michaelthielemann/kestrel-ops": "6.0.0", "some-other-package": "1.0.0" };

async function run(h: UpdateHarness, args: string[], extra: Partial<RunOptions> = {}): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const code = await runUpdate(args, {
    cwd: h.root,
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    targets: { "fake-update": () => h.target },
    stores: () => h.store,
    stateRoot: join(h.root, "state"),
    poll: { delayMs: 1, attempts: 20 },
    project: { versions: RELEASE, lockfileSha256: "ab".repeat(32) },
    ...extra,
  });
  const start = stdout.lastIndexOf('{\n  "schema"');
  const json = start < 0 ? {} : boundaryCast<Record<string, unknown>>(JSON.parse(stdout.slice(start)), "json");
  return { code, stdout, stderr, json };
}

const outcome = (ctx: UpdateContext, exitCode: UpdateExitCode, message = "finished"): UpdateOutcome => ({ exitCode, runId: ctx.run.id, state: "verified", message, report: { runId: ctx.run.id, steps: [], downtimeMs: 372_000 } });

async function deployRun(h: UpdateHarness): Promise<string> {
  const ctx = await h.context({ command: "update deploy" });
  await ctx.journal.record("gate", "done", {});
  return ctx.run.id;
}

const reader = (h: UpdateHarness) => ({ backups: h.store, location: LOCATION, poll: { delayMs: 1, attempts: 20 } });

const CONTINUING = ["verify", "accept", "rollback", "resume", "abort", "cleanup"] as const;

describe("kestrel update on the command line", () => {
  it("is exported from kestrel-ops/run next to runOps", () => {
    expect(fromRun).toBe(runUpdate);
    expect(usageFromRun).toBe(UPDATE_USAGE);
  });

  it("prints the usage with the seven operator commands for --help and exits 0", async () => {
    const h = harness();
    const help = await run(h, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toBe(`${UPDATE_USAGE}\n`);
    expect([...UPDATE_USAGE.matchAll(/^ {2}update (\S+)/gm)].map((m) => m[1])).toEqual(["prepare", "accept", "rollback", "status", "resume", "abort", "cleanup"]);
    expect(UPDATE_USAGE).not.toMatch(/\b(deploy|verify|bundle)\b/);
  });

  it("answers a usage error with exit 2, the usage on stderr and an error document", async () => {
    const h = harness();
    for (const [args, message] of [
      [[], "no update command given"],
      [["upgrade"], "unknown update command upgrade"],
      [["accept", "extra"], "update accept takes no argument extra"],
      [["accept", "--full-media"], "update accept does not take --full-media"],
      [["prepare", "--run", "abc"], "update prepare does not take --run"],
      [["status", "--frobnicate"], "update status does not take --frobnicate"],
      [["resume", "--run"], "--run needs a value"],
      [["resume", "--run", "../x"], "../x is not a run id"],
    ] as const) {
      const result = await run(h, [...args, "--json"]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain(message);
      expect(result.stderr).toContain(UPDATE_USAGE);
      expect(result.json).toMatchObject({ schema: "kestrel-ops/error@1", ok: false });
    }
    expect([...(h.bucket?.objects.keys() ?? [])].filter((key) => key.startsWith(`${LOCATION}locks/`))).toEqual([]);
  });

  it("refuses with exit 2 a target that cannot run an update, before it writes anything", async () => {
    const h = harness();
    const plain: Target = { transport: "promote", describe: async () => ({ kind: "plain", packages: {} }), status: async () => ({ state: "started", instances: 1 }), stop: async () => ({ stoppedAt: Date.now() }), start: async () => undefined, waitReady: async () => true };
    for (const sub of ["prepare", "status", "accept"]) {
      const result = await run(h, [sub, "--json"], { targets: { "fake-update": () => plain } });
      expect(result.code, sub).toBe(2);
      expect(result.stderr, sub).toContain("cannot run an update");
      expect(result.json).toMatchObject({ schema: `kestrel-ops/update-${sub}@1`, ok: false, exitCode: 2 });
    }
    expect([...(h.bucket?.objects.keys() ?? [])]).toEqual([]);
  });

  it("hands prepare and deploy a new run with the release and host facts, and maps each outcome to its exit code", async () => {
    const h = harness();
    const seen: UpdateContext[] = [];
    const commands: Partial<UpdateCommands> = {
      prepare: async (ctx, options) => {
        seen.push(ctx);
        expect(options).toEqual({ fullMedia: true });
        return { receipt: boundaryCast<Awaited<ReturnType<UpdateCommands["prepare"]>>["receipt"]>({ schema: "kestrel-ops/update-receipt@1", runId: ctx.run.id }, "host"), outcome: outcome(ctx, 0, "receipt written") };
      },
      deploy: async (ctx) => {
        seen.push(ctx);
        return outcome(ctx, 3, "rolled back");
      },
    };
    const host = { readyPath: "/ready", localBootEnv: { MODE: "local" } };
    const prepared = await run(h, ["prepare", "--full-media", "--json"], { updateCommands: commands, host });
    expect(prepared.code).toBe(0);
    expect(prepared.json).toMatchObject({ schema: "kestrel-ops/update-prepare@1", ok: true, exitCode: 0, message: "receipt written", receipt: { schema: "kestrel-ops/update-receipt@1" } });
    const deployed = await run(h, ["deploy"], { updateCommands: commands, host, releaseRoot: join(h.root, "artifact") });
    expect(deployed.code).toBe(3);
    expect(deployed.stdout).toContain("rolled back\ndowntime 6 min 12 s\n");
    const [prepareCtx, deployCtx] = seen;
    expect(prepareCtx?.run.id).toBe(prepareCtx?.runId);
    expect(prepareCtx?.release).toEqual({ dir: h.releaseDir, versions: { "@michaelthielemann/kestrel": "6.0.0", "@michaelthielemann/kestrel-ops": "6.0.0" }, lockfileSha256: "ab".repeat(32) });
    expect(prepareCtx?.host).toEqual(host);
    expect(prepareCtx?.update.sealTimeoutSeconds).toBe(1);
    expect(deployCtx?.release.dir).toBe(join(h.root, "artifact", "release"));
    const journal = await readUpdateRun(reader(h), deployCtx?.run.id ?? "");
    expect(journal.records[0]).toMatchObject({ step: RUN_STEP, data: { command: "update deploy", env: "prod", phase: "deploy", process: deployCtx?.runId } });
    expect(journal.records.at(-1)).toMatchObject({ step: "run-done", data: { exitCode: 3 } });
  });

  it("continues the newest deploy run, or the one --run names, for every later command and takes the lock", async () => {
    const h = harness();
    const older = await deployRun(h);
    await new Promise((done) => setTimeout(done, 5));
    const newest = await deployRun(h);
    const received: Array<{ command: string; run: UpdateRun; ctx: UpdateContext }> = [];
    const record = (command: string, code: UpdateExitCode) => async (ctx: UpdateContext, r: UpdateRun) => {
      received.push({ command, run: r, ctx });
      return outcome(ctx, code);
    };
    const commands: Partial<UpdateCommands> = { verify: record("verify", 1), accept: record("accept", 0), rollback: record("rollback", 0), resume: record("resume", 3), abort: record("abort", 0), cleanup: async (ctx, r, options) => ({ ...(await record("cleanup", 0)(ctx, r)), message: `dry ${String(options.dryRun)}` }) };
    const expected = { verify: 1, accept: 0, rollback: 0, resume: 3, abort: 0, cleanup: 0 };
    for (const sub of CONTINUING) {
      const result = await run(h, [sub, "--json", ...(sub === "cleanup" ? ["--dry-run"] : [])], { updateCommands: commands });
      expect(result.code, sub).toBe(expected[sub]);
      expect(result.json, sub).toMatchObject({ schema: `kestrel-ops/update-${sub}@1`, ok: expected[sub] === 0, exitCode: expected[sub], runId: newest });
    }
    expect(received.map((r) => [r.command, r.run.runId, r.ctx.run.id])).toEqual(CONTINUING.map((sub) => [sub, newest, newest]));
    const named = await run(h, ["accept", "--run", older], { updateCommands: commands });
    expect(named.code).toBe(0);
    expect(received.at(-1)?.run.runId).toBe(older);
    const journal = await readUpdateRun(reader(h), newest);
    expect(journal.records.filter((r) => r.step === RUN_STEP).map((r) => r.data.command)).toEqual(["update deploy", ...CONTINUING.map((sub) => `update ${sub}`)]);
    const opening = journal.records.find((r) => r.data.command === "update accept");
    expect(opening).toMatchObject({ phase: "accept", data: { env: "prod", phase: "accept", process: received[1]?.ctx.runId } });
    const locks = [...(h.bucket?.objects.keys() ?? [])].filter((key) => key.startsWith(`${LOCATION}locks/`));
    expect(locks.filter((key) => key.includes("-start-"))).toHaveLength(CONTINUING.length + 1);
    expect(locks.filter((key) => key.includes("-released-"))).toHaveLength(CONTINUING.length + 1);
  });

  it("reads status without a lock or a journal entry and prints it as one document", async () => {
    const h = harness();
    const id = await deployRun(h);
    const before = [...(h.bucket?.objects.keys() ?? [])];
    const result = await run(h, ["status", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ schema: "kestrel-ops/update-status@1", ok: true, env: "prod", run: { runId: id, state: "deploying", next: `kestrel update abort --env prod --run ${id}` } });
    expect([...(h.bucket?.objects.keys() ?? [])]).toEqual(before);
    const text = await run(h, ["status"]);
    expect(text.stdout).toContain(`run ${id}  update deploy  deploying`);
  });

  it("ends a command that throws with its error's exit code and the run's report", async () => {
    const h = harness();
    await deployRun(h);
    const failing = (error: Error): Partial<UpdateCommands> => ({
      accept: async () => {
        throw error;
      },
    });
    const refused = await run(h, ["accept", "--json"], { updateCommands: failing(new OpsError("the run is not verified", 1, "accept")) });
    expect(refused.code).toBe(1);
    expect(refused.json).toMatchObject({ schema: "kestrel-ops/update-accept@1", ok: false, exitCode: 1, element: "accept", report: { steps: [{ step: "gate" }] } });
    const crashed = await run(h, ["accept"], { updateCommands: failing(new Error("disk full")) });
    expect(crashed.code).toBe(1);
    expect(crashed.stderr).toContain("error: disk full");
    const missing = await run(h, ["accept"], { updateCommands: failing(new OpsError("kestrel-ops update: accept(x) is not implemented", 2, "accept(x)")) });
    expect(missing.code).toBe(2);
  });

  it("refuses with exit 1 a later command for an environment without a deploy run", async () => {
    const h = harness();
    const result = await run(h, ["accept", "--json"], { updateCommands: { accept: async (ctx) => outcome(ctx, 0) } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has no update run to continue");
  });

  it("gives every command the update steps the caller replaces", async () => {
    const h = harness();
    let replaced = false;
    const migrateCopy = async () => {
      replaced = true;
      return { sha256: "", storage: [], content: [], changedTables: [] };
    };
    const result = await run(h, ["deploy"], {
      updateSteps: { migrateCopy },
      updateCommands: {
        deploy: async (ctx) => {
          await ctx.steps.migrateCopy(ctx, { cutoverBackup: "x", plan: { versions: { from: null, to: {} }, storage: [], content: [], questions: [] }, outFile: "x" });
          expect(typeof ctx.steps.verify).toBe("function");
          return outcome(ctx, 0);
        },
      },
    });
    expect(result.code).toBe(0);
    expect(replaced).toBe(true);
  });
});
