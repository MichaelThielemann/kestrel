import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
// eslint-disable-next-line no-restricted-imports -- a target adapter implements the Target interface of kestrel-ops and resolves credentials the way it does
import { commandRunner, OpsError, Redactor, resolveCredential, type TargetDeps, type TargetFacts, type TargetFactory, type TargetStatus, type UpdateTarget } from "@michaelthielemann/kestrel-ops";
import { cfRunner, CfUnfinished, type CfResult, type CfRunner } from "./cf.ts";
import { parseConfig, type CloudFoundryConfig } from "./config.ts";
import { readConfiguration, restoreConfiguration } from "./configuration.ts";
import { deleteDroplet, listDroplets, listRevisions, restoreDroplet, saveDroplet } from "./droplets.ts";
import { appManifest, withManifestFiles } from "./manifest.ts";
import { installedPackages } from "./packages.ts";
import { CfApiError, type CfSession } from "./session.ts";
import { crashEvents, preflight, probeReady, stagePackage } from "./staging.ts";

/** An {@link UpdateTarget} for one app in a Cloud Foundry space, with the steps an update performs while it is stopped. */
export interface CloudFoundryTarget extends UpdateTarget {
  readonly transport: "promote";
  readonly config: CloudFoundryConfig;
  /**
   * Applies the app's entry of `manifest` while the app is stopped, through `cf apply-manifest --vars-file` with
   * the `((name))` values from `vars` in a file only this user can read, removed afterwards. Other applications of
   * the manifest are left out.
   */
  applyManifest(): Promise<void>;
  /** Makes droplet `guid` the app's current droplet while the app is stopped. */
  setDroplet(guid: string): Promise<void>;
}

