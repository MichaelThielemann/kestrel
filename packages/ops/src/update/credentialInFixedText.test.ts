import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line no-restricted-imports -- an error answer of the stub platform
import { fakeJson } from "../../../target-cloudfoundry/src/fakeCloudFoundry.fixture.ts";
import { createHarness, LOCATION } from "../harness.fixture.ts";
import { jsonBytes, keys, parseJson } from "../layout.ts";
import { MemoryBucket, memoryStore } from "../memoryStore.ts";
import { MASK } from "../redact.ts";
import { CloudFoundryRun, RUN_LOCATION } from "./cloudFoundryRun.fixture.ts";
import { runContentMigrations } from "./contentMigrations.ts";
import { createUpdateHarness } from "./harness.fixture.ts";
import { rollbackCommand } from "./rollback.ts";
import { acceptRun, continueRun, createScenario, deployUntil } from "./scenario.fixture.ts";
import { updateKeys } from "./layout.ts";
import type { ObjectStore } from "../store.ts";
import { UPDATE_EXIT } from "./types.ts";

const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);

function documentsUnder(bucket: MemoryBucket, prefix: string): Array<{ key: string; value: unknown }> {
  const found: Array<{ key: string; value: unknown }> = [];
  for (const [key, object] of bucket.objects) if (key.startsWith(prefix) && key.endsWith(".json")) found.push({ key, value: parseJson(object.data) });
  return found;
}

describe("credentials that are part of the tool's fixed text", { timeout: 60_000 }, () => {
  it.each([
    { accessKeyId: "kestrel", secretAccessKey: "backup" },
    { accessKeyId: "ops", secretAccessKey: "kestrel-ops" },
  ])("leave the manifest, the journal and the JSON output of a backup and its restore intact (access key $accessKeyId, secret $secretAccessKey)", async (credentials) => {
    const bucket = new MemoryBucket("fixed-text");
    const h = createHarness({ store: memoryStore(bucket) });
    const env = { OPS_ACCESS_KEY: credentials.accessKeyId, OPS_SECRET_KEY: credentials.secretAccessKey };
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"], { env });
      expect(backup.code, backup.stderr).toBe(0);
      expect(backup.json.schema).toBe("kestrel-ops/backup-create@1");
      const id = String(backup.json.id);
      const manifest = parseJson(bucket.objects.get(LOCATION + keys.manifest(id))?.data ?? new Uint8Array());
      expect(field(manifest, "schema")).toBe("kestrel-ops/backup@1");
      expect(field(field(manifest, "tool"), "name")).toBe("@michaelthielemann/kestrel-ops");
      expect(field(backup.json.manifest, "schema")).toBe("kestrel-ops/backup@1");
      const journal = documentsUnder(bucket, `${LOCATION}runs/`);
      expect(journal.length).toBeGreaterThan(2);
      expect(journal.filter(({ value }) => field(field(value, "data"), "backupId") === id).length).toBeGreaterThan(0);

      const verified = await h.run(["backup", "verify", id, "--json"], { env });
      expect(verified.code, verified.stderr).toBe(0);
      const restored = await h.run(["restore", "--backup", id, "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"], { env });
      expect(restored.code, restored.stderr).toBe(0);
      expect(restored.json.schema).toBe("kestrel-ops/restore@1");
    } finally {
      await h.dispose();
    }
  });

  it("let a deploy through the stub Cloud Foundry platform verify, and its rollback restore the recorded configuration", async () => {
    const credentials = { accessKeyId: "kestrel", secretAccessKey: "backup" };
    const bucket = new MemoryBucket("kestrel-test");
    const s = await CloudFoundryRun.create(memoryStore(bucket), { version: "6.0.0" });
    try {
      s.addRelease({ version: "6.0.1" });
      const prepared = await s.update(["prepare"], { credentials });
      expect(prepared.code, prepared.stderr).toBe(UPDATE_EXIT.done);
      expect(prepared.json.schema).toBe("kestrel-ops/update-prepare@1");
      const envBefore = { ...s.api.env };
      const deployed = await s.update(["deploy"], { credentials });
      expect(deployed.code, deployed.stderr).toBe(UPDATE_EXIT.done);
      const runId = String(deployed.json.runId);
      const run = await s.run(runId);
      expect(run.state).toBe("verified");
      const configuration = parseJson(bucket.objects.get(RUN_LOCATION + updateKeys.configuration("prod", runId))?.data ?? new Uint8Array());
      expect(field(configuration, "schema")).toBe("kestrel-ops/configuration@1");
      expect(field(field(configuration, "env"), "SITE_NAME")).toEqual({ value: "Example" });
      const manifest = parseJson(bucket.objects.get(RUN_LOCATION + keys.manifest(run.cutoverBackup ?? ""))?.data ?? new Uint8Array());
      expect(field(manifest, "schema")).toBe("kestrel-ops/backup@1");
      for (const { key, value } of documentsUnder(bucket, `${RUN_LOCATION}updates/prod/receipts/`)) expect(field(value, "schema"), key).toBe("kestrel-ops/update-receipt@1");

      const status = await s.update(["status"], { credentials });
      expect(status.code, status.stderr).toBe(UPDATE_EXIT.done);
      expect(status.json.schema).toBe("kestrel-ops/update-status@1");

      const rolled = await s.update(["rollback"], { credentials, answers: { "rollback-accepted": "prod" } });
      expect(rolled.code, rolled.stderr).toBe(UPDATE_EXIT.done);
      expect((await s.run(runId)).state).toBe("rolled-back");
      expect(s.api.env).toEqual(envBefore);
      expect(s.current().version).toBe("6.0.0");
    } finally {
      await s.dispose();
    }
  });
});

