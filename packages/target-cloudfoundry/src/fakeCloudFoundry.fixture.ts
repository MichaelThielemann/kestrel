import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";

/** One app in the fake space. */
export interface FakeCfApp {
  name: string;
  guid: string;
  state: "STARTED" | "STOPPED";
  /** The web process's desired instance count. */
  instances: number;
  /** Instances whose state is not DOWN. */
  running: number;
  /** Instances that reached RUNNING; the rest of `running` are STARTING. */
  ready: number;
  droplet: string | null;
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
}

/** Hooks that run inside `cf start` and `cf stop`, before the call returns. */
export interface FakeCfHooks {
  start?(app: FakeCfApp): Promise<void>;
  stop?(app: FakeCfApp): Promise<void>;
}

interface Answer {
  code: number;
  stdout: string;
  stderr: string;
}

const STUB = `import { argv, env, exit, stdout, stderr } from "node:process";
const response = await fetch(env.CF_STUB_URL, { method: "POST", body: JSON.stringify({ argv: argv.slice(2), color: env.CF_COLOR ?? null }) });
const answer = await response.json();
stdout.write(answer.stdout);
stderr.write(answer.stderr);
exit(answer.code);
`;

const json = (value: unknown): Answer => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const fail = (stderr: string): Answer => ({ code: 1, stdout: "FAILED\n", stderr });

/**
 * A Cloud Foundry space in the test process, reached through a stub `cf` executable that forwards its argv over
 * HTTP. Put {@link FakeCloudFoundry.bin} first on `PATH` and {@link FakeCloudFoundry.url} into `CF_STUB_URL`.
 */
export class FakeCloudFoundry {
  readonly bin = mkdtempSync(join(tmpdir(), "kestrel-cf-stub-"));
  readonly calls: string[][] = [];
  readonly colors: Array<string | null> = [];
  readonly applied: AppliedManifest[] = [];
  readonly apps = new Map<string, FakeCfApp>();
  org = "example-org";
  space = "dev";
  loggedIn = true;
  activeDeployments = new Set<string>();
  /** The exit code a cf subcommand answers with instead of doing its work. */
  failures: Map<string, number> = new Map();
  hooks: FakeCfHooks = {};
  url = "";
  private server: Server | null = null;

  constructor() {
    writeFileSync(join(this.bin, "cf"), `#!${process.execPath}\n${STUB}`);
    chmodSync(join(this.bin, "cf"), 0o755);
  }

