import { describe, it, expect } from "vitest";
import type { NewRevision, Revisions } from "@michaelthielemann/kestrel-contracts/revisions";
import { revisionsContractTests } from "@michaelthielemann/kestrel-contracts/revisions.contract.test";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { createRevisionsDefault, documentOf, keptRevisions, restoreReportOf, snapshotFields, statusOf, survivingParent, withoutDropped, type RevisionsConfig } from "./impl.ts";

const AUTHOR = { id: "u1", name: "alice" };

function config(patch: Partial<RevisionsConfig> = {}): RevisionsConfig {
  return { keep: 50, maxSnapshotBytes: 1048576, pruneOnWrite: false, statusField: "status", liveStatuses: ["published"], maxLimit: 100, ...patch };
}

async function make(patch: Partial<RevisionsConfig> = {}, logger = silentLogger): Promise<Revisions> {
  return createRevisionsDefault(config(patch), { db: createFakePersistence(), logger });
}

let sequence = 0;

const entry = (patch: Partial<NewRevision> = {}): NewRevision => {
  sequence += 1;
  const fields = patch.fields ?? { title: `A${sequence}`, status: "draft" };
  return { collection: "pages", documentId: "p1", locale: "de", author: AUTHOR, kind: "save", ...patch, fields };
};

revisionsContractTests(async (options) => make({ keep: options.keep }));

describe("revisions/default", () => {
  it("prunes on write when configured, keeping the newest, the head and every tip", async () => {
    const revisions = await make({ keep: 2, pruneOnWrite: true });
    const first = expectOk(await revisions.record(entry()));
    expectOk(await revisions.record(entry()));
    const third = expectOk(await revisions.record(entry()));
    const page = expectOk(await revisions.list("pages", "p1", "de"));
    expect(page.total).toBe(2);
    expect(page.head).toBe(third.id);
    expect(page.items[0]?.parentId).toBe(page.items[1]?.id);
    expect(expectOk(await revisions.read("pages", "p1", first.id))).toBeNull();
  });

  it("records an oversized snapshot as skipped, logs it and never fails the save", async () => {
    const warnings: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
    const logger = { ...silentLogger, warn: (message: string, fields?: Record<string, unknown>) => void warnings.push({ message, fields }) };
    const revisions = await make({ maxSnapshotBytes: 32 }, logger);
    const recorded = expectOk(await revisions.record(entry({ fields: { title: "x".repeat(200), status: "draft" } })));
    expect(recorded.skipped).toBe(true);
    expect(recorded.bytes).toBeGreaterThan(32);
    expect(expectOk(await revisions.read("pages", "p1", recorded.id))?.snapshot).toBeNull();
    expect(warnings[0]?.message).toContain("maxSnapshotBytes");
    expect(warnings[0]?.fields).toMatchObject({ collection: "pages", documentId: "p1", locale: "de" });
  });

  it("does not treat a skipped head as identical to a later save with the same fields", async () => {
    const revisions = await make({ maxSnapshotBytes: 32 });
    const first = expectOk(await revisions.record(entry({ fields: { title: "x".repeat(200), status: "draft" } })));
    expect(first.skipped).toBe(true);
    const second = expectOk(await revisions.record(entry({ fields: { title: "x".repeat(200), status: "draft" } })));
    expect(second.id).not.toBe(first.id);
    expect(second.skipped).toBe(true);
    expect(expectOk(await revisions.list("pages", "p1", "de")).total).toBe(2);
  });

  it("does not treat a save that is itself oversized as identical to the head", async () => {
    const db = createFakePersistence();
    const fields = { title: "A", status: "draft" };
    const roomy = await createRevisionsDefault(config({ maxSnapshotBytes: 1048576 }), { db, logger: silentLogger });
    const first = expectOk(await roomy.record(entry({ fields })));
    const strict = await createRevisionsDefault(config({ maxSnapshotBytes: 4 }), { db, logger: silentLogger });
    const second = expectOk(await strict.record(entry({ fields })));
    expect(second.id).not.toBe(first.id);
    expect(second.skipped).toBe(true);
    expect(expectOk(await roomy.list("pages", "p1", "de")).total).toBe(2);
  });

  it("marks a revision live when its status field carries a configured live value", async () => {
    const revisions = await make({ liveStatuses: ["published", "live"] });
    expect(expectOk(await revisions.record(entry({ fields: { title: "A", status: "published" }, status: "published", live: true }))).live).toBe(true);
    expect(expectOk(await revisions.record(entry({ status: "draft" }))).live).toBe(false);
  });

  it("lets two saves that read the same head both branch off it, and the later write wins the head", async () => {
    const revisions = await make();
    const base = expectOk(await revisions.record(entry()));
    const [left, right] = await Promise.all([revisions.record(entry()), revisions.record(entry())]);
    expect(expectOk(left).parentId).toBe(base.id);
    expect(expectOk(right).parentId).toBe(base.id);
    const page = expectOk(await revisions.list("pages", "p1", "de"));
    expect(page.total).toBe(3);
    expect([expectOk(left).id, expectOk(right).id]).toContain(page.head);
  });

  it("caps a list limit at maxLimit", async () => {
    const revisions = await make({ maxLimit: 2 });
    for (let i = 0; i < 4; i += 1) expectOk(await revisions.record(entry()));
    expect(expectOk(await revisions.list("pages", "p1", "de", { limit: 100 })).items).toHaveLength(2);
  });

  it("does not read another document's or collection's revision", async () => {
    const revisions = await make();
    const recorded = expectOk(await revisions.record(entry()));
    expect(expectOk(await revisions.read("pages", "p2", recorded.id))).toBeNull();
    expect(expectOk(await revisions.read("posts", "p1", recorded.id))).toBeNull();
    expectErr(await revisions.label("posts", "p1", recorded.id, "x"), "NOT_FOUND");
  });

  it("passes a storage failure through as TRANSIENT", async () => {
    const db = createFakePersistence();
    const revisions = await createRevisionsDefault(config(), { db, logger: silentLogger });
    db.failNext("TRANSIENT");
    expectErr(await revisions.list("pages", "p1", "de"), "TRANSIENT");
  });
});

