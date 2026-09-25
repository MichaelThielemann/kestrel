import { describe, it, expect } from "vitest";
import { mediaContractTests } from "../media.contract.test.ts";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createFakeMedia } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";

mediaContractTests(async () => {
  const media = createFakeMedia();
  return {
    media,
    seed: {
      async add(file) {
        return media.add({ filename: file.filename, contentType: file.contentType, data: file.data, ...(file.folder === undefined ? {} : { folder: file.folder }) }).id;
      },
      async removing(id) {
        media.remove(id);
      },
      async remove(id) {
        media.remove(id);
      },
    },
  };
});

describe("fakeMedia", () => {
  it("publishes a file as publicFormOf would unless the test sets the published type", async () => {
    const media = createFakeMedia();
    const svg = media.add({ contentType: "image/svg+xml", data: new Uint8Array([1]) });
    const png = media.add({ contentType: "IMAGE/PNG", data: new Uint8Array([1]) });
    const odd = media.add({ contentType: "image/png", data: new Uint8Array([1]), publishedType: "image/x-odd" });
    expect(svg.publishedType).toBe("application/octet-stream");
    expect(png).toMatchObject({ contentType: "image/png", publishedType: "image/png" });
    expect(expectOk(await media.file(odd.id))?.publishedType).toBe("image/x-odd");
  });

  it("refuses a type that is not exactly one media type and an id used before", () => {
    const media = createFakeMedia();
    expect(() => media.add({ contentType: "image/png, text/html", data: new Uint8Array([1]) })).toThrow(/not exactly one media type/);
    media.add({ id: "a", contentType: "image/png", data: new Uint8Array([1]) });
    media.remove("a");
    expect(() => media.add({ id: "a", contentType: "image/png", data: new Uint8Array([1]) })).toThrow(/already used/);
  });

  it("keeps a file whose bytes were lost ready, and load answers null for it", async () => {
    const media = createFakeMedia();
    const file = media.add({ id: "a", contentType: "image/png", data: new Uint8Array([1]) });
    media.loseBytes("a");
    expect(expectOk(await media.file("a"))).toEqual(file);
    expect(expectOk(await media.load("a"))).toBeNull();
    expect(expectOk(await media.count({}))).toBe(1);
  });

  it("records every call in order and runs beforeCall before it answers", async () => {
    const seen: string[] = [];
    const media = createFakeMedia({
      beforeCall: async (method, args) => {
        seen.push(method);
        if (method === "load" && args[0] === "a") media.remove("a");
      },
    });
    media.add({ id: "a", contentType: "image/png", data: new Uint8Array([1]) });
    expect(expectOk(await media.file("a"))).not.toBeNull();
    expect(expectOk(await media.load("a"))).toBeNull();
    expectOk(await media.scan({ types: ["image/*"] }, { limit: 5 }));
    expect(seen).toEqual(["file", "load", "scan"]);
    expect(media.calls).toEqual([
      { method: "file", args: ["a"] },
      { method: "load", args: ["a"] },
      { method: "scan", args: [{ types: ["image/*"] }, { limit: 5 }] },
    ]);
  });

  it("takes its creation times from the clock it was given", async () => {
    let at = 100;
    const media = createFakeMedia({ now: () => at });
    const first = media.add({ contentType: "image/png", data: new Uint8Array([1]) });
    at = 200;
    const second = media.add({ contentType: "image/png", data: new Uint8Array([1]), createdAt: 50 });
    expect([first.createdAt, second.createdAt]).toEqual([100, 50]);
    expect(expectOk(await media.count({ createdSince: 60 }))).toBe(1);
  });
});
