import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, SECRETS, type Harness } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { runOps, runUpdate } from "./run.ts";
import { createUpdateHarness, type UpdateHarness } from "./update/harness.fixture.ts";
import type { UpdateCommands } from "./update/command.ts";
import type { UpdateContext, UpdateOutcome } from "./update/types.ts";

const harnesses: Array<Harness | UpdateHarness> = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function ops(h: Harness, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runOps(args, {
    cwd: h.root,
    env: { OPS_ACCESS_KEY: SECRETS.accessKeyId, OPS_SECRET_KEY: SECRETS.secretAccessKey },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    targets: { fake: () => h.app },
    stores: () => h.store,
    stateRoot: join(h.root, "state"),
    poll: { delayMs: 5, attempts: 200 },
  });
  return { code, stdout, stderr };
}

function recordWaits(h: Harness): number[] {
  const waits: number[] = [];
  const wait = h.app.waitReady.bind(h.app);
  h.app.waitReady = async (timeoutMs?: number) => {
    waits.push(timeoutMs ?? -1);
    return wait();
  };
  return waits;
}

describe("the readiness window of a start", () => {
  it("is update.readyTimeoutSeconds when a restore and a frozen backup start the app again", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("ready-window")), update: { readyTimeoutSeconds: 7 } });
    harnesses.push(h);
    await h.app.start();
    await h.app.seed();
    const waits = recordWaits(h);
    const frozen = await h.run(["backup", "create", "--freeze", "--json"]);
    expect(frozen.code, frozen.stderr).toBe(0);
    waits.splice(0);
    const again = await ops(h, ["backup", "create", "--freeze"]);
    expect(again.code, again.stderr).toBe(0);
    const restored = await ops(h, ["restore", "--backup", String(frozen.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" })]);
    expect(restored.code, restored.stderr).toBe(0);
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(waits)).toEqual(new Set([7000]));
  });

  it("is the default of update.readyTimeoutSeconds without an update block", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("ready-default")) });
    harnesses.push(h);
    await h.app.start();
    await h.app.seed();
    const waits = recordWaits(h);
    expect((await ops(h, ["backup", "create", "--freeze"])).code).toBe(0);
    expect(waits).toEqual([300_000]);
  });

  it("is update.readyTimeoutSeconds for every update command, so a rollback, an abort and a resume wait as long as a deploy", async () => {
    const h = createUpdateHarness({ update: { readyTimeoutSeconds: 900 } });
    harnesses.push(h);
    const deployCtx = await h.context({ command: "update deploy" });
    await deployCtx.journal.record("gate", "done", {});
    await deployCtx.journal.record("stop", "done", { phase: "deploy", stoppedAt: Date.now() });
    const seen: Record<string, number> = {};
    const record = (name: string) => async (ctx: UpdateContext): Promise<UpdateOutcome> => {
      seen[name] = ctx.readyTimeoutMs;
      return { exitCode: 0, runId: ctx.run.id, state: "verified", message: "recorded", report: { runId: ctx.run.id, steps: [], downtimeMs: null } };
    };
    const commands: Partial<UpdateCommands> = { deploy: record("deploy"), rollback: record("rollback"), resume: record("resume"), abort: record("abort"), verify: record("verify") };
    for (const sub of ["rollback", "resume", "abort", "verify", "deploy"]) {
      const code = await runUpdate([sub], { cwd: h.root, env: {}, stdout: () => undefined, stderr: () => undefined, targets: { "fake-update": () => h.target }, stores: () => h.store, stateRoot: join(h.root, "state"), poll: { delayMs: 1, attempts: 20 }, project: { versions: {}, lockfileSha256: null }, updateCommands: commands });
      expect(code, sub).toBe(0);
    }
    expect(seen).toEqual({ rollback: 900_000, resume: 900_000, abort: 900_000, verify: 900_000, deploy: 900_000 });
  });
});
