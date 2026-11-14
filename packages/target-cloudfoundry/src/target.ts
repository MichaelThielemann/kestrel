import { resolve } from "node:path";
import { z } from "zod";
// eslint-disable-next-line no-restricted-imports -- a target adapter implements the Target interface of kestrel-ops and resolves credentials the way it does
import { commandRunner, OpsError, Redactor, resolveCredential, type Target, type TargetDeps, type TargetFacts, type TargetFactory, type TargetStatus } from "@michaelthielemann/kestrel-ops";
import { cfRunner, type CfRunner } from "./cf.ts";
import { parseConfig, type CloudFoundryConfig } from "./config.ts";
import { appManifest, withManifestFiles } from "./manifest.ts";
import { installedPackages } from "./packages.ts";

/** A {@link Target} for one app in a Cloud Foundry space, with the steps an update performs while it is stopped. */
export interface CloudFoundryTarget extends Target {
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
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const appSchema = z.object({ state: z.string() });
const processSchema = z.object({ instances: z.number().int() });
const statsSchema = z.object({ resources: z.array(z.object({ state: z.string() })) });
const listSchema = z.object({ resources: z.array(z.unknown()) });
const dropletSchema = z.object({ guid: z.string() });
const envSchema = z.object({ var: z.record(z.string(), z.unknown()).nullish() });
const eventsSchema = z.object({ resources: z.array(z.object({ type: z.string(), created_at: z.string() })) });

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

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

  const exited = (args: readonly string[], code: number): OpsError => new OpsError(`cf ${args.join(" ")} exited with ${code}`, 1, "target");

  const resolveGuid = async (): Promise<string> => {
    const current = await run(["target"]);
    if (current.code !== 0) throw new OpsError(`cf is not logged in or has no target (cf target exited with ${current.code}); log in with cf login and run cf target -o ${config.org} -s ${config.space}`, 2, "target");
    const org = /^org:\s*(.*?)\s*$/im.exec(current.stdout)?.[1] ?? "";
    const space = /^space:\s*(.*?)\s*$/im.exec(current.stdout)?.[1] ?? "";
    if (org !== config.org || space !== config.space) throw new OpsError(`cf targets org ${org || "(none)"} and space ${space || "(none)"}, the environment names org ${config.org} and space ${config.space}; run cf target -o ${config.org} -s ${config.space}`, 2, "target");
    const found = await run(["app", app, "--guid"]);
    const guid = found.stdout.trim();
    if (found.code !== 0 || !GUID.test(guid)) throw new OpsError(`the space ${config.org}/${config.space} has no app ${app} (cf app ${app} --guid exited with ${found.code})`, 2, "target");
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

  const api = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const result = await run(["curl", path]);
    if (result.code !== 0) throw exited(["curl", path], result.code);
    let body: unknown;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      throw new OpsError(`cf curl ${path} answered no JSON`, 1, "target");
    }
    const errors: unknown = Reflect.get(Object(body), "errors");
    if (Array.isArray(errors) && errors.length > 0) {
      const titles = errors.map((e: unknown): unknown => Reflect.get(Object(e), "title")).filter((t): t is string => typeof t === "string");
      throw new OpsError(`cf curl ${path} answered ${titles.join(", ") || "an error"}`, 1, "target");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new OpsError(`cf curl ${path} answered an unexpected document`, 1, "target");
    return parsed.data;
  };

