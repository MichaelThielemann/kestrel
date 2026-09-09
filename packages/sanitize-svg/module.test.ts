import { describe, it, expect } from "vitest";
import type { Context } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module, { configSchema } from "./module.ts";

async function makeInstance(overrides: { maxBytes?: number } = {}) {
  const config = configSchema.parse(overrides);
  return module.setup(config, {
    get: () => {
      throw new Error("no contract expected");
    },
    find: () => undefined,
    logger: silentLogger,
    root: process.cwd(),
  });
}

function pipeline(...steps: string[]) {
  return definePipeline({ name: "test", steps });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const probeFiles = {
  "probe.files": async (ctx: Context) => ok({ ...ctx, result: ctx.files.map((f) => ({ filename: f.filename, contentType: f.contentType, text: decoder.decode(f.data) })) }),
};

describe("sanitize/svg step via runPipeline", () => {
  it("sanitizes an svg file in place and leaves non-svg files untouched", async () => {
    const instance = await makeInstance();
    const dirty = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>');
    const other = encoder.encode("not an svg");

    const res = await runPipeline(
      pipeline("sanitize.svg", "probe.files"),
      { files: [{ field: "file", filename: "a.svg", contentType: "image/svg+xml", data: dirty }, { field: "file", filename: "b.png", contentType: "image/png", data: other }] },
      { modules: [{ module, instance }], steps: probeFiles },
    );

    expect(res.status).toBe(200);
    const files = res.result as Array<{ filename: string; contentType: string; text: string }>;
    expect(files[0]?.contentType).toBe("image/svg+xml");
    expect(files[0]?.text).not.toContain("<script");
    expect(files[1]?.text).toBe("not an svg");
  });

  it("rejects an oversized svg with PAYLOAD_TOO_LARGE", async () => {
    const instance = await makeInstance({ maxBytes: 2 });
    const dirty = encoder.encode("<svg><rect/></svg>");

    const res = await runPipeline(pipeline("sanitize.svg"), { files: [{ field: "file", filename: "a.svg", contentType: "image/svg+xml", data: dirty }] }, { modules: [{ module, instance }] });

    expect(res.status).toBe(413);
    expect(res.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a file without an svg root as VALIDATION", async () => {
    const instance = await makeInstance();
    const notSvg = encoder.encode("<div>hi</div>");

    const res = await runPipeline(pipeline("sanitize.svg"), { files: [{ field: "file", filename: "a.svg", contentType: "image/svg+xml", data: notSvg }] }, { modules: [{ module, instance }] });

    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
  });
});
