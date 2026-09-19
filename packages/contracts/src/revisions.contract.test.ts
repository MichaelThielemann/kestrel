import { describe, it, expect, beforeEach } from "vitest";
import type { NewRevision, Revisions, RevisionSummary } from "./revisions.ts";
import { expectErr, expectOk } from "./testing/result.ts";

const AUTHOR = { id: "u1", name: "alice" };

export function revisionsContractTests(make: (options: { keep: number }) => Promise<Revisions>) {
  describe("revisions@1", () => {
    let revisions: Revisions;

    let sequence = 0;

    const entry = (patch: Partial<NewRevision> = {}): NewRevision => ({
      collection: "pages",
      documentId: "p1",
      locale: "de",
      fields: { title: "A", status: "draft" },
      author: AUTHOR,
      kind: "save",
      ...patch,
    });

    const record = async (patch: Partial<NewRevision> = {}): Promise<RevisionSummary> => {
      sequence += 1;
      const withFields = patch.fields === undefined ? { ...patch, fields: { title: `A${sequence}`, status: "draft" } } : patch;
      return expectOk(await revisions.record(entry(withFields)));
    };
    const ids = async (documentId = "p1", locale = "de"): Promise<string[]> => expectOk(await revisions.list("pages", documentId, locale)).items.map((r) => r.id);

    beforeEach(async () => {
      revisions = await make({ keep: 2 });
    });

    it("appends a revision, makes it the head and keeps the author, kind and status", async () => {
      const first = await record({ status: "draft" });
      expect(first).toMatchObject({ collection: "pages", documentId: "p1", locale: "de", parentId: null, kind: "save", label: null, status: "draft", live: false, skipped: false });
      expect(first.author).toEqual(AUTHOR);
      expect(first.createdAt).toBeGreaterThan(0);
      expect(expectOk(await revisions.head("pages", "p1", "de"))).toBe(first.id);
    });

    it("keeps an anonymous author as { id: null, name: null }", async () => {
      const anonymous = await record({ author: { id: null, name: null } });
      expect(anonymous.author).toEqual({ id: null, name: null });
      expect(expectOk(await revisions.read("pages", "p1", anonymous.id))?.author).toEqual({ id: null, name: null });
      expect(expectOk(await revisions.list("pages", "p1", "de")).items[0]?.author).toEqual({ id: null, name: null });
    });

    it("chains a linear history: every save's parent is the previous head", async () => {
      const first = await record();
      const second = await record();
      const third = await record();
      expect([second.parentId, third.parentId]).toEqual([first.id, second.id]);
      expect(await ids()).toEqual([third.id, second.id, first.id]);
      expect(expectOk(await revisions.list("pages", "p1", "de")).head).toBe(third.id);
    });

    it("forks the history when a save names an older revision as its parent", async () => {
      const first = await record();
      const second = await record();
      const branch = await record({ parentId: first.id, kind: "restore" });
      expect(branch.parentId).toBe(first.id);
      expect(branch.kind).toBe("restore");
      expect(expectOk(await revisions.head("pages", "p1", "de"))).toBe(branch.id);
      const next = await record();
      expect(next.parentId).toBe(branch.id);
      expect(second.parentId).toBe(first.id);
    });

    it("answers NOT_FOUND for a parent that does not exist", async () => {
      expectErr(await revisions.record(entry({ parentId: "nope" })), "NOT_FOUND");
    });

    it("refuses a parent from another document, locale or collection", async () => {
      const mine = await record();
      const otherDocument = await record({ documentId: "p2" });
      const otherLocale = await record({ locale: "en" });
      const otherCollection = await record({ collection: "posts" });
      expectErr(await revisions.record(entry({ parentId: otherDocument.id })), "NOT_FOUND");
      expectErr(await revisions.record(entry({ parentId: otherLocale.id })), "NOT_FOUND");
      expectErr(await revisions.record(entry({ parentId: otherCollection.id })), "NOT_FOUND");
      expect(await ids()).toEqual([mine.id]);
    });

    it("does not read or label a revision of another document or collection", async () => {
      const mine = await record();
      expect(expectOk(await revisions.read("pages", "p2", mine.id))).toBeNull();
      expect(expectOk(await revisions.read("posts", "p1", mine.id))).toBeNull();
      expectErr(await revisions.label("pages", "p2", mine.id, "x"), "NOT_FOUND");
      expectErr(await revisions.label("posts", "p1", mine.id, "x"), "NOT_FOUND");
      expect(expectOk(await revisions.read("pages", "p1", mine.id))?.label).toBeNull();
    });

    it("lists newest first without snapshots, paged", async () => {
      const first = await record();
      const second = await record();
      const third = await record();
      const page = expectOk(await revisions.list("pages", "p1", "de", { limit: 2 }));
      expect(page.total).toBe(3);
      expect(page.items.map((r) => r.id)).toEqual([third.id, second.id]);
      expect(page.items.every((r) => !("snapshot" in r))).toBe(true);
      expect(expectOk(await revisions.list("pages", "p1", "de", { limit: 2, offset: 2 })).items.map((r) => r.id)).toEqual([first.id]);
    });

    it("reads one revision with its snapshot and answers Ok(null) for an unknown id", async () => {
      const first = await record({ fields: { title: "A", status: "published" } });
      const read = expectOk(await revisions.read("pages", "p1", first.id));
      expect(read).toMatchObject({ id: first.id, parentId: null });
      expect(read?.snapshot).toEqual({ title: "A", status: "published" });
      expect(expectOk(await revisions.read("pages", "p1", "nope"))).toBeNull();
    });

    it("sets and clears a label, and answers NOT_FOUND for an unknown revision", async () => {
      const first = await record();
      expect(expectOk(await revisions.label("pages", "p1", first.id, "before the relaunch")).label).toBe("before the relaunch");
      expect(expectOk(await revisions.read("pages", "p1", first.id))?.label).toBe("before the relaunch");
      expect(expectOk(await revisions.label("pages", "p1", first.id, null)).label).toBeNull();
      expectErr(await revisions.label("pages", "p1", "nope", "x"), "NOT_FOUND");
    });

    it("keeps one history per locale", async () => {
      const de = await record();
      const en = await record({ locale: "en" });
      expect(en.parentId).toBeNull();
      expect(await ids("p1", "de")).toEqual([de.id]);
      expect(await ids("p1", "en")).toEqual([en.id]);
      expect(expectOk(await revisions.head("pages", "p1", "en"))).toBe(en.id);
    });

    it("removes a document's revisions, or only one locale's", async () => {
      await record();
      await record();
      await record({ locale: "en" });
      expect(expectOk(await revisions.remove("pages", "p1", "en"))).toBe(1);
      expect(await ids("p1", "en")).toEqual([]);
      expect(expectOk(await revisions.head("pages", "p1", "en"))).toBeNull();
      expect(expectOk(await revisions.remove("pages", "p1"))).toBe(2);
      expect(await ids()).toEqual([]);
      expect(expectOk(await revisions.head("pages", "p1", "de"))).toBeNull();
    });

    it("prunes down to the newest ones but keeps live, labelled and tip revisions and re-parents the survivors", async () => {
      const first = await record();
      const second = await record({ live: true, status: "published" });
      const third = await record();
      const fourth = await record();
      const fifth = await record();
      const sixth = await record();
      expectOk(await revisions.label("pages", "p1", third.id, "milestone"));

      const report = expectOk(await revisions.prune());
      expect(report.inspected).toBe(6);
      expect(report.removed).toBe(2);
      expect(await ids()).toEqual([sixth.id, fifth.id, third.id, second.id]);

      const survivors = expectOk(await revisions.list("pages", "p1", "de")).items;
      expect(survivors.find((r) => r.id === second.id)?.parentId).toBeNull();
      expect(survivors.find((r) => r.id === fifth.id)?.parentId).toBe(third.id);
      expect(expectOk(await revisions.read("pages", "p1", first.id))).toBeNull();
      expect(expectOk(await revisions.read("pages", "p1", fourth.id))).toBeNull();
    });

    it("keeps a branch point and every branch tip", async () => {
      const root = await record();
      await record();
      const tip = await record();
      const branch = await record({ parentId: root.id, kind: "restore" });
      const branchTip = await record();

      expectOk(await revisions.prune());
      const survivors = expectOk(await revisions.list("pages", "p1", "de")).items;
      expect(survivors.map((r) => r.id).sort()).toEqual([root.id, tip.id, branch.id, branchTip.id].sort());
      expect(survivors.find((r) => r.id === tip.id)?.parentId).toBe(root.id);
    });

    it("does not record a save identical to the head and returns the head instead", async () => {
      const first = await record({ fields: { title: "A", status: "draft" }, status: "draft" });
      const second = await record({ fields: { title: "A", status: "draft" }, status: "draft" });
      expect(second).toEqual(first);
      expect(await ids()).toEqual([first.id]);
      expect(expectOk(await revisions.head("pages", "p1", "de"))).toBe(first.id);
    });

    it("does not record an identical save regardless of field key order", async () => {
      const first = await record({ fields: { title: "A", status: "draft" }, status: "draft" });
      const second = await record({ fields: { status: "draft", title: "A" }, status: "draft" });
      expect(second).toEqual(first);
      expect(await ids()).toEqual([first.id]);
    });

    it("records a save that changes a field even when the status is unchanged", async () => {
      const first = await record({ fields: { title: "A", status: "draft" }, status: "draft" });
      const second = await record({ fields: { title: "B", status: "draft" }, status: "draft" });
      expect(second.id).not.toBe(first.id);
      expect(await ids()).toEqual([second.id, first.id]);
    });

    it("records a save that changes only the status", async () => {
      const first = await record({ fields: { title: "A", status: "draft" }, status: "draft" });
      const second = await record({ fields: { title: "A", status: "draft" }, status: "published" });
      expect(second.id).not.toBe(first.id);
      expect(await ids()).toEqual([second.id, first.id]);
    });

    it("always records a restore, even identical to the head", async () => {
      const first = await record({ fields: { title: "A", status: "draft" }, status: "draft" });
      const restore = await record({ fields: { title: "A", status: "draft" }, status: "draft", kind: "restore" });
      expect(restore.id).not.toBe(first.id);
      expect(restore.kind).toBe("restore");
      expect(await ids()).toEqual([restore.id, first.id]);
    });

    it("always records a save whose parent is not the head, even identical to that parent", async () => {
      const first = await record({ fields: { title: "A", status: "draft" }, status: "draft" });
      const second = await record({ fields: { title: "B", status: "draft" }, status: "draft" });
      const afterRestore = await record({ fields: { title: "A", status: "draft" }, status: "draft", parentId: first.id, kind: "save" });
      expect(afterRestore.id).not.toBe(first.id);
      expect(afterRestore.parentId).toBe(first.id);
      expect(await ids()).toEqual([afterRestore.id, second.id, first.id]);
    });

    it("prunes only the named scope", async () => {
      for (let i = 0; i < 4; i += 1) await record();
      for (let i = 0; i < 4; i += 1) await record({ documentId: "p2" });
      expect(expectOk(await revisions.prune({ collection: "pages", documentId: "p2" })).inspected).toBe(4);
      expect(await ids("p1")).toHaveLength(4);
      expect(await ids("p2")).toHaveLength(2);
    });
  });
}