  const status = async (): Promise<TargetStatus> => {
    const guid = await appGuid();
    const deployments = await api(`/v3/deployments?app_guids=${guid}&status_values=ACTIVE`, listSchema);
    if (deployments.resources.length > 0) throw new OpsError(`a deployment of ${app} is in progress, such as a rolling push; wait until it ends or run cf cancel-deployment ${app}`, 1, "target");
    const process = await api(`/v3/apps/${guid}/processes/web`, processSchema);
    const stats = await api(`/v3/apps/${guid}/processes/web/stats`, statsSchema);
    const running = stats.resources.filter((r) => r.state !== "DOWN").length;
    const instances = Math.max(process.instances, running);
    if (instances > 1) throw new OpsError(`${app} is scaled to ${instances} instances; backup and restore need exactly one (cf scale ${app} -i 1)`, 1, "target");
    const { state } = await api(`/v3/apps/${guid}`, appSchema);
    return { state: state === "STARTED" ? "started" : state === "STOPPED" ? "stopped" : "unknown", instances: running };
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

  const target: CloudFoundryTarget = {
    transport: "promote",
    config,

    async describe(): Promise<TargetFacts> {
      const guid = await appGuid();
      const droplet = await api(`/v3/apps/${guid}/droplets/current`, dropletSchema).catch(() => null);
      const variables = await api(`/v3/apps/${guid}/environment_variables`, envSchema);
      return { kind: "cloudfoundry", packages: installedPackages(resolve(deps.root, config.dir)), org: config.org, space: config.space, app, appGuid: guid, droplet: droplet?.guid ?? null, envNames: Object.keys(variables.var ?? {}).sort() };
    },

    status,

    async stop() {
      await status();
      const args = ["stop", app];
      const result = await run(args, { timeoutMs: 600_000 });
      if (result.code !== 0) throw exited(args, result.code);
      const deadline = deps.clock() + (options.stopTimeoutMs ?? 120_000);
      for (;;) {
        const now = await status();
        if (now.state === "stopped" && now.instances === 0) return { stoppedAt: deps.clock() };
        if (deps.clock() >= deadline) throw new OpsError(`${app} still reports ${now.state} with ${now.instances} instance(s) after cf stop`, 1, "target");
        await sleep(pollMs);
      }
    },

    async start() {
      const now = await status();
      if (now.state === "started" && now.instances > 0) throw new OpsError(`${app} is already running`, 1, "target");
      const args = ["start", app];
      const result = await run(args, { timeoutMs: 900_000 });
      if (result.code !== 0) throw new OpsError(`cf start ${app} exited with ${result.code}; cf logs ${app} --recent shows why`, 1, "target");
    },

    async waitReady(timeoutMs) {
      const deadline = deps.clock() + timeoutMs;
      for (;;) {
        if ((await instanceRuns()) && (await answersReady())) return true;
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
        lines.push(`the platform events of ${app} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      const logs = await run(["logs", app, "--recent"], { timeoutMs: 60_000 });
      if (logs.code !== 0) lines.push(`cf logs ${app} --recent exited with ${logs.code}`);
      else for (const line of logs.stdout.split("\n").filter((l) => TEARDOWN_LINE.test(l) && FAILURE_WORD.test(l)).slice(-5)) lines.push(line.trim().slice(0, 300));
      return lines;
    },

    async applyManifest() {
      if (config.manifest === undefined) throw new OpsError("target cloudfoundry: manifest is not set", 2, "target");
      const { text, vars } = appManifest(resolve(deps.root, config.manifest), app);
      const missing = vars.filter((name) => config.vars[name] === undefined);
      if (missing.length > 0) throw new OpsError(`${config.manifest}: target.vars names no source for ${missing.map((name) => `((${name}))`).join(", ")}`, 2, "target");
      await requireStopped("apply the manifest");
      const redactor = new Redactor();
      const runCommand = commandRunner();
      const values: Record<string, string> = {};
      for (const name of vars) {
        const source = config.vars[name];
        if (source !== undefined) values[name] = await resolveCredential(source, `target.vars.${name}`, redactor, env, runCommand);
      }
      await withManifestFiles(text, values, async (manifestFile, varsFile) => {
        const args = ["apply-manifest", "-f", manifestFile, "--vars-file", varsFile];
        const result = await run(args, { timeoutMs: 600_000 });
        if (result.code !== 0) throw new OpsError(`cf apply-manifest for ${app} exited with ${result.code}`, 1, "target");
      });
    },

    async setDroplet(guid) {
      if (!GUID.test(guid)) throw new OpsError(`${guid} is not a droplet guid`, 2, "target");
      await requireStopped("set the droplet");
      const args = ["set-droplet", app, guid];
      const result = await run(args);
      if (result.code !== 0) throw exited(args, result.code);
    },
  };
  return target;
}

/** The factory kestrel-ops imports for `"adapter": "@michaelthielemann/kestrel-target-cloudfoundry"`. */
export const createTarget: TargetFactory = (config, deps) => cloudFoundryTarget(config, deps);