describe("command hints when a credential equals a word of them", { timeout: 60_000 }, () => {
  const SECRET = "Wq7n3Lx9Rt2Vb8Kc4Hd6Jf1Mp5Zs0Ya";

  it.each(["kestrel", "update", "prod"])("print the next command of a deploy, its status and its accept as written (access key %s)", async (accessKeyId) => {
    const credentials = { accessKeyId, secretAccessKey: SECRET };
    const s = await CloudFoundryRun.create(memoryStore(new MemoryBucket("hints")), { version: "6.0.0" });
    try {
      s.addRelease({ version: "6.0.1" });
      const prepared = await s.update(["prepare"], { credentials, json: false });
      expect(prepared.code, prepared.stderr).toBe(UPDATE_EXIT.done);
      expect(prepared.stdout).toContain("Next: commit the update and run the deploy pipeline");
      expect(prepared.stdout + prepared.stderr).not.toContain(MASK);
      const deployed = await s.update(["deploy"], { credentials });
      expect(deployed.code, deployed.stderr).toBe(UPDATE_EXIT.done);
      expect(String(deployed.json.message)).not.toContain(MASK);
      const runId = String(deployed.json.runId);

      const status = await s.update(["status"], { credentials, json: false });
      expect(status.code, status.stderr).toBe(UPDATE_EXIT.done);
      expect(status.stdout).toContain(`  next: kestrel update accept --env prod --run ${runId}\n`);
      expect(status.stdout).toContain(`run ${runId}  update deploy  verified`);
      expect(status.stdout + status.stderr).not.toContain(MASK);

      const accepted = await s.update(["accept"], { credentials, json: false });
      expect(accepted.code, accepted.stderr).toBe(UPDATE_EXIT.done);
      expect(accepted.stdout).toContain(`update run ${runId} accepted; the cutover backup prod-`);
      expect(accepted.stdout).toContain("stays pinned until update cleanup");
      expect(accepted.stdout + accepted.stderr).not.toContain(MASK);

      const after = await s.update(["status"], { credentials, json: false });
      expect(after.stdout).toContain(`  next: kestrel update cleanup --env prod --run ${runId}\n`);
      expect(after.stdout + after.stderr).not.toContain(MASK);
    } finally {
      await s.dispose();
    }
  });

  it("mask a credential that an answer of the platform quotes, inside a message whose hint stays as written", async () => {
    const credentials = { accessKeyId: "kestrel", secretAccessKey: "update" };
    const s = await CloudFoundryRun.create(memoryStore(new MemoryBucket("hints")), { version: "6.0.0" });
    try {
      s.addRelease({ version: "6.0.1" });
      expect((await s.update(["prepare"], { credentials })).code).toBe(UPDATE_EXIT.done);
      s.cf.routes.unshift(({ method, url }) => (method === "DELETE" && url.pathname.startsWith("/v3/droplets/") ? fakeJson({ errors: [{ title: "CF-NotAuthorized: token of kestrel with secret update expired" }] }) : undefined));
      const deployed = await s.update(["deploy"], { credentials, json: false });
      expect(deployed.code, deployed.stderr).toBe(UPDATE_EXIT.refused);
      const runId = (await s.update(["status"], { credentials })).json;
      const id = String(Reflect.get(Object(runId.run), "runId"));
      expect(deployed.stdout).toContain(`answered CF-NotAuthorized: token of ${MASK} with secret ${MASK} expired; `);
      expect(deployed.stdout).toContain(`; run update resume --env prod --run ${id} to retire them`);
      expect(deployed.stdout).not.toContain("token of kestrel");
      expect(deployed.stdout).not.toContain("secret update");
    } finally {
      await s.dispose();
    }
  });

  it("mask a credential that an error of the store quotes, also in the JSON message", async () => {
    const credentials = { accessKeyId: "prod", secretAccessKey: SECRET };
    const s = await CloudFoundryRun.create(memoryStore(new MemoryBucket("hints")), { version: "6.0.0" });
    try {
      const denied = (store: ObjectStore): ObjectStore => ({
        ...store,
        list: () => Promise.reject(new Error(`AccessDenied: access key prod with secret ${SECRET} may not list this bucket`)),
      });
      const text = await s.update(["status"], { credentials, json: false, store: denied });
      expect(text.code).toBe(1);
      expect(text.stderr).toContain(`error: AccessDenied: access key ${MASK} with secret ${MASK} may not list this bucket`);
      expect(text.stderr).not.toContain(SECRET);
      const json = await s.update(["status"], { credentials, store: denied });
      expect(String(json.json.message)).toContain(`access key ${MASK} with secret ${MASK} may not list`);
      expect(json.stdout).not.toContain(SECRET);
    } finally {
      await s.dispose();
    }
  });
});

