import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isErr } from "@michaelthielemann/kestrel/result";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { blobstoreStandIn, providesBlobstore } from "./blobstoreStandIn.ts";

const FAKE_DEPS = boundaryCast<Deps>({}, "host");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-blobstore-standin-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("blobstoreStandIn", () => {
  it("provides blobstore@1 under the given name", () => {
    const mod = blobstoreStandIn("blobstore/s3", dir);
    expect(mod.name).toBe("blobstore/s3");
    expect(mod.provides).toEqual([BLOBSTORE]);
    expect(mod.requires).toEqual([]);
  });

  it("accepts any config, since the real module's own config never applies here", () => {
    const mod = blobstoreStandIn("blobstore/s3", dir);
    expect(mod.configSchema.safeParse({ bucket: "prod", region: "eu-west-1", accessKeyId: "x" }).success).toBe(true);
    expect(mod.configSchema.safeParse(undefined).success).toBe(true);
  });

  it("put/get/list/remove/move round-trip against the scratch directory", async () => {
    const mod = blobstoreStandIn("blobstore/s3", dir);
    const blobstore = boundaryCast<Blobstore>(await mod.setup({}, FAKE_DEPS), "host");

    const putResult = await blobstore.put("media/a.png", new Uint8Array([1, 2, 3]));
    expect(isErr(putResult)).toBe(false);

    const getResult = await blobstore.get("media/a.png");
    expect(isErr(getResult)).toBe(false);
    expect(!isErr(getResult) && Array.from(getResult.value ?? [])).toEqual([1, 2, 3]);

    const listResult = await blobstore.list("media/");
    expect(!isErr(listResult) && listResult.value.map((i) => i.key)).toEqual(["media/a.png"]);

    const moveResult = await blobstore.move("media/a.png", "media/b.png");
    expect(isErr(moveResult)).toBe(false);
    const afterMove = await blobstore.get("media/a.png");
    expect(!isErr(afterMove) && afterMove.value).toBeNull();

    const removeResult = await blobstore.remove("media/b.png");
    expect(isErr(removeResult)).toBe(false);
    const afterRemove = await blobstore.get("media/b.png");
    expect(!isErr(afterRemove) && afterRemove.value).toBeNull();
  });

  it("writes under the scratch directory, never the project's own storage", async () => {
    const mod = blobstoreStandIn("blobstore/s3", dir);
    const store = boundaryCast<Blobstore>(await mod.setup({}, FAKE_DEPS), "host");
    await store.put("x.bin", new Uint8Array([9]));
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(dir, "sandbox", "blobstore-standin"));
    expect(entries).toContain("x.bin");
  });
});

describe("providesBlobstore", () => {
  it("is true for a module providing blobstore@1", () => {
    expect(providesBlobstore(blobstoreStandIn("blobstore/s3", dir))).toBe(true);
  });

  it("is false for a module providing something else", () => {
    expect(providesBlobstore({ name: "persistence/sqlite", provides: [], requires: [], configSchema: blobstoreStandIn("x", dir).configSchema, async setup() { return {}; } })).toBe(false);
  });
});
