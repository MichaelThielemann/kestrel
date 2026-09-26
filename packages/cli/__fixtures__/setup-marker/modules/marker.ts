import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";

export default defineModule({
  name: "marker/local",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    mkdirSync("out", { recursive: true });
    writeFileSync("out/marker", "setup ran");
    const log = process.env.KESTREL_MARKER_LOG;
    if (log !== undefined) appendFileSync(log, `${process.cwd()}\n`);
    return {};
  },
});
