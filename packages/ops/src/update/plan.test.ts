import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok } from "@michaelthielemann/kestrel-contracts/errors";
import type { ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { computePlan, planHash, versionSet } from "./plan.ts";
import type { UpdatePlan } from "./types.ts";
import type * as Storages from "./storages.ts";

const storages = vi.hoisted(() => ({ list: [] as ModuleStorage[] }));
vi.mock("./storages.ts", async (importOriginal) => ({ ...(await importOriginal<typeof Storages>()), releaseStorages: async () => storages.list }));

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  storages.list = [];
  for (const h of harnesses.splice(0)) await h.dispose();
});

const harness = (...args: Parameters<typeof createUpdateHarness>): UpdateHarness => {
  const h = createUpdateHarness(...args);
  harnesses.push(h);
  return h;
};


function installPersistence(releaseDir: string): void {
  const scope = join(releaseDir, "node_modules", "@michaelthielemann");
  mkdirSync(scope, { recursive: true });
  symlinkSync(resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "persistence-sqlite"), join(scope, "kestrel-persistence-sqlite"));
}

function database(file: string, ledger: string[] = []): string {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE pages ("id" TEXT PRIMARY KEY, "title" TEXT)`);
  db.exec(`CREATE TABLE content_migrations ("id" TEXT PRIMARY KEY, "appliedAt" REAL)`);
  for (const id of ledger) db.prepare(`INSERT INTO content_migrations VALUES (?, 1)`).run(id);
  db.close();
  return file;
}

function oldForm(pending: number): ModuleStorage {
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
        summary: "moves originals to id keys",
        questions: [{ id: "media-default:key-layout:missing", text: "missing original", choices: ["skip", "stop"], default: "stop" }],
        detect: async () => ok({ pending, sample: [] }),
        plan: async () => ok({ counts: { originals: pending }, notes: [] }),
        apply: async () => ok({ counts: {}, notes: [] }),
      },
    ],
  };
}

const plan = (overrides: Partial<UpdatePlan> = {}): UpdatePlan => ({
  versions: { from: { "@michaelthielemann/kestrel": "5.8.1" }, to: { "@michaelthielemann/kestrel": "6.0.0", "@michaelthielemann/kestrel-ops": "6.0.0" } },
  storage: [{ module: "media/default", id: "media-default:key-layout", kind: "auto", blobWrites: true, pending: 3 }],
  content: ["pages-add-summary"],
  questions: [],
  ...overrides,
});

describe("the version set of an update", () => {
  it("keeps the kestrel packages only, sorted by name", () => {
    expect(Object.entries(versionSet({ zod: "4.0.0", "@michaelthielemann/kestrel-ops": "6.0.0", "@michaelthielemann/kestrel": "6.0.0", "@other/kestrel": "1.0.0" }))).toEqual([
      ["@michaelthielemann/kestrel", "6.0.0"],
      ["@michaelthielemann/kestrel-ops", "6.0.0"],
    ]);
  });
});

describe("the plan hash", () => {
  it("ignores counts, questions and the order of ids", () => {
    const base = planHash(plan());
    expect(planHash(plan({ storage: [{ module: "media/default", id: "media-default:key-layout", kind: "auto", blobWrites: true, pending: 900 }], questions: ["a"] }))).toBe(base);
    expect(planHash(plan({ content: ["b", "a"] }))).toBe(planHash(plan({ content: ["a", "b"] })));
    expect(planHash(plan({ versions: { from: null, to: { "@michaelthielemann/kestrel-ops": "6.0.0", "@michaelthielemann/kestrel": "6.0.0" } } }))).toBe(base);
  });

  it("changes with the target versions, a migration's kind or blob writes, and the content migrations", () => {
    const base = planHash(plan());
    expect(planHash(plan({ versions: { from: null, to: { "@michaelthielemann/kestrel": "6.0.1" } } }))).not.toBe(base);
    expect(planHash(plan({ storage: [{ module: "media/default", id: "media-default:key-layout", kind: "ask", blobWrites: true, pending: 3 }] }))).not.toBe(base);
    expect(planHash(plan({ storage: [{ module: "media/default", id: "media-default:key-layout", kind: "auto", blobWrites: false, pending: 3 }] }))).not.toBe(base);
    expect(planHash(plan({ content: [] }))).not.toBe(base);
  });
});

describe("planning an update on a replica copy", () => {
  it("lists the pending storage migrations with their questions, the content migrations the ledger lacks, and the version change", async () => {
    const h = harness();
    installPersistence(h.releaseDir);
    storages.list = [oldForm(3)];
    const ctx = await h.context();
    ctx.host = { ...ctx.host, ...{ contentMigrations: ["pages-add-summary", "pages-split-title"] } };
    const found = await computePlan(ctx, database(join(h.root, "copy.db"), ["pages-split-title"]));
    expect(found.storage).toEqual([{ module: "media/default", id: "media-default:key-layout", kind: "auto", blobWrites: true, pending: 3 }]);
    expect(found.questions).toEqual(["media-default:key-layout:missing"]);
    expect(found.content).toEqual(["pages-add-summary"]);
    expect(found.versions.from?.["@michaelthielemann/kestrel"]).toBe("5.8.1");
    expect(found.versions.to["@michaelthielemann/kestrel"]).toBe("6.0.0");
    expect((h.bucket?.writes ?? []).filter((w) => !w.key.startsWith("kestrel-backups/"))).toEqual([]);
  });

  it("finds nothing pending once the old form is gone", async () => {
    const h = harness();
    installPersistence(h.releaseDir);
    storages.list = [oldForm(0)];
    const found = await computePlan(await h.context(), database(join(h.root, "copy.db")));
    expect(found.storage).toEqual([]);
    expect(found.content).toEqual([]);
  });
});
