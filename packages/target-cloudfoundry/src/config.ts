import { z } from "zod";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";

const credential = z.union([z.object({ env: z.string().min(1) }).strict(), z.object({ command: z.array(z.string().min(1)).min(1) }).strict()]);

/** The `target` block of an environment in `kestrel.environments.json` that names this adapter. */
export const configSchema = z
  .object({
    /** The name of the app in the space. Every cf call names this app or its guid, never another one. */
    app: z.string().min(1),
    /** The org cf must target; the target refuses to act while cf targets another. */
    org: z.string().min(1),
    /** The space cf must target. */
    space: z.string().min(1),
    /** The directory of the deployed app's `package.json`, relative to the environments file; its installed packages tell the runtime version. */
    dir: z.string().min(1).default("."),
    /** An http(s) URL that answers 200 once the app is ready, checked after an instance runs. */
    readyUrl: z.url({ protocol: /^https?$/ }).optional(),
    /**
     * How long a stop waits after the stop request when it sees no instance of the app shut down, in seconds. A Cloud
     * Controller without its `STOPPING` instance state lists a shutting-down instance as `DOWN`, so the wait covers the
     * instance's shutdown; it is at least the platform's graceful shutdown interval (10 s unless the operator changed it).
     */
    stopGraceSeconds: z.number().min(0).max(600).default(15),
    /** A manifest, relative to the environments file, holding the app's entry; `((name))` placeholders take their values from `vars`. */
    manifest: z.string().min(1).optional(),
    /** Where the value of each `((name))` placeholder of the manifest comes from: an environment variable or the output of a command. A name holds no dot, which cf reads as a field path. */
    vars: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), credential).default({}),
  })
  .strict();

/** The parsed `target` block, defaults applied. */
export type CloudFoundryConfig = z.infer<typeof configSchema>;

/** Validates a `target` block; an invalid one is a configuration error (exit 2). */
export function parseConfig(raw: Record<string, unknown>): CloudFoundryConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new OpsError(`target cloudfoundry: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(block)"}: ${i.message}`).join("; ")}`, 2, "target");
  return parsed.data;
}
