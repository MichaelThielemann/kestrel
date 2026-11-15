import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { listBackups } from "../backup.ts";
import { LOCATION, PREFIXES } from "../harness.fixture.ts";
import { fromJsonl, keys, type SiteEntry } from "../layout.ts";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { listGenerations, markerKey } from "../replica.ts";
import { sha256 } from "../sqlite.ts";
import { stableList, type ObjectStore } from "../store.ts";
import { reportOf } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import { rollback, rollbackCommand } from "./rollback.ts";
import { acceptRun, blobsOf, continueRun, createScenario, deployUntil, guardStarts, newestOrigin, rowsOf, runOf, type Scenario, type ScenarioOptions } from "./scenario.fixture.ts";
import { UPDATE_EXIT } from "./types.ts";

const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const s of scenarios.splice(0)) await s.h.dispose();
});

const OLD_SECRET = "old-token-value-3c8a";
const NEW_SECRET = "rotated-token-value-9e1d";

async function scenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const s = await createScenario({ from: { renders: false }, env: { KESTREL_MIGRATIONS: "apply", API_TOKEN: OLD_SECRET, SITE_NAME: "Studio" }, secretNames: ["API_TOKEN"], to: { env: { KESTREL_MIGRATIONS: "check", ADDED_BY_RELEASE: "1" } }, ...options });
  scenarios.push(s);
  return s;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function writeAfterUpdate(s: Scenario): Promise<void> {
  const app = s.h.target.app;
  if (app === null) throw new Error("the new release does not run");
  app.run(`UPDATE pages SET "title" = 'About us now' WHERE "id" = 'about'`);
  app.run(`INSERT INTO pages VALUES ('news', 'News', 'Written after the update')`);
  app.run(`INSERT INTO authn_sessions VALUES ('s9', 'u1', 9999999999999, 9)`);
  await s.h.store.put(`${PREFIXES.media}m1/harbour.jpg`, encode("bytes the new release wrote over an original"));
  await app.upload("m7", "later.png", encode("uploaded after the update"));
  await app.export();
  await app.sync();
}

async function cutoverRows(s: Scenario, backupId: string): Promise<Record<string, unknown[]>> {
  const file = s.h.target.options.dir + "-cutover.db";
  writeFileSync(file, (await s.h.store.get(LOCATION + keys.db(backupId))) ?? new Uint8Array());
  return rowsOf(file);
}

async function expectCutoverState(s: Scenario, backupId: string): Promise<void> {
  const app = s.h.target.app;
  if (app === null) throw new Error("the previous release does not run");
  const expected = await cutoverRows(s, backupId);
  for (const [table, rows] of Object.entries(expected)) expect(app.rows(table), table).toEqual(table === "authn_sessions" ? [] : rows);
  for (const entry of await blobsOf(s.h.store, backupId)) {
    const live = await s.h.store.head(entry.key);
    expect([live?.etag, live?.size], entry.key).toEqual([entry.etag, entry.size]);
  }
  const site = boundaryCast<SiteEntry[]>(fromJsonl((await s.h.store.get(LOCATION + keys.site(backupId))) ?? new Uint8Array()), "json");
  const live = await stableList(s.h.store, PREFIXES.delivery, { delayMs: 5 });
  expect(live.map((i) => i.key).sort()).toEqual(site.map((e) => e.key).sort());
  for (const entry of site) expect(sha256((await s.h.store.get(entry.key)) ?? ""), entry.key).toBe(sha256((await s.h.store.get(LOCATION + entry.object)) ?? ""));
}

const journalSteps = async (s: Scenario, runId: string): Promise<string[]> => (await runOf(s, runId)).records.map((r) => `${r.step} ${r.state}`);