/** What {@link cloudFoundryTarget} takes besides its configuration; the defaults suit a real run. */
export interface CloudFoundryOptions {
  /** The environment cf runs in and `{ env }` variables are read from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Pause between two status reads while waiting, in milliseconds. Default 2000. */
  pollMs?: number;
  /** How long a stop may take to show no running instance, in milliseconds. Default 120000. */
  stopTimeoutMs?: number;
  /** How long a failing status read before a start is repeated, in milliseconds. Default 30000. */
  readTimeoutMs?: number;
  /** How long one `cf curl` may run before it counts as a failed call, in milliseconds. Default 120000. */
  callTimeoutMs?: number;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const appSchema = z.object({ state: z.string() });
const processSchema = z.object({ instances: z.number().int() });
const statsSchema = z.object({ resources: z.array(z.object({ state: z.string() })) });
const listSchema = z.object({ resources: z.array(z.unknown()) });
const dropletSchema = z.object({ guid: z.string() });
const currentDropletSchema = z.object({ data: z.object({ guid: z.string() }).nullable() });
const envSchema = z.object({ var: z.record(z.string(), z.unknown()).nullish() });
const revisionsSchema = z.object({ resources: z.array(z.object({ guid: z.string(), version: z.number().int() })) });
const eventsSchema = z.object({ resources: z.array(z.object({ type: z.string(), created_at: z.string() })) });

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const EVIDENCE_EVENT = /stop|crash/;
const TEARDOWN_LINE = /teardown|seal|replication/i;
const FAILURE_WORD = /error|fail|timeout|timed out|killed/i;

/** Builds a target for the app named in `raw`; see {@link CloudFoundryTarget}. */
export async function cloudFoundryTarget(raw: Record<string, unknown>, deps: TargetDeps, options: CloudFoundryOptions = {}): Promise<CloudFoundryTarget> {
  const config = parseConfig(raw);
  const env = options.env ?? process.env;
  const run: CfRunner = cfRunner(env);
  const pollMs = options.pollMs ?? 2000;
  const { app } = config;
  let guidOnce: Promise<string> | null = null;

  const readTimeoutMs = options.readTimeoutMs ?? 30_000;

  const resolveGuid = async (): Promise<string> => {
    const current = await run(["target"]);
    if (current.code !== 0) throw new OpsError(`cf is not logged in or has no target (cf target exited with ${current.code}); log in with cf login and run cf target -o ${config.org} -s ${config.space}`, 2, "target");
    const org = /^org:\s*(.*?)\s*$/im.exec(current.stdout)?.[1] ?? "";
    const space = /^space:\s*(.*?)\s*$/im.exec(current.stdout)?.[1] ?? "";
    if (org !== config.org || space !== config.space) throw new OpsError(`cf targets org ${org || "(none)"} and space ${space || "(none)"}, the environment names org ${config.org} and space ${config.space}; run cf target -o ${config.org} -s ${config.space}`, 2, "target");
    const found = await run(["app", app, "--guid"]);
    const guid = found.stdout.trim();
    if (found.code !== 0) throw new OpsError(`cf app ${app} --guid exited with ${found.code}: ${config.org}/${config.space} holds no app ${app}, or the cf session has expired (log in again with cf login)`, 2, "target");
    if (!GUID.test(guid)) throw new OpsError(`cf app ${app} --guid answered no app guid`, 2, "target");
    return guid;
  };

  const appGuid = async (): Promise<string> => {
    guidOnce ??= resolveGuid();
    try {
      return await guidOnce;
    } catch (error) {
      guidOnce = null;
      throw error;
    }
  };

  const confirmTarget = async (): Promise<void> => {
    const guid = await appGuid();
    const now = await resolveGuid();
    if (now !== guid) throw new OpsError(`the app ${app} in ${config.org}/${config.space} has the guid ${now}, not ${guid} as when this run began; check it with cf target -o ${config.org} -s ${config.space} and cf app ${app}`, 2, "target");
  };

  const api = async <T>(path: string, schema: z.ZodType<T>, method = "GET", data?: string): Promise<T> => {
    const args = method === "GET" ? ["curl", path] : ["curl", path, "-X", method, ...(data === undefined ? [] : ["-d", data])];
    const result = await run(args, { timeoutMs: options.callTimeoutMs ?? 120_000 }).catch((error: unknown) => {
      throw error instanceof CfUnfinished ? new CfApiError(error.message) : error;
    });
    if (result.code !== 0) throw new CfApiError(`cf ${(method === "GET" ? ["curl", path] : ["curl", "-X", method, path]).join(" ")} exited with ${result.code}`);
    let body: unknown;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      throw new CfApiError(`cf curl ${path} answered no JSON`);
    }
    const errors: unknown = Reflect.get(Object(body), "errors");
    if (Array.isArray(errors) && errors.length > 0) {
      const titles = errors.map((e: unknown): unknown => Reflect.get(Object(e), "title")).filter((t): t is string => typeof t === "string");
      throw new CfApiError(`cf curl ${path} answered ${titles.join(", ") || "an error"}`, titles);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new CfApiError(`cf curl ${path} answered an unexpected document`);
    return parsed.data;
  };

  const requireOneInstance = async (guid: string): Promise<number> => {
    const deployments = await api(`/v3/deployments?app_guids=${guid}&status_values=ACTIVE`, listSchema);
    if (deployments.resources.length > 0) throw new OpsError(`a deployment of ${app} is in progress, such as a rolling push; wait until it ends or run cf cancel-deployment ${app}`, 1, "target");
    const process = await api(`/v3/apps/${guid}/processes/web`, processSchema);
    const stats = await api(`/v3/apps/${guid}/processes/web/stats`, statsSchema);
    const running = stats.resources.filter((r) => r.state !== "DOWN").length;
    const instances = Math.max(process.instances, running);
    if (instances > 1) throw new OpsError(`${app} is scaled to ${instances} instances; backup and restore need exactly one (cf scale ${app} -i 1)`, 1, "target");
    if (process.instances === 0) throw new OpsError(`${app} is scaled to 0 instances; backup and restore need exactly one: cf scale ${app} -i 1, after cf stop ${app} to keep it offline, since scaling a stopped app does not start it`, 1, "target");
    return running;
  };

  const status = async (): Promise<TargetStatus> => {
    const guid = await appGuid();
    const running = await requireOneInstance(guid);
    const { state } = await api(`/v3/apps/${guid}`, appSchema);
    return { state: state === "STARTED" ? "started" : state === "STOPPED" ? "stopped" : "unknown", instances: running };
  };

  const readRepeated = async (): Promise<TargetStatus> => {
    const deadline = deps.clock() + readTimeoutMs;
    for (;;) {
      try {
        return await status();
      } catch (error) {
        if (!(error instanceof CfApiError) || deps.clock() >= deadline) throw error;
      }
      await sleep(pollMs);
    }
  };

  const requireStopped = async (step: string): Promise<void> => {
    const now = await status();
    if (now.state !== "stopped" || now.instances > 0) throw new OpsError(`refusing to ${step} while ${app} is ${now.state} with ${now.instances} instance(s); stop it first`, 1, "target");
  };

  const instanceRuns = async (): Promise<boolean> => {
    const stats = await api(`/v3/apps/${await appGuid()}/processes/web/stats`, statsSchema);
    return stats.resources.some((r) => r.state === "RUNNING");
  };

  const answersReady = async (): Promise<boolean> => {
    if (config.readyUrl === undefined) return true;
    try {
      return (await fetch(config.readyUrl, { signal: AbortSignal.timeout(5000) })).status === 200;
    } catch {
      return false;
    }
  };

  const releaseManifest = (): { text: string; vars: string[] } => {
    if (config.manifest === undefined) throw new OpsError("target cloudfoundry: manifest is not set", 2, "target");
    const manifest = appManifest(resolve(deps.root, config.manifest), app);
    const missing = manifest.vars.filter((name) => config.vars[name] === undefined);
    if (missing.length > 0) throw new OpsError(`${config.manifest}: target.vars names no source for ${missing.map((name) => `((${name}))`).join(", ")}`, 2, "target");
    return manifest;
  };

  const resolveVars = async (vars: readonly string[]): Promise<Record<string, string>> => {
    const redactor = new Redactor();
    const runCommand = commandRunner();
    const values: Record<string, string> = {};
    for (const name of vars) {
      const source = config.vars[name];
      if (source !== undefined) values[name] = await resolveCredential(source, `target.vars.${name}`, redactor, env, runCommand);
    }
    return values;
  };

  const session: CfSession = { app, config, deps, env, pollMs, run, api, appGuid, confirmTarget, requireStopped, status };

  const target: CloudFoundryTarget = {
    transport: "promote",
    config,

    async describe(): Promise<TargetFacts> {
      const guid = await appGuid();
      await requireOneInstance(guid);
      const droplet = await api(`/v3/apps/${guid}/droplets/current`, dropletSchema).catch((error: unknown) => {
        if (error instanceof CfApiError && error.titles.includes("CF-ResourceNotFound")) return null;
        throw error;
      });
      const revisions = await api(`/v3/apps/${guid}/revisions?order_by=-created_at&per_page=1`, revisionsSchema);
      const latest = revisions.resources[0];
      const variables = await api(`/v3/apps/${guid}/environment_variables`, envSchema);
      return { kind: "cloudfoundry", packages: installedPackages(resolve(deps.root, config.dir)), packagesFrom: resolve(deps.root, config.dir), org: config.org, space: config.space, app, appGuid: guid, droplet: droplet?.guid ?? null, revision: latest === undefined ? null : { guid: latest.guid, version: latest.version }, envNames: Object.keys(variables.var ?? {}).sort() };
    },

    status,

    async stop() {
      const before = await status();
      const requestedAt = deps.clock();
      try {
        await api(`/v3/apps/${await appGuid()}/actions/stop`, appSchema, "POST");
      } catch (error) {
        const after = await readRepeated().catch(() => null);
        if (after?.state !== "stopped") throw new OpsError(`stopping ${app} failed: ${messageOf(error)}; cf app ${app} shows whether it stopped, and cf start ${app} in ${config.org}/${config.space} starts it again`, 1, "target");
      }
      const graceMs = before.instances > 0 ? config.stopGraceSeconds * 1000 : 0;
      let sawShutdown = false;
      const timeoutMs = options.stopTimeoutMs ?? 120_000;
      const deadline = deps.clock() + timeoutMs;
      for (;;) {
        let seen: string;
        try {
          const now = await status();
          if (now.state === "stopped" && now.instances === 0) {
            const left = sawShutdown ? 0 : requestedAt + graceMs - deps.clock();
            if (left > 0) await sleep(left);
            return { stoppedAt: deps.clock() };
          }
          if (now.state === "stopped") sawShutdown = true;
          seen = `reports ${now.state} with ${now.instances} instance(s)`;
        } catch (error) {
          seen = `could not be read: ${messageOf(error)}`;
        }
        if (deps.clock() >= deadline) throw new OpsError(`${app} was stopped, and ${Math.round(timeoutMs / 1000)} s later its state ${seen}; it stays stopped until it is started again with cf start ${app} in ${config.org}/${config.space}`, 1, "target");
        await sleep(pollMs);
      }
    },

    async start() {
      let now: TargetStatus;
      try {
        now = await readRepeated();
      } catch (error) {
        if (!(error instanceof CfApiError)) throw error;
        throw new OpsError(`the state of ${app} could not be read before the start: ${messageOf(error)}; it stays as it is until it is started with cf start ${app} in ${config.org}/${config.space}`, 1, "target");
      }
      if (now.state === "started" && now.instances > 0) throw new OpsError(`${app} is already running`, 1, "target");
      try {
        await api(`/v3/apps/${await appGuid()}/actions/start`, appSchema, "POST");
      } catch (error) {
        const after = await status().catch(() => null);
        if (after?.state === "started") return;
        throw new OpsError(`starting ${app} failed: ${messageOf(error)}; cf logs ${app} --recent shows why`, 1, "target");
      }
    },

    async waitReady(timeoutMs) {
      const deadline = deps.clock() + timeoutMs;
      for (;;) {
        let runs = false;
        try {
          runs = await instanceRuns();
        } catch (error) {
          if (!(error instanceof CfApiError)) throw error;
        }
        if (runs && (await answersReady())) return true;
        if (deps.clock() >= deadline) return false;
        await sleep(pollMs);
      }
    },

    async stopEvidence() {
      const guid = await appGuid();
      const lines: string[] = [];
      try {
        const events = await api(`/v3/audit_events?target_guids=${guid}&order_by=-created_at&per_page=20`, eventsSchema);
        for (const event of events.resources.filter((e) => EVIDENCE_EVENT.test(e.type)).slice(0, 5)) lines.push(`${event.created_at} ${event.type}`);
      } catch (error) {
        lines.push(`the platform events of ${app} could not be read: ${messageOf(error)}`);
      }
      let logs: CfResult | null = null;
      try {
        await confirmTarget();
        logs = await run(["logs", app, "--recent"], { timeoutMs: 60_000 });
      } catch (error) {
        lines.push(`the logs of ${app} were not read: ${messageOf(error)}`);
      }
      if (logs === null) return lines;
      if (logs.code !== 0) lines.push(`cf logs ${app} --recent exited with ${logs.code}`);
      else for (const line of logs.stdout.split("\n").filter((l) => TEARDOWN_LINE.test(l) && FAILURE_WORD.test(l)).slice(-5)) lines.push(line.trim().slice(0, 300));
      return lines;
    },

    async applyManifest() {
      const { text, vars } = releaseManifest();
      await requireStopped("apply the manifest");
      const values = await resolveVars(vars);
      await withManifestFiles(text, values, async (manifestFile, varsFile) => {
        await confirmTarget();
        const args = ["apply-manifest", "-f", manifestFile, "--vars-file", varsFile];
        const result = await run(args, { timeoutMs: 600_000 });
        if (result.code !== 0) throw new OpsError(`cf apply-manifest for ${app} exited with ${result.code}`, 1, "target");
      });
    },

    async checkReleaseConfiguration(_release, options) {
      if (config.manifest === undefined) return { fingerprint: null };
      const { text, vars } = releaseManifest();
      if (options.resolveSources) await resolveVars(vars);
      const sources = Object.fromEntries(vars.map((name) => [name, config.vars[name] ?? null]));
      return { fingerprint: createHash("sha256").update(JSON.stringify({ manifest: text, sources })).digest("hex") };
    },

    async setDroplet(guid) {
      if (!GUID.test(guid)) throw new OpsError(`${guid} is not a droplet guid`, 2, "target");
      await requireStopped("set the droplet");
      await api(`/v3/apps/${await appGuid()}/relationships/current_droplet`, currentDropletSchema, "PATCH", JSON.stringify({ data: { guid } }));
    },

    async currentDroplet() {
      const droplet = await api(`/v3/apps/${await appGuid()}/droplets/current`, dropletSchema).catch((error: unknown) => {
        if (error instanceof CfApiError && error.titles.includes("CF-ResourceNotFound")) return null;
        throw error;
      });
      return droplet?.guid ?? null;
    },

    async applyReleaseConfiguration() {
      if (config.manifest !== undefined) await target.applyManifest();
    },

    preflight: () => preflight(session),
    stage: (release) => stagePackage(session, release),
    readConfiguration: (secretNames) => readConfiguration(session, secretNames),
    restoreConfiguration: (recorded) => restoreConfiguration(session, recorded),
    probeReady: () => probeReady(session),
    crashEvents: (since) => crashEvents(session, since),
    listDroplets: () => listDroplets(session),
    listRevisions: () => listRevisions(session),
    deleteDroplet: (guid) => deleteDroplet(session, guid),
    saveDroplet: (guid, file) => saveDroplet(session, guid, file),
    restoreDroplet: (file) => restoreDroplet(session, file),
  };
  return target;
}

/** The factory kestrel-ops imports for `"adapter": "@michaelthielemann/kestrel-target-cloudfoundry"`. */
export const createTarget: TargetFactory = (config, deps) => cloudFoundryTarget(config, deps);
