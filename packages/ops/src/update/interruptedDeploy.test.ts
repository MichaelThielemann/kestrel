import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCATION, PREFIXES } from "../harness.fixture.ts";
import { jsonBytes } from "../layout.ts";
import type { ObjectStore } from "../store.ts";
import { runUpdate } from "./command.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { latestDeployRun } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import { planHash, versionSet } from "./plan.ts";
import type { UpdatePlan, UpdateReceipt } from "./types.ts";
import type * as Storages from "./storages.ts";

vi.mock("./storages.ts", async (importOriginal) => ({ ...(await importOriginal<typeof Storages>()), releaseStorages: async () => [] }));

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const RELEASE = { "@michaelthielemann/kestrel": "6.0.0", "@michaelthielemann/kestrel-replication-sqlite": "6.0.0" };

function signalOnPut(store: ObjectStore, signals: EventEmitter, matches: (key: string) => boolean): ObjectStore {
  let sent = false;
  return {
    ...store,
    id: store.id,
    locate: (key) => store.locate(key),
    list: (prefix) => store.list(prefix),
    head: (key) => store.head(key),
    get: (key) => store.get(key),
    read: (key, options) => store.read(key, options),
    copy: (source, key, options) => store.copy(source, key, options),
    delete: (key) => store.delete(key),
    put: async (key, data, options) => {
      await store.put(key, data, options);
      if (!sent && matches(key)) {
        sent = true;
        signals.emit("SIGTERM");
      }
    },
  };
}

describe("a deploy interrupted after the stop", { timeout: 60_000 }, () => {
  it("says that the app is stopped, that it must not be started by hand, and which command continues or ends the run", async () => {
    const h = createUpdateHarness();
    harnesses.push(h);
    await h.target.start();
    await h.target.app?.seed();
    const plan: UpdatePlan = { versions: { from: null, to: versionSet(RELEASE) }, storage: [], content: [], questions: [] };
    const hash = planHash(plan);
    const receipt: UpdateReceipt = { schema: "kestrel-ops/update-receipt@1", env: "prod", runId: "prep01", createdAt: 1, tool: { name: "@michaelthielemann/kestrel-ops", version: "0.0.0-test" }, versions: plan.versions, planHash: hash, plan, rehearsal: { ok: true, checks: [], timings: {}, peakRssBytes: null, fullMedia: false } };
    await h.store.put(LOCATION + updateKeys.receipt("prod", hash, "prep01"), jsonBytes(receipt));
    const answers = join(h.root, "answers.json");
    writeFileSync(answers, JSON.stringify({ "unsealed-stop": "accept" }));
    const signals = new EventEmitter();
    const store = signalOnPut(h.store, signals, (key) => key.startsWith(`${PREFIXES.replica}gen/`) && key.endsWith("/snapshot.db"));
    let stderr = "";
    const code = await runUpdate(["deploy", "--env", "prod", "--yes", "--answers", answers], {
      cwd: h.root,
      env: {},
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
      targets: { "fake-update": () => h.target },
      stores: () => store,
      stateRoot: join(h.root, "state"),
      poll: { delayMs: 5, attempts: 200 },
      project: { versions: RELEASE, lockfileSha256: null },
      signals,
    });
    expect(code).toBe(1);
    const run = await latestDeployRun({ backups: h.store, location: LOCATION, poll: { delayMs: 5, attempts: 200 } }, "prod");
    if (run === null) throw new Error("no deploy run");
    expect(run.state).toBe("down");
    expect((await h.target.status()).state).toBe("stopped");
    expect(stderr).toContain("interrupted by SIGTERM");
    expect(stderr).toContain("the app is stopped; do not start it by hand");
    expect(stderr).toContain(`update resume --env prod --run ${run.runId}`);
    expect(stderr).toContain(`update abort --env prod --run ${run.runId}`);
  });
});