describe("questions and refusals when a credential equals a word of them", { timeout: 60_000 }, () => {
  const credentials = { accessKeyId: "update", secretAccessKey: "prod" };

  it("print the update-stop question of a deploy without --yes and without an answers file as written", async () => {
    const s = await CloudFoundryRun.create(memoryStore(new MemoryBucket("questions")), { version: "6.0.0" });
    try {
      s.addRelease({ version: "6.0.1" });
      expect((await s.update(["prepare"], { credentials })).code).toBe(UPDATE_EXIT.done);
      const text = await s.update(["deploy"], { credentials, json: false, yes: false, answersFile: false });
      expect(text.code, text.stderr).toBe(UPDATE_EXIT.refused);
      expect(text.stdout).toContain(`the deploy stopped at stop before the app was stopped; production is unchanged: stopped: "update-stop" needs an answer (--yes or --answers). stop prod now for the cutover backup`);
      expect(text.stdout + text.stderr).not.toContain(MASK);
      const json = await s.update(["deploy"], { credentials, yes: false, answersFile: false });
      expect(json.code).toBe(UPDATE_EXIT.refused);
      expect(String(json.json.message)).toContain(`"update-stop" needs an answer (--yes or --answers). stop prod now`);
      expect(json.stdout).not.toContain(MASK);
      expect(s.current().version).toBe("6.0.0");
    } finally {
      await s.dispose();
    }
  });

  it("mask an answer of the answers file and a credential that an error of the store quotes", async () => {
    const s = await CloudFoundryRun.create(memoryStore(new MemoryBucket("questions")), { version: "6.0.0" });
    try {
      s.addRelease({ version: "6.0.1" });
      expect((await s.update(["prepare"], { credentials })).code).toBe(UPDATE_EXIT.done);
      const answered = await s.update(["deploy"], { credentials, json: false, yes: false, answers: { "update-stop": "prod" } });
      expect(answered.code).toBe(UPDATE_EXIT.refused);
      expect(answered.stdout).toContain(`stopped: the answers file answers "update-stop" with "${MASK}"`);
      const denied = (store: ObjectStore): ObjectStore => ({
        ...store,
        put: (key, data, options) => (key.endsWith("/configuration.json") ? Promise.reject(new Error("AccessDenied: key update with secret prod may not write here")) : store.put(key, data, options)),
      });
      const failed = await s.update(["deploy"], { credentials, json: false, store: denied });
      expect(failed.code).toBe(UPDATE_EXIT.refused);
      expect(failed.stdout).toContain(`the deploy stopped at configuration before the app was stopped; production is unchanged: AccessDenied: key ${MASK} with secret ${MASK} may not write here`);
    } finally {
      await s.dispose();
    }
  });

  it("print the holder of the lock and the break-lock question as written, and mask the host the lock names", async () => {
    const bucket = new MemoryBucket("lock-holder");
    const h = createHarness({ store: memoryStore(bucket) });
    const env = { OPS_ACCESS_KEY: "lock", OPS_SECRET_KEY: "laptop" };
    try {
      await h.app.start();
      await h.app.seed();
      bucket.write(LOCATION + keys.lock("busy", Date.now(), "start"), jsonBytes({ runId: "busy", command: "restore", host: "laptop", pid: 7 }), "put");
      const held = await h.run(["backup", "create"], { env });
      expect(held.code).toBe(1);
      expect(held.stderr).toContain(`error: another run holds the lock: busy (restore) on ${MASK}, pid 7, since `);
      expect(held.stderr).toContain(`; once that process no longer runs, run the command again with --break-lock and the answer "break-lock": "accept"`);
      const asked = await h.run(["backup", "create", "--break-lock", "--yes"], { env });
      expect(asked.code).toBe(1);
      expect(asked.stderr).toContain(`"break-lock" needs an answer ("break-lock": "accept" in --answers; --yes does not answer it). release the lock of run busy (restore) on ${MASK}, pid 7, last heartbeat `);
      expect(asked.stderr).toContain("; only when that run is no longer running");
      expect(held.stderr + asked.stderr).not.toContain("laptop");
    } finally {
      await h.dispose();
    }
  });

  it("print the confirm question of a restore without --yes as written", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("restore-question")) });
    const env = { OPS_ACCESS_KEY: "restore", OPS_SECRET_KEY: "prod" };
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"], { env });
      expect(backup.code, backup.stderr).toBe(0);
      const id = String(backup.json.id);
      const asked = await h.run(["restore", "--backup", id], { env });
      expect(asked.code).toBe(1);
      expect(asked.stderr).toContain(`error: stopped: "confirm" needs an answer (--yes or --answers). restore ${id} (`);
      expect(asked.stderr).toContain(") over prod: the app stops now");
      expect(asked.stderr).not.toContain(MASK);
    } finally {
      await h.dispose();
    }
  });

  it("print the rollback-accepted prompt, its loss lines and its refusal as written, and mask the tables, users and answers they quote", async () => {
    const s = await createScenario({ from: { renders: false } });
    try {
      const deployed = await deployUntil(s, "verify");
      await acceptRun(s, deployed.runId);
      const app = s.h.target.app;
      if (app === null) throw new Error("the new release does not run");
      app.run(`INSERT INTO pages VALUES ('news', 'News', 'Written after the update')`);
      app.run(`INSERT INTO authn_users VALUES ('u9', 'rollback-editor', 'x', '["editor"]', 1, 0)`);
      await app.sync();

      const prompts: string[] = [];
      const asked = await continueRun(s, deployed.runId, "update rollback", { yes: false });
      for (const secret of ["rollback", "prod", "pages"]) asked.ctx.redactor.add(secret);
      asked.ctx.answers.prompt = async (question) => {
        prompts.push(asked.ctx.redactor.apply(question));
        return "rollback";
      };
      const refused = await rollbackCommand(asked.ctx, asked.run);
      expect(refused.exitCode).toBe(UPDATE_EXIT.refused);
      expect(asked.ctx.redactor.apply(refused.message)).toContain(`stopped: "rollback-accepted" was answered with "${MASK}", not the environment's name; the app was started again`);
      const info = s.h.output.info.join("\n");
      expect(info).toContain(`run ${asked.run.runId} was accepted `);
      expect(info).toContain(`; rolling back discards everything written since the cutover backup ${asked.run.cutoverBackup ?? ""}`);
      expect(info).toContain(" that the rollback discards or reverts:");
      expect(info).toContain(`  ${MASK}: 1 newer row(s) dropped, 0 changed row(s) reverted, 0 deleted row(s) back`);
      expect(info).toContain(`access changes: \n  created: ${MASK}-editor`);
      expect(info).toContain("every login session ends; everyone signs in again");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("that the rollback discards or reverts:");
      expect(prompts[0]?.endsWith("\nType the environment's name to roll back (rollback-accepted): ")).toBe(true);

      const unanswered = await continueRun(s, deployed.runId, "update rollback", { yes: true });
      for (const secret of ["rollback", "prod", "pages"]) unanswered.ctx.redactor.add(secret);
      const stopped = await rollbackCommand(unanswered.ctx, unanswered.run);
      expect(stopped.exitCode).toBe(UPDATE_EXIT.refused);
      expect(unanswered.ctx.redactor.apply(stopped.message)).toContain(`stopped: "rollback-accepted" needs the environment's name prod as its answer ("rollback-accepted": "prod" in --answers; --yes does not answer it); the app was started again`);
      expect((await s.h.target.status()).state).toBe("started");
    } finally {
      await s.h.dispose();
    }
  });

  it("print the refusal of a pending content migration without a local start as written", async () => {
    const h = createUpdateHarness();
    const work = mkdtempSync(join(tmpdir(), "kestrel-ops-fixed-"));
    try {
      const database = join(work, "copy.sqlite");
      const db = new DatabaseSync(database);
      db.exec(`CREATE TABLE content_migrations ("id" TEXT PRIMARY KEY, "appliedAt" INTEGER, "documents" INTEGER, "durationMs" INTEGER)`);
      db.close();
      const ctx = await h.context();
      for (const secret of ["update", "prod", "hits"]) ctx.redactor.add(secret);
      const error = await runContentMigrations(ctx, { database, blobsDir: join(work, "blobs"), expected: ["count-hits"] }).catch((caught: unknown) => caught);
      expect(ctx.redactor.apply(error instanceof Error ? error.message : "")).toBe(`content migrations count-${MASK} are pending, and update.localBoot of prod names no local start of the release to apply them with`);
    } finally {
      rmSync(work, { recursive: true, force: true });
      await h.dispose();
    }
  });
});
