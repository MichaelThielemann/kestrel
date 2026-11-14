import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { OpsError } from "./errors.ts";
import { isEnvName } from "./layout.ts";

/** The file, in the project root, that describes each environment the tool works on. It holds no secret values. */
export const ENVIRONMENTS_FILE = "kestrel.environments.json";

const credential = z.union([z.object({ env: z.string().min(1) }).strict(), z.object({ command: z.array(z.string().min(1)).min(1) }).strict()]);

const storage = z
  .object({
    bucket: z.string().min(1),
    prefix: z.string().default(""),
    region: z.string().optional(),
    endpoint: z.string().optional(),
    forcePathStyle: z.boolean().optional(),
    requestChecksumCalculation: z.enum(["WHEN_SUPPORTED", "WHEN_REQUIRED"]).optional(),
    credentials: z.object({ accessKeyId: credential, secretAccessKey: credential }).strict().optional(),
  })
  .strict();

const prefix = z.string().min(1).refine((p) => p.endsWith("/"), "must end with /");

const environment = z
  .object({
    production: z.boolean().default(true),
    target: z.object({ adapter: z.string().min(1) }).catchall(z.unknown()),
    storage,
    app: z
      .object({
        replicaPrefix: prefix,
        mediaPrefix: prefix,
        deliveryPrefix: prefix,
        derivedPrefixes: z.array(prefix).default([]),
        media: z.object({ collection: z.string().default("media_items"), keyField: z.string().default("key"), checksumField: z.string().default("checksum") }).strict().default({ collection: "media_items", keyField: "key", checksumField: "checksum" }),
        credentials: z.object({ accessKeyId: credential, secretAccessKey: credential }).strict().optional(),
      })
      .strict(),
    backups: z
      .object({
        storage: storage.optional(),
        prefix,
        retention: z.object({ cutover: z.number().int().min(1).default(5), scheduled: z.number().int().min(1).default(14), manual: z.number().int().min(1).default(10), "pre-restore": z.number().int().min(1).default(5) }).strict().default({ cutover: 5, scheduled: 14, manual: 10, "pre-restore": 5 }),
      })
      .strict(),
  })
  .strict();

const file = z.object({ $schema: z.string().optional(), environments: z.record(z.string(), environment) }).strict();

/** One environment of `kestrel.environments.json`, defaults applied. */
export type Environment = z.infer<typeof environment>;
/** The storage block of an environment. */
export type StorageConfig = z.infer<typeof storage>;
/** A credential source as the file states it. */
export type CredentialConfig = z.infer<typeof credential>;

/** Reads and validates `kestrel.environments.json` in `root`; a missing or invalid file is a configuration error (exit 2). */
export function loadEnvironments(root: string): Record<string, Environment> {
  const path = join(root, ENVIRONMENTS_FILE);
  if (!existsSync(path)) throw new OpsError(`${ENVIRONMENTS_FILE} not found in ${root}; see the kestrel-ops README for its format`, 2, ENVIRONMENTS_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new OpsError(`${ENVIRONMENTS_FILE} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, 2, ENVIRONMENTS_FILE);
  }
  const parsed = file.safeParse(raw);
  if (!parsed.success) throw new OpsError(`${ENVIRONMENTS_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, 2, ENVIRONMENTS_FILE);
  for (const name of Object.keys(parsed.data.environments)) if (!isEnvName(name)) throw new OpsError(`${ENVIRONMENTS_FILE}: environment name "${name}" must use lowercase letters, digits and underscores`, 2, ENVIRONMENTS_FILE);
  return parsed.data.environments;
}

/** True when two prefixes overlap: one contains the other. */
export function overlaps(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/** Problems with an environment that the schema cannot see: a backup location inside an app prefix, or app prefixes (derived ones included) inside each other. */
export function environmentProblems(env: Environment): string[] {
  const problems: string[] = [];
  const backupStorage = env.backups.storage ?? env.storage;
  const sameBucket = backupStorage.bucket === env.storage.bucket && backupStorage.endpoint === env.storage.endpoint;
  const appPrefixes = [env.app.replicaPrefix, env.app.mediaPrefix, env.app.deliveryPrefix, ...env.app.derivedPrefixes].map((p) => env.storage.prefix + p);
  if (sameBucket) for (const p of appPrefixes) if (overlaps(backupStorage.prefix + env.backups.prefix, p)) problems.push(`the backup location ${env.backups.prefix} overlaps the app prefix ${p}`);
  const named: Array<[string, string]> = [["replica", env.app.replicaPrefix], ["delivery", env.app.deliveryPrefix], ["media", env.app.mediaPrefix], ...env.app.derivedPrefixes.map((p): [string, string] => ["derived", p])];
  named.forEach(([name, p], i) => {
    for (const [otherName, other] of named.slice(i + 1)) if (overlaps(p, other)) problems.push(`the ${name} prefix ${p} overlaps the ${otherName} prefix ${other}`);
  });
  return problems;
}