describe("rolling an update back", () => {
  it("starts the previous release again on the unchanged replica when the run stopped the app but has no cutover backup", async () => {
    const s = await scenario();
    const violations = guardStarts(s);
    const before = s.h.target.app?.rows("pages");
    const deployed = await deployUntil(s, "seal");
    expect(deployed.end).toMatchObject({ last: "seal", failure: null });
    const generations = (await listGenerations(s.h.store, PREFIXES.replica)).map((g) => g.name);
    const run = await runOf(s, deployed.runId);
    expect(run.cutoverBackup).toBeNull();
    const result = await rollback(deployed.ctx, run, { kind: "automatic", failure: "cutover-backup: socket hang up" });
    expect(result).toMatchObject({ ended: "previous-release", originalsRestored: [], derived: { added: [], changed: [], missing: [] } });
    expect((await runOf(s, deployed.runId)).state).toBe("rolled-back");
    expect(s.h.target.current).toBe(s.previousDroplet);
    expect(s.h.target.app?.rows("pages")).toEqual(before);
    expect((await listGenerations(s.h.store, PREFIXES.replica)).map((g) => g.name).slice(0, generations.length)).toEqual(generations);
    expect(await journalSteps(s, deployed.runId)).toEqual(expect.arrayContaining(["rollback started", "start done", "rollback-verify done", "rollback done"]));
    expect(violations).toEqual([]);
  });

  it.each(["promote", "swap"] as const)("refuses to start the previous release for a run whose journal shows no cutover backup while a generation it promoted is in place (after %s)", async (until) => {
    const s = await scenario();
    const violations = guardStarts(s);
    const deployed = await deployUntil(s, until);
    expect(deployed.end.failure).toBeNull();
    const run = { ...(await runOf(s, deployed.runId)), cutoverBackup: null, promoted: null };
    await expect(rollback(deployed.ctx, run, { kind: "automatic", failure: "swap: platform error" })).rejects.toThrow("update resume");
    expect(s.h.target.actions.filter((a) => a === "start")).toHaveLength(1);
    expect(violations).toEqual([]);
  });

  it("brings back the cutover state: every table but the emptied sessions, the originals, the delivery prefix and the recorded configuration verbatim", async () => {
    const s = await scenario();
    const violations = guardStarts(s);
    const deployed = await deployUntil(s, "verify");
    expect(deployed.end).toMatchObject({ last: "verify", failure: null, verdict: "passed" });
    Object.assign(s.h.target.configuration, { healthCheck: { type: "process", endpoint: null, timeoutSeconds: null, invocationTimeoutSeconds: null }, memoryMb: 2048, command: "node .output/server/index.mjs" });
    s.h.target.configuration.env.API_TOKEN = NEW_SECRET;
    await writeAfterUpdate(s);
    const run = await runOf(s, deployed.runId);
    const backupId = run.cutoverBackup ?? "";

    const { ctx } = await continueRun(s, deployed.runId, "update rollback");
    const result = await rollback(ctx, run, { kind: "requested" });

    expect(result).toMatchObject({ ended: "previous-release", configuration: { removed: ["ADDED_BY_RELEASE"], unrestorable: ["API_TOKEN"] } });
    expect(result.configuration.set.sort()).toEqual(["KESTREL_MIGRATIONS", "SITE_NAME"]);
    expect(result.originalsRestored).toEqual([`${PREFIXES.media}m1/harbour.jpg`]);
    expect(s.h.target.current).toBe(s.previousDroplet);
    expect(s.h.target.configuration).toMatchObject({ env: { KESTREL_MIGRATIONS: "apply", SITE_NAME: "Studio", API_TOKEN: NEW_SECRET }, healthCheck: { type: "http", endpoint: "/ready", timeoutSeconds: 180 }, memoryMb: 1024, command: null });
    expect(s.h.target.configuration.env.ADDED_BY_RELEASE).toBeUndefined();
    await expectCutoverState(s, backupId);
    expect(result.derived).toEqual({ added: [`${PREFIXES.derived}news/thumb.webp`], changed: [`${PREFIXES.derived}about/thumb.webp`], missing: [] });
    expect(s.h.output.warn.join("\n")).toContain(`derived keys differ from the cutover backup ${backupId}: 1 added, 1 changed, 0 missing, such as ${PREFIXES.derived}news/thumb.webp`);
    expect(reportOf(await runOf(s, deployed.runId)).derived).toEqual({ added: 1, changed: 1, missing: 0, keys: { added: [`${PREFIXES.derived}news/thumb.webp`], changed: [`${PREFIXES.derived}about/thumb.webp`], missing: [] } });
    expect(violations).toEqual([]);
    const generations = (await listGenerations(s.h.store, PREFIXES.replica)).map((g) => g.name);
    expect(generations.at(-2)).toBe(result.generation);
    expect(JSON.parse(new TextDecoder().decode((await s.h.store.get(markerKey(PREFIXES.replica, result.generation, "origin"))) ?? encode("{}")))).toMatchObject({ kind: "restore", source: backupId });

    const steps = await journalSteps(s, deployed.runId);
    const tail = steps.slice(steps.indexOf("rollback started"));
    expect(tail).toEqual(["rollback started", "stop done", "seal done", "re-promote done", "restore-originals done", "restore-delivery done", "restore-configuration done", "restore-droplet done", "start started", "start done", "rollback-verify done", "unpin done", "rollback done"]);
    expect((await runOf(s, deployed.runId)).state).toBe("rolled-back");
    const verifyRecord = (await runOf(s, deployed.runId)).records.find((r) => r.step === "rollback-verify");
    expect(verifyRecord?.data).toMatchObject({ provenance: "marker" });
    for (const text of [...s.h.output.info, ...s.h.output.warn, ...s.h.output.error]) expect(text).not.toContain(OLD_SECRET);
  });

  it("waits for the seal of the stopped release before it promotes the cutover backup again", async () => {
    const s = await scenario({ from: { runtime: "6.0.0", renders: false }, to: { runtime: "6.1.0" } });
    const deployed = await deployUntil(s, "verify");
    expect(deployed.end.verdict).toBe("passed");
    s.h.target.sealDelayMs = 300;
    const run = await runOf(s, deployed.runId);
    const { ctx } = await continueRun(s, deployed.runId, "update rollback");
    const result = await rollback(ctx, run, { kind: "requested" });
    expect(result.seal).toBe("sealed");
    const records = (await runOf(s, deployed.runId)).records;
    const stop = records.filter((r) => r.step === "stop" && r.state === "done").at(-1);
    const seal = records.filter((r) => r.step === "seal").at(-1);
    const promoted = records.find((r) => r.step === "re-promote");
    expect(seal?.data).toMatchObject({ state: "sealed" });
    expect((seal?.at ?? 0) - (stop?.at ?? 0)).toBeGreaterThanOrEqual(250);
    expect(promoted?.seq).toBeGreaterThan(seal?.seq ?? Infinity);
    const own = (await listGenerations(s.h.store, PREFIXES.replica)).find((g) => g.name === seal?.data.generation);
    expect(own?.files["sealed.json"]?.lastModified ?? Infinity).toBeLessThanOrEqual(promoted?.at ?? 0);
    expect(records.find((r) => r.step === "rollback-verify")?.data).toMatchObject({ provenance: "applied" });
  });

  it("lists the delivery prefix again after replacing it and replaces what a late render wrote meanwhile", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "verify");
    await writeAfterUpdate(s);
    const run = await runOf(s, deployed.runId);
    const { ctx } = await continueRun(s, deployed.runId, "update rollback");
    const late = { done: false };
    const store = ctx.app;
    const wrapped: ObjectStore = {
      ...store,
      copy: async (source, key, options) => {
        await store.copy(source, key, options);
        if (!late.done && key.startsWith(PREFIXES.delivery)) {
          late.done = true;
          await store.put(`${PREFIXES.delivery}late/index.html`, encode("<h1>rendered late</h1>"));
          await store.put(`${PREFIXES.delivery}about/index.html`, encode("<h1>About, rendered late</h1>"));
        }
      },
    };
    ctx.app = wrapped;
    const result = await rollback(ctx, run, { kind: "requested" });
    expect(late.done).toBe(true);
    expect(result.delivery.relisted).toBeGreaterThanOrEqual(2);
    expect(result.delivery.removed).toContain(`${PREFIXES.delivery}late/index.html`);
    await expectCutoverState(s, run.cutoverBackup ?? "");
  });

  it("proves the provenance of a release before 6 through the marker row in its first snapshot", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "verify");
    const run = await runOf(s, deployed.runId);
    const { ctx } = await continueRun(s, deployed.runId, "update rollback");
    await rollback(ctx, run, { kind: "requested" });
    const record = (await runOf(s, deployed.runId)).records.find((r) => r.step === "rollback-verify");
    const generations = await listGenerations(s.h.store, PREFIXES.replica);
    expect(record?.data).toMatchObject({ provenance: "marker", ownGeneration: generations.at(-1)?.name });
  });

  it("uploads the saved bits of a deleted previous droplet, and without bits ends with the app stopped on the cutover state", async () => {
    const withBits = await scenario();
    const a = await deployUntil(withBits, "verify");
    const runA = await runOf(withBits, a.runId);
    const file = withBits.h.target.options.dir + "-droplet.json";
    expect(await withBits.h.target.saveDroplet(withBits.previousDroplet, file)).toBe(true);
    await withBits.h.store.put(LOCATION + updateKeys.droplet("prod", a.runId, withBits.previousDroplet), new Uint8Array(readFileSync(file)));
    withBits.h.target.droplets.delete(withBits.previousDroplet);
    const ctxA = (await continueRun(withBits, a.runId, "update rollback")).ctx;
    const restored = await rollback(ctxA, runA, { kind: "requested" });
    expect(restored.ended).toBe("previous-release");
    expect(withBits.h.target.actions.some((action) => action.startsWith("restore-droplet "))).toBe(true);
    expect(withBits.h.target.release.runtime).toBe("5.8.1");
    await expectCutoverState(withBits, runA.cutoverBackup ?? "");

    const without = await scenario();
    const b = await deployUntil(without, "verify");
    const runB = await runOf(without, b.runId);
    without.h.target.droplets.delete(without.previousDroplet);
    const startsBefore = without.h.target.actions.filter((x) => x === "start").length;
    const ctxB = (await continueRun(without, b.runId, "update rollback")).ctx;
    const stopped = await rollback(ctxB, runB, { kind: "requested" });
    expect(stopped.ended).toBe("stopped");
    expect((await without.h.target.status()).state).toBe("stopped");
    expect(without.h.target.actions.filter((x) => x === "start").length).toBe(startsBefore);
    expect((await newestOrigin(without.h.store))?.kind).toBe("restore");
    expect((await journalSteps(without, b.runId)).slice(-3)).toEqual(["restore-droplet failed", "start skipped", "rollback done"]);
  });
});

