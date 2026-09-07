import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { createBlobstoreS3, DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type BlobstoreS3 } from "./impl.ts";

export const configSchema = z
  .object({
    bucket: z.string().min(1),
    prefix: z.string().default(""),
    region: z.string().min(1).optional(),
    endpoint: z.string().url().optional(),
    forcePathStyle: z.boolean().optional(),
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    maxAttempts: z.number().int().min(1).default(DEFAULT_MAX_ATTEMPTS),
  })
  .strict();

export default defineModule({
  name: "blobstore/s3",
  provides: [BLOBSTORE],
  requires: [],
  configSchema,

  async setup(config): Promise<BlobstoreS3> {
    return createBlobstoreS3(config);
  },

  teardown: (blobstore) => blobstore.close(),
});
