import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { noteRead, observeReads, unobserved, type ObservedRead } from "./reads.ts";

const doc = (id: string): ObservedRead => ({ kind: "document", type: "speakers", id });

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("reads: observeReads", () => {
  it("collects the reads noted while the function runs, across awaits", async () => {
    const { result, reads } = await observeReads(async () => {
      noteRead(doc("a"));
      await tick();
      noteRead({ kind: "type", type: "settings" });
      return 7;
    });
    expect(result).toEqual({ status: "fulfilled", value: 7 });
    expect(reads).toEqual([doc("a"), { kind: "type", type: "settings" }]);
  });

  it("keeps the reads made before a rejection", async () => {
    const { result, reads } = await observeReads(async () => {
      noteRead(doc("a"));
      await tick();
      throw new Error("render failed");
    });
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" ? String(result.reason) : "").toContain("render failed");
    expect(reads).toEqual([doc("a")]);
  });

  it("keeps the reads made before a synchronous throw", async () => {
    const { result, reads } = await observeReads(() => {
      noteRead(doc("a"));
      throw new Error("sync");
    });
    expect(result.status).toBe("rejected");
    expect(reads).toEqual([doc("a")]);
  });

  it("is sealed once the function settles: work it left running changes nothing", async () => {
    let late: Promise<void> = Promise.resolve();
    const { reads } = await observeReads(async () => {
      noteRead(doc("a"));
      late = (async () => {
        await tick(5);
        noteRead(doc("late"));
      })();
    });
    await late;
    expect(reads).toEqual([doc("a")]);
  });

  it("a nested scope collects its own reads only", async () => {
    let inner: ObservedRead[] = [];
    const { reads } = await observeReads(async () => {
      noteRead(doc("outer"));
      inner = (await observeReads(async () => noteRead(doc("inner")))).reads;
      noteRead(doc("outer-2"));
    });
    expect(inner).toEqual([doc("inner")]);
    expect(reads).toEqual([doc("outer"), doc("outer-2")]);
  });

  it("noteRead outside any scope is a no-op", () => {
    expect(() => noteRead(doc("nowhere"))).not.toThrow();
  });

  it("unobserved hides the reads of its function from the enclosing scope", async () => {
    const { reads } = await observeReads(async () => {
      noteRead(doc("seen"));
      const value = await unobserved(async () => {
        noteRead(doc("hidden"));
        await tick();
        noteRead(doc("hidden-2"));
        return 3;
      });
      expect(value).toBe(3);
      noteRead(doc("seen-2"));
    });
    expect(reads).toEqual([doc("seen"), doc("seen-2")]);
  });

  it("isolates concurrent scopes: two renders and an unobserved live request in flight together", async () => {
    const liveRequest = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) {
        noteRead(doc(`live-${i}`));
        await tick(1);
      }
    };
    const render = (name: string) => async (): Promise<void> => {
      for (let i = 0; i < 5; i++) {
        noteRead(doc(`${name}-${i}`));
        await tick(1);
      }
    };
    const [first, second] = await Promise.all([observeReads(render("one")), observeReads(render("two")), liveRequest()]);
    expect(first.reads.map((r) => (r.kind === "document" ? r.id : ""))).toEqual(["one-0", "one-1", "one-2", "one-3", "one-4"]);
    expect(second.reads.map((r) => (r.kind === "document" ? r.id : ""))).toEqual(["two-0", "two-1", "two-2", "two-3", "two-4"]);
  });

  it("keeps one store per process on globalThis, so a second copy of the module shares it", async () => {
    const store: unknown = Reflect.get(globalThis, Symbol.for("kestrel.reads"));
    expect(store).toBeInstanceOf(AsyncLocalStorage);
    vi.resetModules();
    const copy = await import("./reads.ts");
    const { reads } = await observeReads(async () => {
      copy.noteRead(doc("from-copy"));
    });
    expect(reads).toEqual([doc("from-copy")]);
    expect(Reflect.get(globalThis, Symbol.for("kestrel.reads"))).toBe(store);
  });
});
