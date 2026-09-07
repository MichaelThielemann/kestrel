import { z } from "zod";

const triggerSchema = z.union([
  z.object({ http: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/, "expected e.g. \"GET /pages/:id\""), pipeline: z.string().min(1) }).strict(),
  z.object({ event: z.string().min(1), pipeline: z.string().min(1) }).strict(),
  z.object({ cron: z.string().min(1), pipeline: z.string().min(1) }).strict(),
]);

export const configSchema = z
  .object({
    modules: z.array(z.object({ use: z.string().min(1), config: z.unknown().optional() }).strict()),
    triggers: z.array(triggerSchema),
    http: z
      .union([
        z.null(),
        z
          .object({
        port: z.number().int().min(0).max(65535).default(3000),
        host: z.string().default("127.0.0.1"),
        corsOrigin: z.string().min(1).optional(),
        maxBodyBytes: z.number().int().positive().default(10 * 1024 * 1024),
        trustProxy: z.boolean().default(false),
            healthPath: z.string().regex(/^\/\S*$/).nullable().default("/health"),
            inlineTypes: z.array(z.string().min(1)).default([]),
            timeouts: z
              .object({
                requestMs: z.number().int().nonnegative().default(30_000),
                headersMs: z.number().int().nonnegative().default(10_000),
                keepAliveMs: z.number().int().nonnegative().default(5_000),
              })
              .strict()
              .default({}),
          })
          .strict(),
      ])
      .default({}),
    pipelinesDir: z.string().default("./pipelines"),
    shutdownTimeoutMs: z.number().int().nonnegative().default(30_000),
  })
  .strict();

export type KestrelConfig = z.output<typeof configSchema>;
export type KestrelConfigInput = z.input<typeof configSchema>;
export type TriggerConfig = KestrelConfig["triggers"][number];

export function defineConfig(config: KestrelConfigInput): KestrelConfigInput {
  return config;
}
