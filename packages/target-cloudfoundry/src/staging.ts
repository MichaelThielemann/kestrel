import { z } from "zod";
// eslint-disable-next-line no-restricted-imports -- a target adapter implements the update interface of kestrel-ops
import type { CrashEvent, ReadyProbe, ReleaseSource, StagedDroplet, TargetPreflight } from "@michaelthielemann/kestrel-ops";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";
import { CfUnfinished, type CfResult } from "./cf.ts";
import type { CfSession } from "./session.ts";

/** How long one readiness check may take before it counts as unverifiable, in milliseconds. */
export const PROBE_TIMEOUT_MS = 5000;

/** How long uploading a package may take, in milliseconds. */
export const PACKAGE_TIMEOUT_MS = 600_000;

/** How long staging a package may take, in milliseconds. */
export const STAGING_TIMEOUT_MS = 1_800_000;

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const processSchema = z.object({ instances: z.number().int(), health_check: z.object({ type: z.string() }).nullish() });
const statsSchema = z.object({ resources: z.array(z.object({ state: z.string() })) });
const deploymentsSchema = z.object({ resources: z.array(z.object({ guid: z.string(), strategy: z.string().nullish() })) });
const eventsSchema = z.object({ resources: z.array(z.object({ type: z.string(), created_at: z.string(), data: z.record(z.string(), z.unknown()).nullish() })) });

const CRASH_EVENT = /crash/;

/**
 * The desired and running instances of the app's web process, an active deployment, the health check type and whether
 * a `readyUrl` lets {@link probeReady} check readiness, read without refusing.
 */
export async function preflight(session: CfSession): Promise<TargetPreflight> {
  const guid = await session.appGuid();
  const deployments = await session.api(`/v3/deployments?app_guids=${guid}&status_values=ACTIVE`, deploymentsSchema);
  const process = await session.api(`/v3/apps/${guid}/processes/web`, processSchema);
  const stats = await session.api(`/v3/apps/${guid}/processes/web/stats`, statsSchema);
  const active = deployments.resources[0];
  return {
    instances: process.instances,
    running: stats.resources.filter((r) => r.state !== "DOWN").length,
    activeDeployment: active === undefined ? null : `${active.strategy ?? "deployment"} ${active.guid}`,
    healthCheck: process.health_check?.type ?? "port",
    readinessChecked: session.config.readyUrl !== undefined,
  };
}

async function runStep(session: CfSession, args: readonly string[], timeoutMs: number, what: string): Promise<CfResult> {
  await session.confirmTarget();
  try {
    return await session.run(args, { timeoutMs });
  } catch (error) {
    if (error instanceof CfUnfinished) throw new OpsError(`${what} for ${session.app} did not finish: ${error.message}; the running app was not changed`, 1, "target");
    throw error;
  }
}

/**
 * Uploads `release.dir` as a new package of the app and stages it into a droplet (`cf create-package`, then
 * `cf stage-package`), while the app keeps running; the app's state, droplet and configuration stay as they were,
 * also when staging fails.
 */
export async function stagePackage(session: CfSession, release: ReleaseSource): Promise<StagedDroplet> {
  const created = await runStep(session, ["create-package", session.app, "-p", release.dir], PACKAGE_TIMEOUT_MS, "cf create-package");
  if (created.code !== 0) throw new OpsError(`cf create-package for ${session.app} exited with ${created.code}; the running app was not changed`, 1, "target");
  const pkg = /package with guid\W+([0-9a-f-]{36})/i.exec(created.stdout)?.[1] ?? GUID.exec(created.stdout)?.[0];
  if (pkg === undefined) throw new OpsError(`cf create-package for ${session.app} named no package guid`, 1, "target");
  const staged = await runStep(session, ["stage-package", session.app, "--package-guid", pkg], STAGING_TIMEOUT_MS, "cf stage-package");
  if (staged.code !== 0) throw new OpsError(`staging failed: cf stage-package for ${session.app} exited with ${staged.code}; the running app was not changed, and cf logs ${session.app} --recent shows the staging output`, 1, "target");
  const droplet = /droplet guid:\s*([0-9a-f-]{36})/i.exec(staged.stdout)?.[1];
  if (droplet === undefined) throw new OpsError(`cf stage-package for ${session.app} named no droplet guid`, 1, "target");
  return { droplet, package: pkg, stagedAt: session.deps.clock() };
}

function readyFalse(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && Reflect.get(parsed, "ready") === false;
  } catch {
    return false;
  }
}

/**
 * One readiness check against `readyUrl` once an instance runs: 200 is `ready`; 503, a JSON body with `ready: false`
 * or another 5xx is `not-ready`; 401, 403, 404, a timeout or no connection is `unverifiable`. Without `readyUrl` an
 * instance in state `RUNNING` is `ready`. `timeoutMs` bounds the request, {@link PROBE_TIMEOUT_MS} by default.
 */
export async function probeReady(session: CfSession, options: { timeoutMs?: number } = {}): Promise<ReadyProbe> {
  const stats = await session.api(`/v3/apps/${await session.appGuid()}/processes/web/stats`, statsSchema);
  if (!stats.resources.some((r) => r.state === "RUNNING")) return { outcome: "unverifiable", status: null, reason: "no instance runs" };
  const url = session.config.readyUrl;
  if (url === undefined) return { outcome: "ready", status: 200 };
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  let response: Response;
  let body: string;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    body = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { outcome: "unverifiable", status: null, reason: timedOut ? `no answer within ${timeoutMs} ms` : "no connection" };
  }
  const status = response.status;
  if (status === 200) return readyFalse(body) ? { outcome: "not-ready", status } : { outcome: "ready", status };
  if (status >= 500) return { outcome: "not-ready", status };
  return { outcome: "unverifiable", status, reason: status === 401 || status === 403 ? "the readiness check is not allowed from here" : `the readiness check answered ${status}` };
}

const text = (data: Record<string, unknown> | null | undefined, name: string): string | null => {
  const value = data?.[name];
  return typeof value === "string" && value !== "" ? value : null;
};

/** The app's crash events (`audit.app.process.crash` and failed starts) at or after `since`. */
export async function crashEvents(session: CfSession, since: number): Promise<CrashEvent[]> {
  const guid = await session.appGuid();
  const events = await session.api(`/v3/audit_events?target_guids=${guid}&created_ats[gte]=${new Date(since).toISOString()}&order_by=-created_at&per_page=100`, eventsSchema);
  return events.resources
    .filter((e) => CRASH_EVENT.test(e.type) && Date.parse(e.created_at) >= since)
    .map((e) => ({ at: Date.parse(e.created_at), type: e.type, reason: text(e.data, "exit_description") ?? text(e.data, "reason") }))
    .sort((a, b) => a.at - b.at);
}
