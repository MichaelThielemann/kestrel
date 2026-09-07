import { z } from "zod";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { createBlobstoreFilesystem } from "./impl.ts";

export const configSchema = z.object({ root: z.string().min(1) }).strict();

export default defineModule({
  name: "blobstore/filesystem",
  provides: [BLOBSTORE],
  requires: [],
  configSchema,

  async setup(config): Promise<Blobstore> {
    return createBlobstoreFilesystem(config);
  },
});
