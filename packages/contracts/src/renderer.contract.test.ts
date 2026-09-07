import { describe, it, expect, beforeEach } from "vitest";
import type { Renderer } from "./renderer.ts";
import { expectOk } from "./testing/result.ts";

export function rendererContractTests(make: () => Promise<Renderer>) {
  describe("renderer@1", () => {
    let renderer: Renderer;
    beforeEach(async () => {
      renderer = await make();
    });
    const input = { type: "pages", id: "p1", locale: "de", path: "/kontakt", document: { id: "p1", title: "Kontakt" } };

    it("declares at least one format", () => {
      expect(renderer.formats().length).toBeGreaterThan(0);
    });

    it("renders every declared format with data, content type and extension", async () => {
      for (const format of renderer.formats()) {
        const out = expectOk(await renderer.render({ ...input, format }));
        expect(out.contentType).toMatch(/^[a-z]+\/[-+.\w]+/);
        expect(out.extension).toMatch(/^[a-z0-9]+$/);
        expect(typeof out.data === "string" ? out.data.length : out.data.byteLength).toBeGreaterThan(0);
        for (const asset of out.assets ?? []) expect(asset.path).toMatch(/^\/?[^\s]+$/);
      }
    });

    it("rejects unknown formats", async () => {
      await expect(renderer.render({ ...input, format: "no-such-format" })).rejects.toThrow();
    });
  });
}
