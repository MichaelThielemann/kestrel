import { describe, it, expect } from "vitest";
import type { MediaFile, MediaFiles, MediaFilter, MediaScan } from "./media.ts";
import { expectOk } from "./testing/result.ts";

/** How the suite stores files in the provider under test. */
export interface MediaSeed {
  /** Stores a file and makes it ready; returns its id. */
  add(file: { filename: string; contentType: string; data: Uint8Array; folder?: string }): Promise<string>;
  /** Stores a file without making it ready, as an upload in flight; omitted by a provider without such a phase. */
  pending?(file: { filename: string; contentType: string; data: Uint8Array }): Promise<string>;
  /** Begins a removal and stops before any byte is removed; omitted by a provider whose removal is one step. */
  removing?(id: string): Promise<void>;
  /** Removes a file completely. */
  remove(id: string): Promise<void>;
}

/** A provider under test, its seed, and optionally a second instance over the same store. */
export interface MediaUnderTest {
  media: MediaFiles;
  seed: MediaSeed;
  /** Opens another instance of the provider over the same store, as another process would. */
  reopen?(): Promise<MediaFiles>;
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

async function scanAll(media: MediaFiles, filter: MediaFilter, limit: number): Promise<MediaFile[]> {
  const out: MediaFile[] = [];
  let after: string | null = null;
  for (;;) {
    const page: MediaScan = expectOk(await media.scan(filter, { after, limit }));
    out.push(...page.items);
    if (page.next === null) return out;
    after = page.next;
  }
}

const idsOf = (files: readonly MediaFile[]): string[] => files.map((file) => file.id).sort();

export function mediaContractTests(make: () => Promise<MediaUnderTest>): void {
  describe("media@1", () => {
    it("describes a ready file with its canonical type, published type, size, folder, name and creation time", async () => {
      const { media, seed } = await make();
      const before = Date.now();
      const id = await seed.add({ filename: "notes.txt", contentType: "Text/Plain; Charset=UTF-8; format=flowed", data: bytes(104, 105), folder: "letters" });
      const after = Date.now();
      const file = expectOk(await media.file(id));
      expect(file).not.toBeNull();
      expect(file!.id).toBe(id);
      expect(file!.contentType).toBe("text/plain; charset=utf-8");
      expect(typeof file!.publishedType).toBe("string");
      expect(file!.publishedType.length).toBeGreaterThan(0);
      expect(file!.size).toBe(2);
      expect(file!.width).toBeNull();
      expect(file!.height).toBeNull();
      expect(["letters", ""]).toContain(file!.folder);
      expect(file!.filename.length).toBeGreaterThan(0);
      expect(file!.createdAt).toBeGreaterThanOrEqual(before - 1000);
      expect(file!.createdAt).toBeLessThanOrEqual(after + 1000);
    });

    it("answers null from file and load for an unknown id and leaves it out of files", async () => {
      const { media, seed } = await make();
      const id = await seed.add({ filename: "a.pdf", contentType: "application/pdf", data: bytes(1) });
      expect(expectOk(await media.file("unknown-id"))).toBeNull();
      expect(expectOk(await media.load("unknown-id"))).toBeNull();
      expect(idsOf(expectOk(await media.files(["unknown-id", id])))).toEqual([id]);
    });

    it("load returns the stored bytes exactly, with the same description as file", async () => {
      const { media, seed } = await make();
      const data = bytes(0, 255, 7, 13, 42);
      const id = await seed.add({ filename: "blob.pdf", contentType: "application/pdf", data });
      const loaded = expectOk(await media.load(id));
      expect(loaded).not.toBeNull();
      expect(Array.from(loaded!.data)).toEqual(Array.from(data));
      expect(loaded!.file).toEqual(expectOk(await media.file(id)));
    });

    it("keeps a file that is not ready yet out of every answer", async ({ skip }) => {
      const { media, seed } = await make();
      if (seed.pending === undefined) return skip();
      const ready = await seed.add({ filename: "ready.pdf", contentType: "application/pdf", data: bytes(1) });
      const pending = await seed.pending({ filename: "pending.pdf", contentType: "application/pdf", data: bytes(2) });
      expect(expectOk(await media.file(pending))).toBeNull();
      expect(expectOk(await media.load(pending))).toBeNull();
      expect(idsOf(expectOk(await media.files([pending, ready])))).toEqual([ready]);
      expect(idsOf(await scanAll(media, {}, 10))).toEqual([ready]);
      expect(expectOk(await media.count({}))).toBe(1);
    });

    it("keeps a file whose removal has begun out of every answer", async ({ skip }) => {
      const { media, seed } = await make();
      if (seed.removing === undefined) return skip();
      const kept = await seed.add({ filename: "kept.pdf", contentType: "application/pdf", data: bytes(1) });
      const leaving = await seed.add({ filename: "leaving.pdf", contentType: "application/pdf", data: bytes(2) });
      await seed.removing(leaving);
      expect(expectOk(await media.file(leaving))).toBeNull();
      expect(expectOk(await media.load(leaving))).toBeNull();
      expect(idsOf(expectOk(await media.files([leaving, kept])))).toEqual([kept]);
      expect(idsOf(await scanAll(media, {}, 10))).toEqual([kept]);
      expect(expectOk(await media.count({}))).toBe(1);
    });

    it("never answers for a removed id again, also after other files are stored", async () => {
      const { media, seed } = await make();
      const removed = await seed.add({ filename: "gone.pdf", contentType: "application/pdf", data: bytes(1) });
      await seed.remove(removed);
      const later = await seed.add({ filename: "gone.pdf", contentType: "application/pdf", data: bytes(1) });
      expect(later).not.toBe(removed);
      expect(expectOk(await media.file(removed))).toBeNull();
      expect(expectOk(await media.load(removed))).toBeNull();
      expect(idsOf(expectOk(await media.files([removed, later])))).toEqual([later]);
      expect(idsOf(await scanAll(media, {}, 10))).toEqual([later]);
      expect(expectOk(await media.count({}))).toBe(1);
    });

    it("answers every call from the store: a file removed after it was read is gone for the next call, on this instance and another one", async () => {
      const under = await make();
      const { media, seed } = under;
      const instances = under.reopen === undefined ? [media] : [media, await under.reopen()];
      const leaving = await seed.add({ filename: "leaving.pdf", contentType: "application/pdf", data: bytes(1) });
      const staying = await seed.add({ filename: "staying.pdf", contentType: "application/pdf", data: bytes(2) });
      for (const instance of instances) {
        expect(expectOk(await instance.file(leaving))).not.toBeNull();
        expect(expectOk(await instance.load(leaving))).not.toBeNull();
        expect(idsOf(expectOk(await instance.files([leaving, staying])))).toEqual([leaving, staying].sort());
        expect(idsOf(await scanAll(instance, {}, 10))).toEqual([leaving, staying].sort());
        expect(expectOk(await instance.count({}))).toBe(2);
      }
      await seed.remove(leaving);
      const arriving = await seed.add({ filename: "arriving.pdf", contentType: "application/pdf", data: bytes(3) });
      for (const instance of instances) {
        expect(expectOk(await instance.file(leaving))).toBeNull();
        expect(expectOk(await instance.load(leaving))).toBeNull();
        expect(idsOf(expectOk(await instance.files([leaving, staying])))).toEqual([staying]);
        expect(idsOf(await scanAll(instance, {}, 10))).toEqual([staying, arriving].sort());
        expect(expectOk(await instance.count({}))).toBe(2);
        expect(expectOk(await instance.file(arriving))).not.toBeNull();
      }
    });

    it("resumes a scan after files were added and removed between its pages, returning every file that stayed ready exactly once", async () => {
      const { media, seed } = await make();
      const ids: string[] = [];
      for (let i = 0; i < 8; i += 1) ids.push(await seed.add({ filename: `s${i}.pdf`, contentType: "application/pdf", data: bytes(i) }));
      const first = expectOk(await media.scan({}, { limit: 3 }));
      expect(first.items).toHaveLength(3);
      const returned = first.items.map((file) => file.id);
      const pending = ids.filter((id) => !returned.includes(id));
      const removed = [returned[0]!, pending[0]!];
      for (const id of removed) await seed.remove(id);
      await seed.add({ filename: "late.pdf", contentType: "application/pdf", data: bytes(9) });
      const seen = [...returned];
      let after = first.next;
      while (after !== null) {
        const page: MediaScan = expectOk(await media.scan({}, { after, limit: 3 }));
        seen.push(...page.items.map((file) => file.id));
        after = page.next;
      }
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of ids.filter((candidate) => !removed.includes(candidate))) expect(seen.filter((candidate) => candidate === id), id).toHaveLength(1);
    });

    it("files answers each ready id once, in the order of its first occurrence", async () => {
      const { media, seed } = await make();
      const a = await seed.add({ filename: "a.pdf", contentType: "application/pdf", data: bytes(1) });
      const b = await seed.add({ filename: "b.pdf", contentType: "application/pdf", data: bytes(2) });
      expect(expectOk(await media.files([b, "unknown-id", a, b, a])).map((file) => file.id)).toEqual([b, a]);
      expect(expectOk(await media.files([]))).toEqual([]);
    });

    it("files takes any number of ids", async () => {
      const { media, seed } = await make();
      const a = await seed.add({ filename: "a.pdf", contentType: "application/pdf", data: bytes(1) });
      const b = await seed.add({ filename: "b.pdf", contentType: "application/pdf", data: bytes(2) });
      const ids = [...Array.from({ length: 450 }, (_, i) => `unknown-${i}`), b, a];
      expect(expectOk(await media.files(ids)).map((file) => file.id)).toEqual([b, a]);
    });

    it("scan returns every matching file exactly once across pages, and next is null only on a short page", async () => {
      const { media, seed } = await make();
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) ids.push(await seed.add({ filename: `f${i}.pdf`, contentType: "application/pdf", data: bytes(i) }));
      const first = expectOk(await media.scan({}, { limit: 3 }));
      expect(first.items).toHaveLength(3);
      expect(first.next).not.toBeNull();
      const second = expectOk(await media.scan({}, { after: first.next, limit: 3 }));
      expect(second.items).toHaveLength(3);
      expect(second.next).not.toBeNull();
      const third = expectOk(await media.scan({}, { after: second.next, limit: 3 }));
      expect(third).toEqual({ items: [], next: null });
      expect([...first.items, ...second.items].map((file) => file.id).sort()).toEqual([...ids].sort());
      const seventh = await seed.add({ filename: "f6.pdf", contentType: "application/pdf", data: bytes(6) });
      const pages = await scanAll(media, {}, 4);
      expect(idsOf(pages)).toEqual([...ids, seventh].sort());
      expect(expectOk(await media.scan({}, { limit: 500 })).next).toBeNull();
    });

    it("resumes a scan from a cursor another instance over the same store handed out", async ({ skip }) => {
      const under = await make();
      if (under.reopen === undefined) return skip();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(await under.seed.add({ filename: `r${i}.pdf`, contentType: "application/pdf", data: bytes(i) }));
      const first = expectOk(await under.media.scan({}, { limit: 2 }));
      const other = await under.reopen();
      const rest = await (async () => {
        const out: MediaFile[] = [];
        let after = first.next;
        while (after !== null) {
          const page: MediaScan = expectOk(await other.scan({}, { after, limit: 2 }));
          out.push(...page.items);
          after = page.next;
        }
        return out;
      })();
      expect([...first.items, ...rest].map((file) => file.id).sort()).toEqual([...ids].sort());
    });

    it("throws for a scan limit outside 1 to 500", async () => {
      const { media } = await make();
      for (const limit of [0, 501, -1, 2.5, Number.NaN]) {
        await expect((async () => media.scan({}, { limit }))()).rejects.toThrow();
      }
      expectOk(await media.scan({}, { limit: 1 }));
      expectOk(await media.scan({}, { limit: 500 }));
    });

    describe("type patterns", () => {
      type Name = "png" | "jpeg" | "svg" | "fooXml" | "gif" | "pdf" | "xhtml" | "ldJson" | "text";
      const TYPES: ReadonlyArray<[Name, string]> = [
        ["png", "image/png"],
        ["jpeg", "IMAGE/JPEG"],
        ["svg", "image/svg+xml"],
        ["fooXml", "image/foo+xml"],
        ["gif", "image/gif"],
        ["pdf", "application/pdf"],
        ["xhtml", "application/xhtml+xml"],
        ["ldJson", "application/ld+json"],
        ["text", "text/plain; charset=utf-8"],
      ];
      const cases: Array<[string, MediaFilter, Name[]]> = [
        ["no filter", {}, ["png", "jpeg", "svg", "fooXml", "gif", "pdf", "xhtml", "ldJson", "text"]],
        ["*", { types: ["*"] }, ["png", "jpeg", "svg", "fooXml", "gif", "pdf", "xhtml", "ldJson", "text"]],
        ["both parts *", { types: ["*/*"] }, ["png", "jpeg", "svg", "fooXml", "gif", "pdf", "xhtml", "ldJson", "text"]],
        ["a top-level type", { types: ["image/*"] }, ["png", "jpeg", "svg", "fooXml", "gif"]],
        ["a suffix within a top-level type", { types: ["image/*+xml"] }, ["svg", "fooXml"]],
        ["a suffix across every top-level type", { types: ["*/*+xml"] }, ["svg", "fooXml", "xhtml"]],
        ["one exact type", { types: ["image/png"] }, ["png"]],
        ["an exact type in mixed case with parameters", { types: ["Image/Jpeg; q=1"] }, ["jpeg"]],
        ["an exact text type without its charset", { types: ["text/plain"] }, ["text"]],
        ["two patterns", { types: ["image/png", "application/*"] }, ["png", "pdf", "xhtml", "ldJson"]],
        ["an empty list", { types: [] }, []],
        ["exclusions alone", { excludeTypes: ["image/*", "*/*+xml"] }, ["pdf", "ldJson", "text"]],
        ["a type with exclusions", { types: ["image/*"], excludeTypes: ["image/gif", "image/*+xml"] }, ["png", "jpeg"]],
        ["a malformed pattern", { types: ["image/png, text/html"] }, []],
        ["a bare top-level type", { types: ["image"] }, []],
      ];

      async function library(): Promise<{ media: MediaFiles; byName: Map<Name, string> }> {
        const { media, seed } = await make();
        const byName = new Map<Name, string>();
        for (const [name, contentType] of TYPES) {
          byName.set(name, await seed.add({ filename: `${name}.bin`, contentType, data: bytes(name.length) }));
        }
        return { media, byName };
      }

      for (const [label, filter, expected] of cases) {
        it(`scan and count agree on ${label}`, async () => {
          const { media, byName } = await library();
          const want = expected.map((name) => byName.get(name)!).sort();
          expect(idsOf(await scanAll(media, filter, 2))).toEqual(want);
          expect(expectOk(await media.count(filter))).toBe(want.length);
        });
      }
    });

    it("createdSince keeps files created at or after that time, in scan and count alike", async () => {
      const { media, seed } = await make();
      const older = await seed.add({ filename: "older.pdf", contentType: "application/pdf", data: bytes(1) });
      const olderAt = expectOk(await media.file(older))!.createdAt;
      let newer = "";
      let newerAt = olderAt;
      for (let attempt = 0; newerAt <= olderAt && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (newer !== "") await seed.remove(newer);
        newer = await seed.add({ filename: `newer-${attempt}.pdf`, contentType: "application/pdf", data: bytes(2) });
        newerAt = expectOk(await media.file(newer))!.createdAt;
      }
      expect(newerAt).toBeGreaterThan(olderAt);
      expect(idsOf(await scanAll(media, { createdSince: newerAt }, 10))).toEqual([newer]);
      expect(expectOk(await media.count({ createdSince: newerAt }))).toBe(1);
      expect(idsOf(await scanAll(media, { createdSince: olderAt }, 10))).toEqual([older, newer].sort());
      expect(expectOk(await media.count({ createdSince: olderAt }))).toBe(2);
      expect(expectOk(await media.count({ createdSince: newerAt + 1, types: ["application/*"] }))).toBe(0);
    });
  });
}