describe("update rollback", () => {
  it("reports a recorded value that holds the redaction mask as not restored and leaves the variable as it is", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "verify");
    const key = LOCATION + updateKeys.configuration("prod", deployed.runId);
    const recorded: unknown = JSON.parse(new TextDecoder().decode((await s.h.store.get(key)) ?? encode("{}")));
    const env: unknown = typeof recorded === "object" && recorded !== null ? Reflect.get(recorded, "env") : null;
    if (typeof env !== "object" || env === null) throw new Error("the recorded configuration holds no variables");
    Reflect.set(env, "SITE_NAME", { value: "Studio [redacted]" });
    await s.h.store.put(key, encode(JSON.stringify(recorded)));
    s.h.target.configuration.env.SITE_NAME = "Studio, renamed";
    const run = await runOf(s, deployed.runId);
    const { ctx } = await continueRun(s, deployed.runId, "update rollback");
    const result = await rollback(ctx, run, { kind: "requested" });
    expect(result.configuration.unrestorable).toContain("SITE_NAME");
    expect(result.configuration.set).not.toContain("SITE_NAME");
    expect(s.h.target.configuration.env.SITE_NAME).toBe("Studio, renamed");
    expect(s.h.output.warn.join("\n")).toContain("SITE_NAME holds another value than when the update began");
  });

  it("rolls back before accept without a question and exits 0", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "verify");
    const { ctx, run } = await continueRun(s, deployed.runId, "update rollback", { yes: false });
    const outcome = await rollbackCommand(ctx, run);
    expect(outcome).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "rolled-back" });
    expect((await listBackups(ctx)).filter((b) => b.kind === "pre-restore")).toEqual([]);
    expect((await listBackups(ctx)).find((b) => b.id === run.cutoverBackup)?.pinnedBy).toEqual([]);
  });

  it("before accept asks like after accept once the new release wrote since its start, reports what it wrote and takes a safety backup", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "verify");
    await writeAfterUpdate(s);

    const first = await continueRun(s, deployed.runId, "update rollback", { yes: false });
    const refused = await rollbackCommand(first.ctx, first.run);
    expect(refused.exitCode).toBe(UPDATE_EXIT.refused);
    expect(refused.message).toContain("rollback-accepted");
    expect(s.h.output.info.join("\n")).toContain("pages: 1 newer row(s) dropped, 1 changed row(s) reverted");
    expect((await s.h.target.status()).state).toBe("started");
    expect(s.h.target.release.runtime).toBe("6.0.0");
    expect((await listBackups(first.ctx)).filter((b) => b.kind === "pre-restore")).toEqual([]);

    const { ctx, run } = await continueRun(s, deployed.runId, "update rollback", { answers: { "rollback-accepted": "prod" }, yes: false });
    const outcome = await rollbackCommand(ctx, run);
    expect(outcome).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "rolled-back" });
    const safety = (await listBackups(ctx)).filter((b) => b.kind === "pre-restore");
    expect(safety).toHaveLength(1);
    expect(safety[0]?.verified).toBe(true);
    await expectCutoverState(s, run.cutoverBackup ?? "");
  });

  it("after accept refuses with exit 1 without the environment's name as the answer, also with --yes, and with it reports the loss and takes a safety backup", async () => {
    const s = await scenario();
    const deployed = await deployUntil(s, "verify");
    await acceptRun(s, deployed.runId);
    await writeAfterUpdate(s);

    for (const [answers, yes] of [[{}, true], [{ "rollback-accepted": "accept" }, true], [{ "rollback-accepted": "staging" }, false]] as const) {
      const { ctx, run } = await continueRun(s, deployed.runId, "update rollback", { answers, yes });
      const refused = await rollbackCommand(ctx, run);
      expect(refused.exitCode, JSON.stringify(answers)).toBe(UPDATE_EXIT.refused);
      expect((await s.h.target.status()).state).toBe("started");
      expect(s.h.target.release.runtime).toBe("6.0.0");
    }

    const { ctx, run } = await continueRun(s, deployed.runId, "update rollback", { answers: { "rollback-accepted": "prod" }, yes: false });
    const outcome = await rollbackCommand(ctx, run);
    expect(outcome).toMatchObject({ exitCode: UPDATE_EXIT.done, state: "rolled-back" });
    expect(s.h.output.info.join("\n")).toContain("pages: 1 newer row(s) dropped, 1 changed row(s) reverted");
    const safety = (await listBackups(ctx)).filter((b) => b.kind === "pre-restore");
    expect(safety).toHaveLength(1);
    expect(safety[0]?.verified).toBe(true);
    await expectCutoverState(s, run.cutoverBackup ?? "");
  });

  it("rolls an accepted major hop back to the release before it while it holds its pin, also after a later verified deploy, which then reads rolled back", async () => {
    const s = await scenario();
    const first = await deployUntil(s, "retire");
    await acceptRun(s, first.runId);
    const second = await deployUntil(s, "retire");
    expect((await runOf(s, second.runId)).state).toBe("verified");
    const { ctx, run } = await continueRun(s, first.runId, "update rollback", { answers: { "unsealed-stop": "accept", "rollback-accepted": "prod" } });
    const outcome = await rollbackCommand(ctx, run);
    expect(outcome.exitCode, outcome.message).toBe(UPDATE_EXIT.done);
    expect(s.h.target.release.runtime).toBe("5.8.1");
    expect((await runOf(s, second.runId)).state).toBe("rolled-back");
  });

  it("refuses to roll back a run a later verified deploy superseded once the run holds no pin, and names the later run", async () => {
    const s = await scenario();
    const first = await deployUntil(s, "retire");
    await acceptRun(s, first.runId);
    const unpinned = await runOf(s, first.runId);
    const { ctx: releasing } = await continueRun(s, first.runId, "update cleanup");
    const { releaseUpdatePin } = await import("./cleanup.ts");
    await releaseUpdatePin(releasing, unpinned.cutoverBackup ?? "", first.runId);
    const second = await deployUntil(s, "retire");
    const { ctx, run } = await continueRun(s, first.runId, "update rollback", { answers: { "unsealed-stop": "accept", "rollback-accepted": "prod" } });
    const outcome = await rollbackCommand(ctx, run);
    expect(outcome.exitCode).toBe(UPDATE_EXIT.refused);
    expect(outcome.message).toContain(second.runId);
    expect(s.h.target.release.runtime).toBe("6.0.0");
  });
});