  addApp(app: Partial<FakeCfApp> & { name: string; guid: string }): FakeCfApp {
    const full: FakeCfApp = { state: "STARTED", instances: 1, running: 1, ready: 1, droplet: "d7c1a3e0-0000-4000-8000-000000000001", env: {}, events: [], logs: [], ...app };
    this.apps.set(full.name, full);
    return full;
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
        const parsed = boundaryCast<{ argv: string[]; color: string | null }>(JSON.parse(body), "json");
        this.calls.push(parsed.argv);
        this.colors.push(parsed.color);
        return this.handle(parsed.argv);
      };
      answer()
        .catch((cause: unknown): Answer => fail(cause instanceof Error ? cause.message : String(cause)))
        .then((result) => response.end(JSON.stringify(result)), () => response.end(JSON.stringify(fail("stub failure"))));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    this.url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`;
    this.server = server;
  }

  async close(): Promise<void> {
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
    rmSync(this.bin, { recursive: true, force: true });
  }

  private byGuid(guid: string): FakeCfApp | undefined {
    return [...this.apps.values()].find((app) => app.guid === guid);
  }

  private async handle(argv: string[]): Promise<Answer> {
    const [command, ...rest] = argv;
    const failure = this.failures.get(command ?? "");
    if (failure !== undefined) return { code: failure, stdout: "FAILED\n", stderr: `${command ?? ""} failed in the fake\n` };
    if (!this.loggedIn) return fail("Not logged in. Use 'cf login' or 'cf login --sso' to log in.\n");
    switch (command) {
      case "target":
        return { code: 0, stdout: `API endpoint:   https://api.example.test\nAPI version:    3.180.0\nuser:           operator\norg:            ${this.org}\nspace:          ${this.space}\n`, stderr: "" };
      case "app": {
        const app = this.apps.get(rest[0] ?? "");
        if (app === undefined) return fail(`App '${rest[0] ?? ""}' not found.\n`);
        return rest[1] === "--guid" ? { code: 0, stdout: `${app.guid}\n`, stderr: "" } : { code: 0, stdout: `name: ${app.name}\n`, stderr: "" };
      }
      case "curl":
        return this.curl(rest[0] ?? "");
      case "stop": {
        const app = this.apps.get(rest[0] ?? "");
        if (app === undefined) return fail("not found\n");
        await this.hooks.stop?.(app);
        app.state = "STOPPED";
        app.running = 0;
        app.ready = 0;
        app.events.unshift({ type: "audit.app.stop", created_at: new Date().toISOString() });
        return { code: 0, stdout: `Stopping app ${app.name}...\nOK\n`, stderr: "" };
      }
      case "start": {
        const app = this.apps.get(rest[0] ?? "");
        if (app === undefined) return fail("not found\n");
        await this.hooks.start?.(app);
        app.state = "STARTED";
        app.running = app.instances;
        app.ready = app.instances;
        app.events.unshift({ type: "audit.app.start", created_at: new Date().toISOString() });
        return { code: 0, stdout: `Starting app ${app.name}...\n`, stderr: "" };
      }
      case "logs": {
        const app = this.apps.get(rest[0] ?? "");
        return app === undefined ? fail("not found\n") : { code: 0, stdout: app.logs.map((line) => `${line}\n`).join(""), stderr: "" };
      }
      case "set-droplet": {
        const app = this.apps.get(rest[0] ?? "");
        if (app === undefined) return fail("not found\n");
        app.droplet = rest[1] ?? null;
        return { code: 0, stdout: "OK\n", stderr: "" };
      }
      case "apply-manifest": {
        const manifest = rest[rest.indexOf("-f") + 1] ?? "";
        const varsFile = rest[rest.indexOf("--vars-file") + 1] ?? "";
        if (!existsSync(manifest) || !existsSync(varsFile)) return fail("manifest or vars file missing\n");
        this.applied.push({ manifest: readFileSync(manifest, "utf8"), varsFile, varsMode: statSync(varsFile).mode & 0o777, vars: readFileSync(varsFile, "utf8") });
        return { code: 0, stdout: "OK\n", stderr: "" };
      }
      default:
        return fail(`'${command ?? ""}' is not a registered command.\n`);
    }
  }

  private curl(path: string): Answer {
    const url = new URL(path, "https://api.example.test");
    const parts = url.pathname.split("/").filter((p) => p !== "");
    const notFound = json({ errors: [{ code: 10010, title: "CF-ResourceNotFound", detail: "not found" }] });
    if (parts[0] !== "v3") return notFound;
    if (parts[1] === "deployments") {
      const guids = (url.searchParams.get("app_guids") ?? "").split(",");
      const active = url.searchParams.get("status_values") === "ACTIVE";
      return json({ resources: guids.filter((g) => active && this.activeDeployments.has(g)).map((g) => ({ guid: `deployment-${g}`, strategy: "rolling", status: { value: "ACTIVE" } })) });
    }
    if (parts[1] === "audit_events") {
      const app = this.byGuid(url.searchParams.get("target_guids") ?? "");
      return json({ resources: app?.events ?? [] });
    }
    if (parts[1] !== "apps") return notFound;
    const app = this.byGuid(parts[2] ?? "");
    if (app === undefined) return notFound;
    const tail = parts.slice(3).join("/");
    if (tail === "") return json({ guid: app.guid, name: app.name, state: app.state });
    if (tail === "processes/web") return json({ type: "web", instances: app.instances });
    if (tail === "processes/web/stats") {
      const total = Math.max(app.instances, app.running);
      return json({ resources: Array.from({ length: total }, (_, index) => ({ type: "web", index, state: index < app.ready ? "RUNNING" : index < app.running ? "STARTING" : "DOWN" })) });
    }
    if (tail === "droplets/current") return app.droplet === null ? notFound : json({ guid: app.droplet, state: "STAGED" });
    if (tail === "environment_variables") return json({ var: app.env });
    return notFound;
  }
}
