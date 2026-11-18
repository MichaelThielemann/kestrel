import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";

/** One app in a space of the fake. */
export interface FakeCfApp {
  name: string;
  guid: string;
  org: string;
  space: string;
  state: "STARTED" | "STOPPED";
  /** The web process's desired instance count. */
  instances: number;
  /** Instances whose state is not DOWN. */
  running: number;
  /** Instances that reached RUNNING; the rest of `running` are STARTING. */
  ready: number;
  /** Stats reads after a stop during which the instances still shut down, at least until the shutdown hook ends. */
  downAfter: number;
  droplet: string | null;
  revision: { guid: string; version: number } | null;
  env: Record<string, string>;
  events: Array<{ type: string; created_at: string }>;
  logs: string[];
}

/** What the fake saw of an `apply-manifest` call while it ran. */
export interface AppliedManifest {
  manifest: string;
  varsFile: string;
  varsMode: number;
  vars: string;
  /** The org and space cf targeted, as `org/space`. */
  target: string;
}

/** A state change the fake performed on an app through the v3 API. */
export interface FakeCfAction {
  app: string;
  space: string;
  action: "stop" | "start" | "set-droplet";
}

/**
 * Hooks of the app's instance. `start` runs before cf answers the start call; `stop` is the instance's shutdown and
 * runs after cf answered the stop call, as on Cloud Foundry, where the instance gets its stop signal only then.
 */
export interface FakeCfHooks {
  start?: (app: FakeCfApp) => Promise<void>;
  stop?: (app: FakeCfApp) => Promise<void>;
}

interface Answer {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals;
  hangMs?: number;
  after?: () => Promise<void>;
}

/** What an extra handler of the fake answers: the exit code and both streams of the stub `cf`. */
export interface FakeCfAnswer {
  code: number;
  stdout: string;
  stderr: string;
}

/** One `cf curl` call as an extra route sees it; `data` is the body, read from the file a `-d @<file>` names. */
export interface FakeCfRequest {
  method: string;
  url: URL;
  data: string;
  /** The app whose guid the path names after `/v3/apps/`, if any. */
  app: FakeCfApp | undefined;
}

/** An extra `cf curl` handler; answering `undefined` passes the call on to the next one and then to the built-in API. */
export type FakeCfRoute = (request: FakeCfRequest) => FakeCfAnswer | undefined | Promise<FakeCfAnswer | undefined>;

/** An extra cf subcommand, called with the arguments after its name. */
export type FakeCfCommand = (args: string[]) => FakeCfAnswer | Promise<FakeCfAnswer>;

/** A successful answer of `cf curl` with `value` as its JSON body. */
export const fakeJson = (value: unknown): FakeCfAnswer => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

/** A failed cf call with `stderr` on standard error. */
export const fakeFailure = (stderr: string): FakeCfAnswer => ({ code: 1, stdout: "FAILED\n", stderr });

const TIMESTAMP_FILTER = /^(created|updated)_ats(?:\[([^\]]*)\])?$/;
const CF_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RELATIONS = new Set(["gt", "gte", "lt", "lte"]);

/**
 * Why the Cloud Controller refuses the timestamp filters of `url`, or null: a `created_ats` or `updated_ats` value
 * must be `YYYY-MM-DDThh:mm:ssZ`, a list of them without a relational operator, and an operator one of gt, gte, lt, lte.
 */
export function timestampFilterError(url: URL): string | null {
  for (const [name, value] of url.searchParams) {
    const match = TIMESTAMP_FILTER.exec(name);
    if (match === null) continue;
    const field = match[1] === "created" ? "Created ats" : "Updated ats";
    const relation = match[2];
    if (relation !== undefined && !RELATIONS.has(relation)) return `The query parameter is invalid: ${field} has an invalid relational operator '${relation}'`;
    const values = relation === undefined ? value.split(",") : [value];
    if (!values.every((v) => CF_TIMESTAMP.test(v))) return `The query parameter is invalid: ${field} has an invalid timestamp format. Timestamps should be formatted as 'YYYY-MM-DDThh:mm:ssZ'`;
  }
  return null;
}

