import { describe, expect, it } from "vitest";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content } from "@michaelthielemann/kestrel-contracts/content";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { noteRead, observeReads } from "@michaelthielemann/kestrel/reads";
import { ok } from "@michaelthielemann/kestrel/result";
import { createRedirects } from "./impl.ts";

const quiet: Logger = { step() {}, info() {}, error() {} };

describe("redirects/default in a read scope", () => {
  it("lookup is a routing check, not page content: the settings read it makes is not noted", async () => {
    const noting: Pick<Content, "get"> = {
      async get(type: string) {
        noteRead({ kind: "type", type });
        return ok({ id: "r", createdAt: 1, updatedAt: 1, rules: [{ from: "/alt", to: "/neu", status: 301 }] });
      },
    };
    const redirects = await createRedirects({ type: "redirects", field: "rules", prefix: "site/", key: "redirects.json" }, { content: boundaryCast<Content>(noting, "host"), blobs: boundaryCast<Blobstore>({}, "host"), db: createFakePersistence(), logger: quiet });
    const { reads } = await observeReads(async () => {
      expect(expectOk(await redirects.lookup("/alt"))).toEqual({ to: "/neu", status: 301 });
    });
    expect(reads).toEqual([]);
  });
});
