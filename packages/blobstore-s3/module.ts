import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { logWarn } from "@michaelthielemann/kestrel/logger";
import { createBlobstoreS3, DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type BlobstoreS3 } from "./impl.ts";

/** Whether `endpoint` is a plain `http:` URL whose host is not a loopback address. */
export function isInsecureEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint);
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !(host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host));
}

export const configSchema = z
  .object({
    bucket: z.string().min(1),
    prefix: z.string().default(""),
    region: z.string().min(1).optional(),
    endpoint: z.string().url().optional(),
    allowInsecureEndpoint: z.boolean().default(false),
    forcePathStyle: z.boolean().optional(),
    accessKeyId: z.string().min(1).describe("secret").optional(),
    secretAccessKey: z.string().min(1).describe("secret").optional(),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    maxAttempts: z.number().int().min(1).default(DEFAULT_MAX_ATTEMPTS),
    requestChecksumCalculation: z.enum(["WHEN_SUPPORTED", "WHEN_REQUIRED"]).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.endpoint !== undefined && !config.allowInsecureEndpoint && isInsecureEndpoint(config.endpoint)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpoint"],
        message: "a plain http endpoint outside loopback sends credentials and objects unencrypted; use https, or set allowInsecureEndpoint: true for a network you trust",
      });
    }
  });

export default defineModule({
  name: "blobstore/s3",
  provides: [BLOBSTORE],
  requires: [],
  configSchema,

  async setup(config, deps): Promise<BlobstoreS3> {
    const { allowInsecureEndpoint, ...clientConfig } = config;
    if (allowInsecureEndpoint && clientConfig.endpoint !== undefined && isInsecureEndpoint(clientConfig.endpoint)) {
      logWarn(deps.logger, "blobstore/s3: the endpoint is plain http outside loopback, so credentials and objects travel unencrypted", { endpoint: clientConfig.endpoint });
    }
    return createBlobstoreS3(clientConfig);
  },

  teardown: (blobstore) => blobstore.close(),
});