/** Whether a resource created at `createdAt` passes the `created_ats` filters of `url`, as the Cloud Controller applies them. */
export function passesCreatedAts(url: URL, createdAt: string): boolean {
  const at = Date.parse(createdAt);
  return [...url.searchParams].every(([name, value]) => {
    const relation = TIMESTAMP_FILTER.exec(name);
    if (relation === null || relation[1] !== "created") return true;
    const bound = Date.parse(value);
    if (relation[2] === "gt") return at > bound;
    if (relation[2] === "gte") return at >= bound;
    if (relation[2] === "lt") return at < bound;
    if (relation[2] === "lte") return at <= bound;
    return value.split(",").some((v) => Date.parse(v) === at);
  });
}

interface StubRequest {
  argv: string[];
  color: string | null;
  trace: string | null;
}

const STUB = `import { argv, env, exit, kill, pid, stdout, stderr } from "node:process";
const response = await fetch(env.CF_STUB_URL, { method: "POST", body: JSON.stringify({ argv: argv.slice(2), color: env.CF_COLOR ?? null, trace: env.CF_TRACE ?? null }) });
const answer = await response.json();
if (answer.hangMs) await new Promise((done) => setTimeout(done, answer.hangMs));
if (answer.signal) kill(pid, answer.signal);
if (env.CF_TRACE === "true") stdout.write("REQUEST: [2026-11-14T10:00:00Z]\\nGET /v3/apps HTTP/1.1\\n\\nRESPONSE: [2026-11-14T10:00:00Z]\\nHTTP/1.1 200 OK\\n\\n");
stdout.write(answer.stdout);
stderr.write(answer.stderr);
exit(answer.code);
`;

const PLACEHOLDER = /\(\((!?[-/.\w\p{L}]+)\)\)/gu;

const json = (value: unknown): Answer => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const fail = (stderr: string): Answer => ({ code: 1, stdout: "FAILED\n", stderr });
const apiError = (title: string): Answer => json({ errors: [{ code: 10008, title, detail: title }] });

/**
 * Cloud Foundry spaces in the test process, reached through a stub `cf` executable that forwards its argv over
 * HTTP. Put {@link FakeCloudFoundry.bin} first on `PATH` and {@link FakeCloudFoundry.url} into `CF_STUB_URL`.
 */
export class FakeCloudFoundry {
  readonly bin = mkdtempSync(join(tmpdir(), "kestrel-cf-stub-"));
  readonly calls: string[][] = [];
  readonly colors: Array<string | null> = [];
  readonly traces: Array<string | null> = [];
  readonly applied: AppliedManifest[] = [];
  readonly actions: FakeCfAction[] = [];
  readonly all: FakeCfApp[] = [];
  org = "example-org";
  space = "dev";
  loggedIn = true;
  /** `cf target` answers from the local configuration while every call that reaches the API fails. */
  sessionExpired: boolean = false;
  /** Stats reads after a stop during which the stopped app's instances still shut down, at least until the shutdown hook ends. */
  stopLag: number = 1;
  /**
   * The state the stats of a stopped app report for an instance that still shuts down: `STOPPING`, or `DOWN` as a
   * Cloud Controller without its stopping state reports it.
   */
  stoppingState: "STOPPING" | "DOWN" = "STOPPING";
  activeDeployments = new Set<string>();
  /** The exit code a cf subcommand answers with instead of doing its work. */
  failures: Map<string, number> = new Map();
  /** How many of the next calls of a subcommand fail with exit 1. */
  failNext: Map<string, number> = new Map();
  /** App actions, `stop` or `start`, that the API refuses. */
  rejectedActions: Set<string> = new Set();
  /** App actions, `stop` or `start`, that take effect while cf answers them with exit 1. */
  lostAnswers: Set<string> = new Set();
  /** `cf curl` paths, without their query, that exit with 1. */
  failingPaths: Set<string> = new Set();
  /** How many of the next `cf curl` calls of a path, without its query, end by SIGKILL. */
  killedPaths: Map<string, number> = new Map();
  /** How many of the next `cf curl` calls of a path, without its query, hang for a minute before they answer. */
  hungPaths: Map<string, number> = new Map();
  hooks: FakeCfHooks = {};
  /** Extra `cf curl` handlers, tried in order before the built-in API. */
  routes: FakeCfRoute[] = [];
  /** Extra cf subcommands by name, answered after the login checks. */
  commands: Map<string, FakeCfCommand> = new Map();
  url = "";
  private server: Server | null = null;
  private readonly shuttingDown = new Set<FakeCfApp>();
  private readonly shutdowns = new Set<Promise<void>>();

