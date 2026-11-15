import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { keys } from "../layout.ts";
import type { ObjectStore } from "../store.ts";
import { fixture } from "../upgradeFixture.fixture.ts";
import { CloudFoundryRun, dropOnePut, killAfterPut, RUN_LOCATION, RUN_PREFIXES, type CommandRun, type KilledStore } from "./cloudFoundryRun.fixture.ts";

type Scenarios = Array<{ run: CloudFoundryRun; store: ScenarioStore }>;
import { DEPLOY_STEPS, UPDATE_EXIT, type UpdateRun } from "./types.ts";

/** A fresh store for one scenario and how to release it. */
export interface ScenarioStore {
  store: ObjectStore;
  close(): void;
}

const NON_IDEMPOTENT = `import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
const db = new DatabaseSync(process.env.DB);
db.exec('CREATE TABLE IF NOT EXISTS content_migrations ("id" TEXT PRIMARY KEY, "appliedAt" REAL)');
if (!db.prepare("SELECT 1 AS hit FROM content_migrations WHERE id = 'pages-mark-migrated'").get()) {
  db.exec("UPDATE pages SET title = title || ' (migrated)'");
  db.exec("INSERT INTO content_migrations VALUES ('pages-mark-migrated', 1)");
}
db.close();
createServer((req, res) => {
  res.statusCode = req.url === "/ready" ? 200 : 404;
  res.end();
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const ids = (run: CommandRun): string => String(run.json.runId);

const done = (run: UpdateRun, phase: string): string[] => run.records.filter((r) => r.phase === phase && r.state === "done").map((r) => r.step);

function expectOk(run: CommandRun, code: number = UPDATE_EXIT.done): void {
  expect(run.code, `${run.stderr}\n${run.stdout.slice(-2000)}`).toBe(code);
}

/**
 * Update runs from release N to N+1 of an app on the stub Cloud Foundry platform, against the store `fresh` gives
 * each scenario: the full run with prepare, deploy, verify and accept; an ordinary deploy rolled back on request;
 * a failure injected at each point of a deploy; and the hop from the 5.8.1 fixture.
 */
export function updateEndToEnd(fresh: () => ScenarioStore): void {
  async function scenario(task: Scenarios, from: Parameters<typeof CloudFoundryRun.create>[1], to: Parameters<CloudFoundryRun["addRelease"]>[0], options: { fixture?: boolean } = {}): Promise<CloudFoundryRun> {
    const store = fresh();
    const run = await CloudFoundryRun.create(store.store, from, options).catch((error: unknown) => {
      store.close();
      throw error;
    });
    task.push({ run, store });
    run.addRelease(to);
    return run;
  }

  const scenarioTest = (title: string, body: (task: Scenarios) => Promise<void>, timeout = 300_000): void => {
    it.concurrent(
      title,
      async () => {
        const task: Scenarios = [];
        try {
          await body(task);
        } finally {
          for (const { run, store } of task) {
            await run.dispose();
            store.close();
          }
        }
      },
      timeout,
    );
  };

  async function expectCutoverState(s: CloudFoundryRun, run: UpdateRun): Promise<void> {
    expect(run.state).toBe("rolled-back");
    const backup = run.cutoverBackup ?? "";
    expect(s.liveRows()).toEqual(await s.backupRows(backup));
    expect(await s.differencesFrom(backup)).toEqual({ originals: [], delivery: [] });
  }

  scenarioTest("prepares, deploys, verifies and accepts N+1 through the stub cf, and rolls an ordinary deploy back to its cutover backup byte for byte once the loss of what it wrote is confirmed", async (task) => {
    const s = await scenario(task, { version: "6.0.0" }, { version: "6.0.1" });
    const prepared = await s.update(["prepare"]);
    expectOk(prepared);
    const receipt = boundaryCast<{ runId: string; planHash: string; versions: { to: Record<string, string> } }>(prepared.json.receipt, "json");
    expect(receipt.versions.to).toEqual({ "@michaelthielemann/kestrel": "6.0.1", "@michaelthielemann/kestrel-replication-sqlite": "6.0.1" });
    expect(await s.store.head(`${RUN_LOCATION}updates/prod/receipts/${receipt.planHash}/${receipt.runId}.json`)).not.toBeNull();

    const deployed = await s.update(["deploy"]);
    expectOk(deployed);
    const first = await s.run(ids(deployed));
    expect(first.state).toBe("verified");
    expect(first.receipt).toBe(`${receipt.planHash}/${receipt.runId}`);
    expect(done(first, "deploy").filter((step) => DEPLOY_STEPS.some((known) => known === step))).toEqual([...DEPLOY_STEPS]);
    expect(s.cf.actions.map((a) => a.action)).toEqual(["stop", "set-droplet", "start"]);
    expect(s.current().version).toBe("6.0.1");
    expect([...s.droplets.droplets.keys()]).toEqual([s.api.droplet]);
    expect(Reflect.get(Object(deployed.json.report), "downtimeMs")).toBeGreaterThan(0);

    const status = await s.update(["status"]);
    expectOk(status);
    expect(status.json).toMatchObject({ schema: "kestrel-ops/update-status@1", run: { runId: first.runId, state: "verified", versions: { to: receipt.versions.to } } });
    const accepted = await s.update(["accept"]);
    expectOk(accepted);
    expect((await s.run(first.runId)).state).toBe("accepted");

    const envBefore = { ...s.api.env };
    const ordinary = await s.update(["deploy"]);
    expectOk(ordinary);
    const second = await s.run(ids(ordinary));
    expect(second.receipt).toBeNull();
    expect(second.records.find((r) => r.step === "gate" && r.state === "done")?.data).toMatchObject({ ordinary: true });
    expect(second.cutoverBackup).not.toBeNull();
    expect(await s.store.head(RUN_LOCATION + keys.manifest(second.cutoverBackup ?? ""))).not.toBeNull();

    const app = s.app;
    if (app === null) throw new Error("the new release does not run");
    app.run(`UPDATE pages SET "title" = 'About us' WHERE "id" = 'about'`);
    app.run(`INSERT INTO pages VALUES ('news', 'News', 'Fresh')`);
    await app.deleteMedia("m2");
    await app.upload("m9", "later.png", new TextEncoder().encode("uploaded after the deploy"));
    await app.export();
    await app.sync();

    const unanswered = await s.update(["rollback"]);
    expectOk(unanswered, UPDATE_EXIT.refused);
    expect(unanswered.stdout + unanswered.stderr).toContain("rollback-accepted");
    expect(s.current().version).toBe("6.0.1");
    const rolled = await s.update(["rollback"], { answers: { "rollback-accepted": "prod" } });
    expectOk(rolled);
    const back = await s.run(second.runId);
    await expectCutoverState(s, back);
    expect(back.records.find((r) => r.step === "rollback-verify" && r.state === "done")?.data).toMatchObject({ provenance: "applied" });
    expect(s.api.env).toEqual(envBefore);
    expect(s.current().version).toBe("6.0.1");
    expect(s.violations).toEqual([]);
  });

  scenarioTest("ends with exit 1 when staging fails, never having stopped the app, and the next deploy goes through", async (task) => {
    const s = await scenario(task, { version: "6.0.0" }, { version: "6.0.1" });
    expectOk(await s.update(["prepare"]));
    s.staging.failStaging = "buildpack error";
    const failed = await s.update(["deploy"]);
    expectOk(failed, UPDATE_EXIT.refused);
    expect(failed.stderr + failed.stdout).toContain("staging failed");
    expect(s.cf.actions).toEqual([]);
    expect((await s.run(ids(failed))).state).toBe("untouched");
    expect(s.current().version).toBe("6.0.0");
    s.staging.failStaging = null;
    const again = await s.update(["deploy"]);
    expectOk(again);
    expect(s.current().version).toBe("6.0.1");
  });

  for (const [what, to] of [
    ["does not boot", { version: "6.0.1", crashes: true }],
    ["answers 503 to its readiness check", { version: "6.0.1", ready: "not-ready" as const }],
  ] as const) {
    scenarioTest(`rolls back automatically to the cutover state and exits 3 when the new release ${what}`, async (task) => {
      const s = await scenario(task, { version: "6.0.0" }, to);
      expectOk(await s.update(["prepare"]));
      const deployed = await s.update(["deploy"]);
      expectOk(deployed, UPDATE_EXIT.rolledBack);
      await expectCutoverState(s, await s.run(ids(deployed)));
      expect(s.current().version).toBe("6.0.0");
    });
  }

  scenarioTest("halts with exit 1 while readiness answers 403, leaves the new release running, and resume verifies it once it answers", async (task) => {
    const s = await scenario(task, { version: "6.0.0" }, { version: "6.0.1", ready: "forbidden" });
    expectOk(await s.update(["prepare"]));
    const deployed = await s.update(["deploy"]);
    expectOk(deployed, UPDATE_EXIT.refused);
    expect((await s.run(ids(deployed))).state).toBe("halted");
    expect(s.current().version).toBe("6.0.1");
    expect(s.app).not.toBeNull();
    s.current().ready = "ready";
    const resumed = await s.update(["resume"]);
    expectOk(resumed);
    expect((await s.run(ids(deployed))).state).toBe("verified");
  });

  scenarioTest("starts the previous release again on the unchanged replica and exits 3 when the connection drops while the cutover backup is written", async (task) => {
    const s = await scenario(task, { version: "6.0.0" }, { version: "6.0.1" });
    expectOk(await s.update(["prepare"]));
    const rowsBefore = s.liveRows();
    const deployed = await s.update(["deploy"], { store: (store) => dropOnePut(store, (key) => key.startsWith(`${RUN_LOCATION}backups/`) && key.endsWith("/db.sqlite")) });
    expectOk(deployed, UPDATE_EXIT.rolledBack);
    const run = await s.run(ids(deployed));
    expect(run.state).toBe("rolled-back");
    expect(run.cutoverBackup).toBeNull();
    expect(run.promoted).toBeNull();
    expect(s.current().version).toBe("6.0.0");
    expect(s.liveRows()).toEqual(rowsBefore);
  });

  scenarioTest("resumes a deploy killed inside the migration from the cutover backup and applies a migration that is not idempotent once", async (task) => {
    const s = await scenario(task, { version: "6.0.0" }, { version: "6.0.1" });
    writeFileSync(join(s.root, "releases", "6.0.1", "migrate.mjs"), NON_IDEMPOTENT);
    const host = { contentMigrations: ["pages-mark-migrated"] };
    const update = { localBoot: { command: ["node", "migrate.mjs"], dir: ".", env: { DB: "{database}", PORT: "{port}" }, readyPath: "/ready", timeoutSeconds: 30 } };
    const prepared = await s.update(["prepare"], { host, update });
    expectOk(prepared);
    expect(Reflect.get(Object(prepared.json.receipt), "plan")).toMatchObject({ content: ["pages-mark-migrated"] });
    const seen: { killed?: KilledStore } = {};
    const deployed = await s.update(["deploy"], { host, update, store: (store) => (seen.killed = killAfterPut(store, (key) => /-content-migrations-done\.json$/.test(key))).store });
    expect(seen.killed?.killed).toBe(true);
    expect(deployed.code).toBe(UPDATE_EXIT.refused);
    const halfway = await s.run(ids(deployed));
    expect(halfway.state).toBe("down");
    expect(halfway.promoted).toBeNull();
    const resumed = await s.update(["resume", "--break-lock"], { host, update, answers: { "break-lock": "accept" } });
    expectOk(resumed);
    expect((await s.run(ids(deployed))).state).toBe("verified");
    const titles = boundaryCast<Array<{ title: string }>>(s.liveRows().pages, "host").map((page) => page.title);
    expect(titles.sort()).toEqual(["About (migrated)", "Contact (migrated)", "Home (migrated)"]);
  });

  scenarioTest("resumes a deploy killed right after the promotion: it swaps, starts and verifies the new release", async (task) => {
    const s = await scenario(task, { version: "6.0.0" }, { version: "6.0.1" });
    expectOk(await s.update(["prepare"]));
    const seen: { killed?: KilledStore } = {};
    const deployed = await s.update(["deploy"], { store: (store) => (seen.killed = killAfterPut(store, (key) => /-promote-done\.json$/.test(key))).store });
    expect(seen.killed?.killed).toBe(true);
    expect(deployed.code).toBe(UPDATE_EXIT.refused);
    const halfway = await s.run(ids(deployed));
    expect(halfway.promoted).not.toBeNull();
    expect(s.app).toBeNull();
    expect(s.current().version).toBe("6.0.0");
    const resumed = await s.update(["resume", "--break-lock"], { answers: { "break-lock": "accept" } });
    expectOk(resumed);
    expect((await s.run(ids(deployed))).state).toBe("verified");
    expect(s.current().version).toBe("6.0.1");
  });

  scenarioTest("refuses the hop from the 5.8.1 fixture with exit 2 in prepare and at the gate, before the app stops, when the release cannot clean the stored SVGs", async (task) => {
    const s = await scenario(task, { version: "5.8.1", runtime: "5.8.1", renders: false }, { version: "6.0.0", modules: true, svgSanitizer: false }, { fixture: true });
    const starts = s.starts.length;
    const prepared = await s.update(["prepare"]);
    expectOk(prepared, UPDATE_EXIT.usage);
    expect(prepared.stderr).toContain("kestrel-sanitize-svg");
    expect(prepared.json.receipt).toBeUndefined();
    const deployed = await s.update(["deploy"]);
    expectOk(deployed, UPDATE_EXIT.usage);
    expect(deployed.stderr + deployed.stdout).toContain("kestrel-sanitize-svg");
    const run = await s.run(ids(deployed));
    expect(run.records.some((r) => r.step === "stop")).toBe(false);
    expect(s.starts.length).toBe(starts);
    expect(s.current().version).toBe("5.8.1");
    expect(s.app).not.toBeNull();
  });

  for (const ready of ["ready", "not-ready"] as const) {
    const ending = ready === "ready" ? "verifies the new release" : "after a failed verification starts the release before 6 only on the cutover state promoted again";
    scenarioTest(`hops from the 5.8.1 fixture: prepare plans the storage migrations, deploy converts a copy of the cutover database and ${ending}`, async (task) => {
      const s = await scenario(task, { version: "5.8.1", runtime: "5.8.1", renders: false }, { version: "6.0.0", modules: true, ready }, { fixture: true });
      const prepared = await s.update(["prepare"]);
      expectOk(prepared);
      const planned = boundaryCast<{ storage: Array<{ id: string }> }>(Reflect.get(Object(prepared.json.receipt), "plan"), "json").storage.map((m) => m.id);
      expect(planned).toContain("media-default:id-key-layout");
      const deployed = await s.update(["deploy"]);
      const run = await s.run(ids(deployed));
      const migrated = run.records.find((r) => r.phase === "contentMigrations" && r.step === "storage-migrations" && r.state === "done");
      expect(JSON.stringify(migrated?.data)).toContain(planned[0] ?? "?");
      const logo = fixture.media.logo;
      if (logo === undefined) throw new Error("the fixture has no logo");
      expect(await s.store.head(logo.key)).not.toBeNull();
      if (ready === "ready") {
        expectOk(deployed);
        expect(run.state).toBe("verified");
        expect(s.current().version).toBe("6.0.0");
        expect(await s.store.head(`${RUN_PREFIXES.media}${logo.id}/logo.png`)).not.toBeNull();
      } else {
        expectOk(deployed, UPDATE_EXIT.rolledBack);
        await expectCutoverState(s, run);
        expect(s.current().version).toBe("5.8.1");
        expect(s.starts.at(-1)).toEqual({ version: "5.8.1", origin: "restore" });
        expect(run.records.find((r) => r.step === "rollback-verify" && r.state === "done")?.data).toMatchObject({ provenance: "marker" });
      }
      expect(s.violations).toEqual([]);
    });
  }
}
