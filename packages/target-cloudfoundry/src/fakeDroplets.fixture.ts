import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fakeJson, type FakeCfAnswer, type FakeCloudFoundry, type FakeCfApp, type FakeCfRequest } from "./fakeCloudFoundry.fixture.ts";

/** One droplet the fake platform holds. */
export interface FakeDroplet {
  guid: string;
  app: string;
  state: "AWAITING_UPLOAD" | "STAGED" | "FAILED";
  createdAt: string;
  processTypes: Record<string, string>;
  bits: string;
}

/** The web process of an app as the fake platform holds it. */
export interface FakeProcess {
  guid: string;
  command: string | null;
  memoryMb: number;
  diskMb: number;
  healthCheck: { type: string; endpoint: string | null; timeout: number | null; invocationTimeout: number | null };
}

/** One revision of an app as the fake platform holds it. */
export interface FakeRevision {
  guid: string;
  version: number;
  droplet: string;
  createdAt: string;
}

const notFound = (): FakeCfAnswer => fakeJson({ errors: [{ code: 10010, title: "CF-ResourceNotFound", detail: "not found" }] });
const unprocessable = (detail: string): FakeCfAnswer => fakeJson({ errors: [{ code: 10008, title: "CF-UnprocessableEntity", detail }] });

const field = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((at, key) => (typeof at === "object" && at !== null ? Reflect.get(at, key) : undefined), value);

/**
 * Droplets, revisions, the web process and environment updates of the fake platform, as extra routes and a
 * `download-droplet` subcommand of a {@link FakeCloudFoundry}. `bodies` records every request body the routes read,
 * `downloads` whether the platform hands out droplet bits.
 */
export class FakeDroplets {
  readonly droplets = new Map<string, FakeDroplet>();
  readonly revisions = new Map<string, FakeRevision[]>();
  readonly processes = new Map<string, FakeProcess>();
  readonly bodies: Array<{ method: string; path: string; data: string }> = [];
  downloads: boolean = true;
  private clock = Date.parse("2026-11-01T08:00:00Z");

  constructor(readonly cf: FakeCloudFoundry) {
    cf.routes.push((request) => this.route(request));
    cf.commands.set("download-droplet", (args) => this.download(args));
  }