  constructor() {
    writeFileSync(join(this.bin, "cf"), `#!${process.execPath}\n${STUB}`);
    chmodSync(join(this.bin, "cf"), 0o755);
  }

  addApp(app: Partial<FakeCfApp> & { name: string; guid: string }): FakeCfApp {
    const full: FakeCfApp = { org: "example-org", space: "dev", state: "STARTED", instances: 1, running: 1, ready: 1, downAfter: 0, droplet: "d7c1a3e0-0000-4000-8000-000000000001", revision: { guid: "e2a4c6f8-0000-4000-8000-000000000003", version: 3 }, env: {}, events: [], logs: [], ...app };
    this.all.push(full);
    return full;
  }

  /** The app named `name` in `space` of the fake's org. */
  app(name: string, space = "dev"): FakeCfApp {
    const found = this.all.find((app) => app.name === name && app.space === space);
    if (found === undefined) throw new Error(`no app ${name} in ${space}`);
    return found;
  }

  /** The environment for a process that runs the stub as `cf`. */
  env(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { ...base, PATH: `${this.bin}${delimiter}${base.PATH ?? ""}`, CF_STUB_URL: this.url };
  }

  async listen(): Promise<void> {
    const server = createServer((request, response) => {
      const answer = async (): Promise<Answer> => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const parsed = boundaryCast<StubRequest>(JSON.parse(body), "json");
        this.calls.push(parsed.argv);
        this.colors.push(parsed.color);
        this.traces.push(parsed.trace);
        return this.handle(parsed.argv);
      };
      answer()
        .catch((cause: unknown): Answer => fail(cause instanceof Error ? cause.message : String(cause)))
        .then(
          (result) => response.end(JSON.stringify(result), () => this.track(result.after)),
          () => response.end(JSON.stringify(fail("stub failure"))),
        );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    this.url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`;
    this.server = server;
  }

  /** Resolves once every shutdown hook that was started has ended. */
  async idle(): Promise<void> {
    while (this.shutdowns.size > 0) await Promise.all(this.shutdowns);
  }

  async close(): Promise<void> {
    await this.idle();
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
    rmSync(this.bin, { recursive: true, force: true });
  }

  private track(after: (() => Promise<void>) | undefined): void {
    if (after === undefined) return;
    const running = after().catch(() => undefined);
    this.shutdowns.add(running);
    void running.then(() => this.shutdowns.delete(running));
  }

  private settle(app: FakeCfApp): void {
    if (app.state === "STOPPED" && app.downAfter === 0 && !this.shuttingDown.has(app)) Object.assign(app, { running: 0, ready: 0 });
  }

  private takeOne(counts: Map<string, number>, key: string): boolean {
    const left = counts.get(key) ?? 0;
    if (left === 0) return false;
    counts.set(key, left - 1);
    return true;
  }

  private byGuid(guid: string): FakeCfApp | undefined {
    return this.all.find((app) => app.guid === guid);
  }

  private inTarget(name: string): FakeCfApp | undefined {
    return this.all.find((app) => app.name === name && app.org === this.org && app.space === this.space);
  }

  private async handle(argv: string[]): Promise<Answer> {
    const [command, ...rest] = argv;
    const failure = this.failures.get(command ?? "");
    if (failure !== undefined) return { code: failure, stdout: "FAILED\n", stderr: `${command ?? ""} failed in the fake\n` };
    const pending = this.failNext.get(command ?? "") ?? 0;
    if (pending > 0) {
      this.failNext.set(command ?? "", pending - 1);
      return { code: 1, stdout: "FAILED\n", stderr: `${command ?? ""} failed once in the fake\n` };
    }
    if (!this.loggedIn) return fail("Not logged in. Use 'cf login' or 'cf login --sso' to log in.\n");
    if (command === "target") return { code: 0, stdout: `API endpoint:   https://api.example.test\nAPI version:    3.180.0\nuser:           operator\norg:            ${this.org}\nspace:          ${this.space}\n`, stderr: "" };
    if (this.sessionExpired) return fail("The token expired, was revoked, or the token ID is incorrect. Please log back in to re-authenticate.\n");
    const extra = this.commands.get(command ?? "");
    if (extra !== undefined) return extra(rest);
    switch (command) {
      case "app": {
        const app = this.inTarget(rest[0] ?? "");
        if (app === undefined) return fail(`App '${rest[0] ?? ""}' not found.\n`);
        return rest[1] === "--guid" ? { code: 0, stdout: `${app.guid}\n`, stderr: "" } : { code: 0, stdout: `name: ${app.name}\n`, stderr: "" };
      }
      case "curl":
        return this.curl(rest);
      case "logs": {
        const app = this.inTarget(rest[0] ?? "");
        return app === undefined ? fail("not found\n") : { code: 0, stdout: app.logs.map((line) => `${line}\n`).join(""), stderr: "" };
      }
      case "apply-manifest": {
        const manifest = rest[rest.indexOf("-f") + 1] ?? "";
        const varsFile = rest[rest.indexOf("--vars-file") + 1] ?? "";
        if (!existsSync(manifest) || !existsSync(varsFile)) return fail("manifest or vars file missing\n");
        const values: unknown = JSON.parse(readFileSync(varsFile, "utf8"));
        const unresolved = [...readFileSync(manifest, "utf8").matchAll(PLACEHOLDER)].map((m) => (m[1] ?? "").replace(/^!/, "")).filter((name) => name.split(".").reduce<unknown>((value, key) => (value === undefined ? undefined : Reflect.get(Object(value), key)), values) === undefined);
        if (unresolved.length > 0) return fail(`Expected to find variables: ${unresolved.join(", ")}\n`);
        this.applied.push({ manifest: readFileSync(manifest, "utf8"), varsFile, varsMode: statSync(varsFile).mode & 0o777, vars: readFileSync(varsFile, "utf8"), target: `${this.org}/${this.space}` });
        this.applyEntries(readFileSync(manifest, "utf8").replaceAll(PLACEHOLDER, (_match, name: string) => JSON.stringify(String(Reflect.get(Object(values), name.replace(/^!/, "")))).slice(1, -1)));
        return { code: 0, stdout: "OK\n", stderr: "" };
      }
      default:
        return fail(`'${command ?? ""}' is not a registered command.\n`);
    }
  }

  private applyEntries(text: string): void {
    const applications: unknown = Reflect.get(Object(JSON.parse(text)), "applications");
    for (const entry of Array.isArray(applications) ? applications : []) {
      const app = this.inTarget(String(Reflect.get(Object(entry), "name")));
      if (app === undefined) continue;
      const processes: unknown = Reflect.get(Object(entry), "processes");
      const web: unknown = Array.isArray(processes) ? processes.find((p: unknown) => Reflect.get(Object(p), "type") === "web") : undefined;
      const instances: unknown = Reflect.get(Object(web), "instances") ?? Reflect.get(Object(entry), "instances");
      if (typeof instances === "number") app.instances = instances;
      const env: unknown = Reflect.get(Object(entry), "env");
      if (typeof env === "object" && env !== null) for (const [name, value] of Object.entries(env)) app.env[name] = String(value);
    }
  }

  private async curl(args: string[]): Promise<Answer> {
    const path = args.find((arg) => arg.startsWith("/")) ?? "";
    const method = args.includes("-X") ? (args[args.indexOf("-X") + 1] ?? "GET") : "GET";
    const body = args.includes("-d") ? (args[args.indexOf("-d") + 1] ?? "") : "";
    const data = body.startsWith("@") ? readFileSync(body.slice(1), "utf8") : body;
    const url = new URL(path, "https://api.example.test");
    if (this.failingPaths.has(url.pathname)) return fail(`Request error: ${url.pathname}\n`);
    if (this.takeOne(this.killedPaths, url.pathname)) return { ...fail(""), signal: "SIGKILL" };
    if (this.takeOne(this.hungPaths, url.pathname)) return { ...fail(""), hangMs: 60_000 };
    const refused = timestampFilterError(url);
    if (refused !== null) return json({ errors: [{ code: 10005, title: "CF-BadQueryParameter", detail: refused }] });
    const parts = url.pathname.split("/").filter((p) => p !== "");
    const named = parts[1] === "apps" ? this.byGuid(parts[2] ?? "") : undefined;
    for (const route of this.routes) {
      const answer = await route({ method, url, data, app: named });
      if (answer !== undefined) return answer;
    }
    const notFound = json({ errors: [{ code: 10010, title: "CF-ResourceNotFound", detail: "not found" }] });
    if (parts[0] !== "v3") return notFound;
    if (parts[1] === "deployments") {
      const guids = (url.searchParams.get("app_guids") ?? "").split(",");
      const active = url.searchParams.get("status_values") === "ACTIVE";
      return json({ resources: guids.filter((g) => active && this.activeDeployments.has(g)).map((g) => ({ guid: `deployment-${g}`, strategy: "rolling", status: { value: "ACTIVE" } })) });
    }
    if (parts[1] === "audit_events") {
      const app = this.byGuid(url.searchParams.get("target_guids") ?? "");
      return json({ resources: (app?.events ?? []).filter((e) => passesCreatedAts(url, e.created_at)) });
    }
    if (parts[1] !== "apps") return notFound;
    const app = this.byGuid(parts[2] ?? "");
    if (app === undefined) return notFound;
    const tail = parts.slice(3).join("/");
    if (method === "POST" && (tail === "actions/stop" || tail === "actions/start")) return this.act(app, tail === "actions/stop" ? "stop" : "start");
    if (method === "PATCH" && tail === "relationships/current_droplet") {
      const guid: unknown = Reflect.get(Object(Reflect.get(Object(JSON.parse(data)), "data")), "guid");
      if (typeof guid !== "string") return apiError("CF-UnprocessableEntity");
      app.droplet = guid;
      this.actions.push({ app: app.name, space: app.space, action: "set-droplet" });
      return json({ data: { guid } });
    }
    if (method !== "GET") return apiError("CF-NotAuthorized");
    if (tail === "") return json({ guid: app.guid, name: app.name, state: app.state });
    if (tail === "processes/web") return json({ type: "web", instances: app.instances });
    if (tail === "processes/web/stats") {
      const total = Math.max(app.instances, app.running);
      const live = (index: number): string => (app.state === "STOPPED" ? this.stoppingState : index < app.ready ? "RUNNING" : "STARTING");
      const answer = json({ resources: Array.from({ length: total }, (_, index) => ({ type: "web", index, state: index < app.running ? live(index) : "DOWN" })) });
      if (app.downAfter > 0 && --app.downAfter === 0) this.settle(app);
      return answer;
    }
    if (tail === "droplets/current") return app.droplet === null ? notFound : json({ guid: app.droplet, state: "STAGED" });
    if (tail === "revisions") return json({ resources: app.revision === null ? [] : [{ ...app.revision, droplet: { guid: app.droplet } }] });
    if (tail === "environment_variables") return json({ var: app.env });
    return notFound;
  }

  private async act(app: FakeCfApp, action: "stop" | "start"): Promise<Answer> {
    if (this.rejectedActions.has(action)) return apiError("CF-UnprocessableEntity");
    this.actions.push({ app: app.name, space: app.space, action });
    if (action === "start") {
      await this.hooks.start?.(app);
      Object.assign(app, { state: "STARTED", running: app.instances, ready: app.instances, downAfter: 0 });
      app.events.unshift({ type: "audit.app.start", created_at: new Date().toISOString() });
      return this.lostAnswers.has(action) ? fail("Request error: connection reset\n") : json({ guid: app.guid, name: app.name, state: app.state });
    }
    app.state = "STOPPED";
    app.events.unshift({ type: "audit.app.stop", created_at: new Date().toISOString() });
    app.downAfter = app.running > 0 ? this.stopLag : 0;
    this.shuttingDown.add(app);
    const answer = this.lostAnswers.has(action) ? fail("Request error: connection reset\n") : json({ guid: app.guid, name: app.name, state: app.state });
    const shutdown = async (): Promise<void> => {
      try {
        await this.hooks.stop?.(app);
      } finally {
        this.shuttingDown.delete(app);
        this.settle(app);
      }
    };
    return { ...answer, after: shutdown };
  }
}
