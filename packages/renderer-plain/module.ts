import { z } from "zod";
import { RENDERER, type Renderer } from "@michaelthielemann/kestrel-contracts/renderer";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { createRendererPlain } from "./impl.ts";

export const configSchema = z.object({ titleField: z.string().min(1).default("title"), siteName: z.string().min(1).default("Kestrel") }).strict();

export default defineModule({
  name: "renderer/plain",
  provides: [RENDERER],
  requires: [],
  configSchema,

  async setup(config): Promise<Renderer> {
    return createRendererPlain(config);
  },
});
