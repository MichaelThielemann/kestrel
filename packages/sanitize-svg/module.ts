import { z } from "zod";
import type { Context, UploadedFile } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { ok } from "@michaelthielemann/kestrel/result";
import { isSvg, sanitizeSvg } from "./impl.ts";

export const configSchema = z
  .object({
    maxBytes: z.number().int().positive().default(2 * 1024 * 1024),
  })
  .strict();

export default defineModule({
  name: "sanitize/svg",
  provides: [],
  requires: [],
  configSchema,

  async setup(config) {
    return config;
  },

  steps: (config) => ({
    svg: async (ctx: Context) => {
      const files: UploadedFile[] = [];
      for (const file of ctx.files) {
        if (!isSvg(file.contentType)) {
          files.push(file);
          continue;
        }
        if (file.data.byteLength > config.maxBytes) return ctx.fail("PAYLOAD_TOO_LARGE", `svg exceeds ${config.maxBytes} bytes`);
        let sanitized: string;
        try {
          sanitized = sanitizeSvg(new TextDecoder("utf-8").decode(file.data));
        } catch (err) {
          return ctx.fail("VALIDATION", `invalid svg: ${err instanceof Error ? err.message : String(err)}`);
        }
        files.push({ ...file, data: new TextEncoder().encode(sanitized), contentType: "image/svg+xml" });
      }
      return ok({ ...ctx, files });
    },
  }),

  describe: () => ({
    svg: {
      summary: "Sanitize uploaded SVG files (scripts, handlers, external references removed)",
      reads: ["files"],
      writes: ["files"],
      errors: { 413: "svg too large", 400: "invalid svg" },
    },
  }),
});
