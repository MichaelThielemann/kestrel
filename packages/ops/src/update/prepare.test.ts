import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { storageMigrationFailed, type ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { OpsError } from "../errors.ts";
import { LOCATION, PREFIXES } from "../harness.fixture.ts";
import { checkGate } from "./gate.ts";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { readUpdateRun } from "./journal.ts";
import { updateKeys } from "./layout.ts";
import { planHash, versionSet } from "./plan.ts";
import { prepare } from "./prepare.ts";
import type * as Storages from "./storages.ts";

const storages = vi.hoisted(() => ({ list: [] as ModuleStorage[] }));
vi.mock("./storages.ts", async (importOriginal) => ({ ...(await importOriginal<typeof Storages>()), releaseStorages: async () => storages.list }));

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  storages.list = [];
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function seeded(): Promise<{ h: UpdateHarness; mark: number }> {
  const h = createUpdateHarness();
  harnesses.push(h);
  const scope = join(h.releaseDir, "node_modules", "@michaelthielemann");
  mkdirSync(scope, { recursive: true });
  symlinkSync(resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "persistence-sqlite"), join(scope, "kestrel-persistence-sqlite"));
  await h.target.start();
  await h.target.app?.seed();
  return { h, mark: h.bucket?.writes.length ?? 0 };
}

function movingOriginals(failing: boolean): ModuleStorage {
  let moved = false;
  return {
    module: "media/default",
    version: "6.0.0",
    convertsFrom: "5.0.0",
    migrations: [
      {
        id: "media-default:key-layout",
        introducedIn: "6.0.0",
        kind: "auto",
        blobWrites: true,
        summary: "copies an original to its new key",
        detect: async () => ok({ pending: moved ? 0 : 1, sample: [] }),
        plan: async () => ok({ counts: { originals: 1 }, notes: [] }),
        apply: async (ctx) => {
          if (failing) return err(storageMigrationFailed("an original cannot be read"));
          const copied = await ctx.blobOps.copy(`${PREFIXES.media}m1/harbour.jpg`, `${PREFIXES.media}m1/original`);
          if (!copied.ok) return copied;
          moved = true;
          return ok({ counts: { originals: 1 }, notes: [] });
        },
      },
    ],
  };
}

const appWrites = (h: UpdateHarness, mark: number): string[] => (h.bucket?.writes.slice(mark) ?? []).map((w) => w.key).filter((key) => !key.startsWith(LOCATION));

describe("preparing an update", { timeout: 30_000 }, () => {
  it("writes one receipt with the version change and the plan hash, which the gate of the deploy matches", async () => {
    const { h, mark } = await seeded();
    const ctx = await h.context({ command: "update prepare" });
    const { receipt, outcome } = await prepare(ctx, { fullMedia: false });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.state).toBe("prepared");
    expect(receipt.versions.to).toEqual(versionSet(ctx.release.versions));
    expect(receipt.versions.from?.["@michaelthielemann/kestrel"]).toBe("5.8.1");
    expect(receipt.planHash).toBe(planHash(receipt.plan));
    expect(receipt.rehearsal.ok).toBe(true);
    const listed = await h.store.list(LOCATION + updateKeys.receipts("prod", receipt.planHash));
    expect(listed.map((i) => i.key)).toEqual([LOCATION + updateKeys.receipt("prod", receipt.planHash, ctx.run.id)]);
    expect(h.target.actions).toEqual(["start"]);
    expect(appWrites(h, mark)).toEqual([]);
    const deploying = await h.context();
    expect((await checkGate(deploying, receipt.plan, null)).receipt?.runId).toBe(ctx.run.id);
  });

  it("rehearses a migration that writes blobs without writing into the app's store", async () => {
    const { h, mark } = await seeded();
    storages.list = [movingOriginals(false)];
    const ctx = await h.context({ command: "update prepare" });
    const { receipt } = await prepare(ctx, { fullMedia: true });
    expect(receipt.plan.storage.map((m) => m.id)).toEqual(["media-default:key-layout"]);
    expect(receipt.rehearsal.checks.find((c) => c.name === "storage-migrations")).toMatchObject({ ok: true });
    expect(await h.store.head(`${PREFIXES.media}m1/original`)).toBeNull();
    expect(appWrites(h, mark)).toEqual([]);
    expect(h.target.actions).toEqual(["start"]);
  });

  it("writes no receipt and ends with exit 1 when the rehearsal fails", async () => {
    const { h, mark } = await seeded();
    storages.list = [movingOriginals(true)];
    const ctx = await h.context({ command: "update prepare" });
    const error = await prepare(ctx, { fullMedia: false }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(OpsError);
    expect(error instanceof OpsError ? error.exitCode : null).toBe(1);
    expect(await h.store.list(`${LOCATION}updates/prod/receipts/`)).toEqual([]);
    expect(h.target.actions).toEqual(["start"]);
    expect(appWrites(h, mark)).toEqual([]);
    const run = await readUpdateRun(ctx, ctx.run.id);
    expect(run.state).toBe("untouched");
    expect(run.records.find((r) => r.step === "rehearsal" && r.state === "failed")).toBeDefined();
  });
});