  private stamp(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  /** Adds a staged droplet of `app`; `current` makes it the app's current droplet and records a revision for it. */
  addDroplet(app: FakeCfApp, options: { guid?: string; current?: boolean; bits?: string; processTypes?: Record<string, string> } = {}): FakeDroplet {
    const droplet: FakeDroplet = { guid: options.guid ?? randomUUID(), app: app.guid, state: "STAGED", createdAt: this.stamp(), processTypes: options.processTypes ?? { web: "node .output/server/index.mjs" }, bits: options.bits ?? `bits of droplet ${this.droplets.size + 1}` };
    this.droplets.set(droplet.guid, droplet);
    if (options.current === true) {
      app.droplet = droplet.guid;
      const revisions = this.revisions.get(app.guid) ?? [];
      revisions.push({ guid: randomUUID(), version: revisions.length + 1, droplet: droplet.guid, createdAt: this.stamp() });
      this.revisions.set(app.guid, revisions);
    }
    return droplet;
  }

  /** The web process of `app`, created with the platform's defaults on first use. */
  process(app: FakeCfApp): FakeProcess {
    const known = this.processes.get(app.guid);
    if (known !== undefined) return known;
    const created: FakeProcess = { guid: randomUUID(), command: null, memoryMb: 1024, diskMb: 2048, healthCheck: { type: "port", endpoint: null, timeout: null, invocationTimeout: null } };
    this.processes.set(app.guid, created);
    return created;
  }

  private processJson(app: FakeCfApp): unknown {
    const p = this.process(app);
    const data: Record<string, unknown> = { timeout: p.healthCheck.timeout, invocation_timeout: p.healthCheck.invocationTimeout };
    if (p.healthCheck.type === "http") data.endpoint = p.healthCheck.endpoint;
    return { guid: p.guid, type: "web", command: p.command, instances: app.instances, memory_in_mb: p.memoryMb, disk_in_mb: p.diskMb, health_check: { type: p.healthCheck.type, data } };
  }

  private dropletJson(d: FakeDroplet): unknown {
    return { guid: d.guid, state: d.state, created_at: d.createdAt, process_types: d.processTypes, links: { app: { href: `https://api.example.test/v3/apps/${d.app}` } } };
  }

  private route(request: FakeCfRequest): FakeCfAnswer | undefined {
    const { method, url, data, app } = request;
    const parts = url.pathname.split("/").filter((p) => p !== "");
    if (method !== "GET") this.bodies.push({ method, path: url.pathname, data });
    if (parts[1] === "apps" && app !== undefined) {
      const tail = parts.slice(3).join("/");
      if (method === "GET" && tail === "droplets") return fakeJson({ pagination: { next: null }, resources: [...this.droplets.values()].filter((d) => d.app === app.guid).map((d) => this.dropletJson(d)) });
      if (method === "GET" && tail === "revisions" && this.revisions.has(app.guid)) {
        const all = (this.revisions.get(app.guid) ?? []).map((r) => ({ guid: r.guid, version: r.version, created_at: r.createdAt, droplet: { guid: r.droplet } }));
        const newestFirst = url.searchParams.get("order_by") === "-created_at";
        const ordered = newestFirst ? [...all].reverse() : all;
        const perPage = Number(url.searchParams.get("per_page") ?? "50");
        return fakeJson({ pagination: { next: null }, resources: ordered.slice(0, perPage) });
      }
      if (method === "GET" && tail === "processes/web") return fakeJson(this.processJson(app));
      if (method === "PATCH" && tail === "environment_variables") {
        const vars = field(JSON.parse(data), "var");
        if (typeof vars !== "object" || vars === null) return unprocessable("var must be an object");
        for (const [name, value] of Object.entries(vars)) {
          if (value === null) delete app.env[name];
          else app.env[name] = String(value);
        }
        return fakeJson({ var: app.env });
      }
      return undefined;
    }
    if (parts[1] === "processes") {
      const entry = [...this.processes.entries()].find(([, p]) => p.guid === parts[2]);
      if (entry === undefined) return notFound();
      const [appGuid, p] = entry;
      const owner = this.cf.all.find((a) => a.guid === appGuid);
      if (owner === undefined) return notFound();
      const body: unknown = data === "" ? {} : JSON.parse(data);
      if (method === "PATCH" && parts.length === 3) {
        const command = field(body, "command");
        if (command !== undefined) p.command = typeof command === "string" ? command : null;
        const health = field(body, "health_check");
        if (health !== undefined) {
          const type = field(health, "type");
          const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
          const endpoint = field(health, "data", "endpoint");
          p.healthCheck = { type: typeof type === "string" ? type : p.healthCheck.type, endpoint: typeof endpoint === "string" ? endpoint : null, timeout: num(field(health, "data", "timeout")), invocationTimeout: num(field(health, "data", "invocation_timeout")) };
        }
        return fakeJson(this.processJson(owner));
      }
      if (method === "POST" && parts[3] === "actions" && parts[4] === "scale") {
        const memory = field(body, "memory_in_mb");
        const disk = field(body, "disk_in_mb");
        const instances = field(body, "instances");
        if (typeof memory === "number") p.memoryMb = memory;
        if (typeof disk === "number") p.diskMb = disk;
        if (typeof instances === "number") owner.instances = instances;
        return fakeJson(this.processJson(owner));
      }
      return notFound();
    }
    if (parts[1] !== "droplets") return undefined;
    if (method === "POST" && parts.length === 2) {
      const appGuid = field(JSON.parse(data), "relationships", "app", "data", "guid");
      const types = field(JSON.parse(data), "process_types");
      if (typeof appGuid !== "string" || this.cf.all.every((a) => a.guid !== appGuid)) return unprocessable("app not found");
      const droplet: FakeDroplet = { guid: randomUUID(), app: appGuid, state: "AWAITING_UPLOAD", createdAt: this.stamp(), processTypes: typeof types === "object" && types !== null ? Object.fromEntries(Object.entries(types).map(([k, v]) => [k, String(v)])) : {}, bits: "" };
      this.droplets.set(droplet.guid, droplet);
      return fakeJson(this.dropletJson(droplet));
    }
    const droplet = this.droplets.get(parts[2] ?? "");
    if (droplet === undefined) return notFound();
    if (method === "GET" && parts.length === 3) return fakeJson(this.dropletJson(droplet));
    if (method === "DELETE" && parts.length === 3) {
      const owner = this.cf.all.find((a) => a.guid === droplet.app);
      if (owner?.droplet === droplet.guid) return unprocessable("the current droplet of an app cannot be deleted");
      this.droplets.delete(droplet.guid);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (method === "POST" && parts[3] === "upload") {
      const marker = "\r\n\r\n";
      const start = data.indexOf(marker);
      const end = data.lastIndexOf("\r\n--");
      if (start < 0 || end < start) return unprocessable("no multipart body");
      droplet.bits = data.slice(start + marker.length, end);
      droplet.state = "STAGED";
      return fakeJson(this.dropletJson(droplet));
    }
    return notFound();
  }

  private download(args: string[]): FakeCfAnswer {
    const app = this.cf.all.find((a) => a.name === args[0] && a.org === this.cf.org && a.space === this.cf.space);
    const guid = args[args.indexOf("--droplet") + 1] ?? "";
    const path = args[args.indexOf("--path") + 1] ?? "";
    const droplet = this.droplets.get(guid);
    if (app === undefined || droplet === undefined || droplet.app !== app.guid) return { code: 1, stdout: "FAILED\n", stderr: "Droplet not found\n" };
    if (!this.downloads) return { code: 1, stdout: "FAILED\n", stderr: "Downloading droplets is not supported by this platform\n" };
    writeFileSync(path, droplet.bits);
    return { code: 0, stdout: `Droplet downloaded successfully at ${path}\nOK\n`, stderr: "" };
  }

  /** The bits a file written by the target holds after its header, as text. */
  static bitsOf(file: string): string {
    const text = readFileSync(file, "utf8");
    return text.slice(text.indexOf("\n") + 1);
  }
}
