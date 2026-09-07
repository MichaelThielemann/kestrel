import { describe, it, expect } from "vitest";
import { rendererContractTests } from "@michaelthielemann/kestrel-contracts/renderer.contract.test";
import { createRendererPlain, renderHtml } from "./impl.ts";

const config = { titleField: "title", siteName: "Demo" };
rendererContractTests(async () => createRendererPlain(config));

describe("renderer/plain", () => {
  it("escapes content", () => {
    const html = renderHtml(config, { type: "pages", id: "1", locale: "de", path: "/x", format: "html", document: { title: "<script>alert(1)</script>" } });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('<html lang="de">');
  });
});