describe("retention helpers", () => {
  const row = (id: string, parentId: string | null, patch: { live?: boolean; label?: string | null } = {}) => ({ id, parentId, live: patch.live ?? false, label: patch.label ?? null });

  it("keeps the newest, live, labelled, head, tip and branch-point revisions", () => {
    const newestFirst = [row("f", "e"), row("e", "d"), row("d", "c"), row("c", "b", { label: "milestone" }), row("b", "a", { live: true }), row("a", null)];
    expect([...keptRevisions(newestFirst, 2, "f")].sort()).toEqual(["b", "c", "e", "f"]);
  });

  it("keeps a branch point with more than one child", () => {
    const newestFirst = [row("d", "a"), row("c", "b"), row("b", "a"), row("a", null)];
    expect([...keptRevisions(newestFirst, 1, "d")].sort()).toEqual(["a", "c", "d"]);
  });

  it("re-parents onto the nearest surviving ancestor", () => {
    const parents = new Map<string, string | null>([["c", "b"], ["b", "a"], ["a", null]]);
    expect(survivingParent("b", new Set(["a"]), parents)).toBe("a");
    expect(survivingParent("b", new Set<string>(), parents)).toBeNull();
  });
});

describe("snapshot helpers", () => {
  it("drops id, timestamps and the reading aids from a saved document", () => {
    expect(snapshotFields({ id: "p1", createdAt: 1, updatedAt: 2, _translations: { de: true }, _locales: {}, title: "A", body: null })).toEqual({ title: "A", body: null });
  });

  it("finds the document in a bare result and under result.document", () => {
    expect(documentOf({ id: "p1", title: "A" })).toEqual({ id: "p1", title: "A" });
    expect(documentOf({ document: { id: "p1" }, delivery: [] })).toEqual({ id: "p1" });
    expect(documentOf({ ok: true })).toBeNull();
    expect(documentOf(undefined)).toBeNull();
  });

  it("reads the configured status field and decides what counts as live", () => {
    expect(statusOf(config(), { status: "published" })).toEqual({ status: "published", live: true });
    expect(statusOf(config(), { status: "draft" })).toEqual({ status: "draft", live: false });
    expect(statusOf(config({ statusField: "state" }), { status: "published" })).toEqual({ status: null, live: false });
  });
});

describe("restore analysis", () => {
  const snapshot = { title: "A", teaser: "T", status: "draft" };

  it("names the fields the model lost and the ones it gained, sorted", () => {
    expect(restoreReportOf("r1", snapshot, ["title", "status", "author", "slug"])).toEqual({ revisionId: "r1", dropped: ["teaser"], missing: ["author", "slug"] });
  });

  it("reports nothing when the snapshot and the model agree", () => {
    expect(restoreReportOf("r1", snapshot, ["title", "teaser", "status"])).toEqual({ revisionId: "r1", dropped: [], missing: [] });
  });

  it("counts a field the snapshot holds as null as present", () => {
    expect(restoreReportOf("r1", { title: null }, ["title"]).missing).toEqual([]);
  });

  it("removes the dropped fields and keeps the rest, without touching the snapshot", () => {
    expect(withoutDropped(snapshot, ["teaser"])).toEqual({ title: "A", status: "draft" });
    expect(withoutDropped(snapshot, [])).toEqual(snapshot);
    expect(snapshot.teaser).toBe("T");
  });
});
