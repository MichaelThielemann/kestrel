// @ts-expect-error -- 5.8-only code: rewriteMedia is removed from kestrel-delivery-static/impl in 6.0.0
import { rewriteMedia } from "@michaelthielemann/kestrel-delivery-static/impl";
import { z } from "zod";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";

export default defineModule({
  name: "custom/media-links",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
});

export function linkFor(html: string): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return rewriteMedia(html);
}
