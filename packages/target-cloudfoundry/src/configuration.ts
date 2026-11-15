import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
// eslint-disable-next-line no-restricted-imports -- a target adapter implements the update interface of kestrel-ops
import type { ConfigurationRestore, RecordedConfiguration } from "@michaelthielemann/kestrel-ops";
import { curlWithBody } from "./droplets.ts";
import { appManifest } from "./manifest.ts";
import { CfApiError, type CfSession } from "./session.ts";

const PLACEHOLDER = /\(\((!?[-/.\w\p{L}]+)\)\)/u;

const envSchema = z.object({ var: z.record(z.string(), z.unknown()).nullish() });
const processSchema = z.object({
  guid: z.string(),
  command: z.string().nullish(),
  instances: z.number().int(),
  memory_in_mb: z.number().nullish(),
  disk_in_mb: z.number().nullish(),
  health_check: z.object({ type: z.string(), data: z.object({ timeout: z.number().nullish(), invocation_timeout: z.number().nullish(), endpoint: z.string().nullish() }).nullish() }),
});
const dropletSchema = z.object({ guid: z.string() });
const revisionsSchema = z.object({ resources: z.array(z.object({ guid: z.string(), version: z.number().int() })) });

const fingerprint = (salt: string, value: string): string => createHash("sha256").update(salt + value).digest("hex");

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

async function variables(session: CfSession): Promise<Record<string, string>> {
  const answer = await session.api(`/v3/apps/${await session.appGuid()}/environment_variables`, envSchema);
  return Object.fromEntries(Object.entries(answer.var ?? {}).map(([name, value]) => [name, asText(value)]));
}

function manifestVarNames(session: CfSession): Set<string> {
  if (session.config.manifest === undefined) return new Set();
  const { text } = appManifest(resolve(session.deps.root, session.config.manifest), session.app);
  const applications: unknown = Reflect.get(Object(JSON.parse(text)), "applications");
  const env: unknown = Array.isArray(applications) ? Reflect.get(Object(applications[0]), "env") : undefined;
  if (typeof env !== "object" || env === null) return new Set();
  return new Set(Object.entries(env).filter(([, value]) => PLACEHOLDER.test(asText(value))).map(([name]) => name));
}

/**
 * Reads the app's configuration: environment variables (values of the names in `secretNames` and of the names the
 * manifest entry fills from `vars` only as salted fingerprints), the web process's health check, memory, disk, command
 * and instances, the current droplet and the newest revision.
 */
export async function readConfiguration(session: CfSession, secretNames: ReadonlySet<string>): Promise<RecordedConfiguration> {
  const guid = await session.appGuid();
  const vaulted = manifestVarNames(session);
  const salt = randomBytes(16).toString("hex");
  const env: RecordedConfiguration["env"] = {};
  for (const [name, value] of Object.entries(await variables(session))) env[name] = secretNames.has(name) || vaulted.has(name) ? { fingerprint: fingerprint(salt, value) } : { value };
  const web = await session.api(`/v3/apps/${guid}/processes/web`, processSchema);
  const droplet = await session.api(`/v3/apps/${guid}/droplets/current`, dropletSchema).catch((error: unknown) => {
    if (error instanceof CfApiError && error.titles.includes("CF-ResourceNotFound")) return null;
    throw error;
  });
  const revision = (await session.api(`/v3/apps/${guid}/revisions?order_by=-created_at&per_page=1`, revisionsSchema)).resources[0];
  const data = web.health_check.data;
  return {
    schema: "kestrel-ops/configuration@1",
    recordedAt: session.deps.clock(),
    droplet: droplet?.guid ?? null,
    revision: revision === undefined ? null : { guid: revision.guid, version: revision.version },
    salt,
    env,
    healthCheck: { type: web.health_check.type, endpoint: data?.endpoint ?? null, timeoutSeconds: data?.timeout ?? null, invocationTimeoutSeconds: data?.invocation_timeout ?? null },
    memoryMb: web.memory_in_mb ?? null,
    diskMb: web.disk_in_mb ?? null,
    command: web.command ?? null,
    instances: web.instances,
  };
}

/**
 * Restores `recorded` verbatim while the app is stopped: plain variables to their values and variables the record
 * does not know removed, through a request body in a file only this user can read, never through a value on a command
 * line; the health check, command, memory and disk of the web process. A secret variable whose current value
 * does not match its fingerprint is reported, not changed.
 */
export async function restoreConfiguration(session: CfSession, recorded: RecordedConfiguration): Promise<ConfigurationRestore> {
  await session.requireStopped("restore the configuration");
  const guid = await session.appGuid();
  const current = await variables(session);
  const result: ConfigurationRestore = { set: [], removed: [], unchanged: [], unrestorable: [] };
  const body: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(recorded.env)) {
    if ("value" in value) {
      body[name] = value.value;
      result.set.push(name);
      continue;
    }
    const now = current[name];
    (now !== undefined && fingerprint(recorded.salt, now) === value.fingerprint ? result.unchanged : result.unrestorable).push(name);
  }
  for (const name of Object.keys(current)) {
    if (recorded.env[name] !== undefined) continue;
    body[name] = null;
    result.removed.push(name);
  }
  const json = ["Content-Type: application/json"];
  await curlWithBody(session, `/v3/apps/${guid}/environment_variables`, "PATCH", JSON.stringify({ var: body }), json);
  const web = await session.api(`/v3/apps/${guid}/processes/web`, processSchema);
  const hc = recorded.healthCheck;
  const data: Record<string, unknown> = {};
  if (hc.timeoutSeconds !== null) data.timeout = hc.timeoutSeconds;
  if (hc.invocationTimeoutSeconds !== null) data.invocation_timeout = hc.invocationTimeoutSeconds;
  if (hc.type === "http") data.endpoint = hc.endpoint;
  await curlWithBody(session, `/v3/processes/${web.guid}`, "PATCH", JSON.stringify({ command: recorded.command, health_check: { type: hc.type, data } }), json);
  const scale: Record<string, number> = {};
  if (recorded.memoryMb !== null) scale.memory_in_mb = recorded.memoryMb;
  if (recorded.diskMb !== null) scale.disk_in_mb = recorded.diskMb;
  if (Object.keys(scale).length > 0) await curlWithBody(session, `/v3/processes/${web.guid}/actions/scale`, "POST", JSON.stringify(scale), json);
  return result;
}
