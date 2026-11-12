import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, type JsonSchema, type Kestrel, type Manifest, type NarrowsDeclaration } from "@michaelthielemann/kestrel";
import { anonymousPipelines, type Config } from "@michaelthielemann/kestrel-authz-roles/impl";
import { generateOpenApi } from "@michaelthielemann/kestrel-openapi";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { KestrelConfigInput } from "@michaelthielemann/kestrel/defineConfig";
import { definePipeline, pipelineSteps } from "@michaelthielemann/kestrel/definePipeline";
import { loadConfig, loadModules, loadPipelines } from "@michaelthielemann/kestrel/load";
import { isErr } from "@michaelthielemann/kestrel/result";
import { resolveOutputSchema, validateSchema } from "@michaelthielemann/kestrel/schema";

const root = dirname(fileURLToPath(import.meta.url));
const TEST_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=",
  "base64",
);
const SENTINELS = ["SENTINEL-EN-DRAFT", "SENTINEL-DRAFT-PAGE", "sentinel-folder"];
const CORE_FILE_HEADERS = new Set(["x-content-type-options", "cache-control", "x-kestrel-run-id", "x-request-id", "content-type", "content-length", "content-disposition", "content-security-policy", "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-expose-headers", "vary", "date", "connection", "keep-alive", "transfer-encoding"]);

type Grant = Map<string, Grant | true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function grantOf(paths: readonly string[]): Grant {
  const tree: Grant = new Map();
  for (const path of paths) {
    const names = path.split(".").map((name) => name.replace(/\[\]$/, ""));
    let node = tree;
    for (const [index, name] of names.entries()) {
      const existing = node.get(name);
      if (existing === true) break;
      if (index === names.length - 1) {
        node.set(name, true);
        break;
      }
      const next: Grant = existing ?? new Map<string, Grant | true>();
      node.set(name, next);
      node = next;
    }
  }
  return tree;
}

function outside(value: unknown, grant: Grant, at: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((element, index) => outside(element, grant, `${at}[${index}]`, found));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, member] of Object.entries(value)) {
    const path = at === "" ? key : `${at}.${key}`;
    const granted = grant.get(key);
    if (granted === undefined) found.push(path);
    else if (granted !== true) outside(member, granted, path, found);
  }
}

function membersOutsideGrant(answer: unknown, shape: NarrowsDeclaration["shape"], grant: Grant): string[] {
  const found: string[] = [];
  if (shape === "list" && isRecord(answer)) {
    for (const [key, member] of Object.entries(answer)) {
      if (key === "items" && Array.isArray(member)) member.forEach((item, index) => outside(item, grant, `items[${index}]`, found));
      else if (key !== "total") found.push(key);
    }
    return found;
  }
  outside(answer, grant, "", found);
  return found;
}

function project(value: unknown, grant: Grant): unknown {
  if (Array.isArray(value)) return value.map((element) => project(element, grant));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, member]) => {
      const granted = grant.get(key);
      if (granted === undefined) return [];
      return [[key, granted === true ? member : project(member, granted)]];
    }),
  );
}

function projectAnswer(answer: unknown, shape: NarrowsDeclaration["shape"], grant: Grant): unknown {
  if (shape !== "list" || !isRecord(answer)) return project(answer, grant);
  return { items: Array.isArray(answer.items) ? answer.items.map((item) => project(item, grant)) : [], total: answer.total };
}

function contains(whole: unknown, part: unknown): boolean {
  if (Array.isArray(part)) return Array.isArray(whole) && whole.length === part.length && part.every((element, index) => contains(whole[index], element));
  if (isRecord(part)) return isRecord(whole) && Object.entries(part).every(([key, member]) => Object.hasOwn(whole, key) && contains(whole[key], member));
  return Object.is(whole, part);
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Generator {
  next: () => number;
  extras: number;
}

function pick<T>(g: Generator, list: readonly T[]): T {
  return list[Math.floor(g.next() * list.length)]!;
}

function anyJson(g: Generator, depth: number): unknown {
  const kind = depth > 2 ? pick(g, ["string", "number"]) : pick(g, ["string", "number", "object", "array", "null"]);
  if (kind === "string") return `v${Math.floor(g.next() * 100)}`;
  if (kind === "number") return Math.floor(g.next() * 100);
  if (kind === "null") return null;
  if (kind === "array") return [anyJson(g, depth + 1), anyJson(g, depth + 1)];
  return { [`k${Math.floor(g.next() * 10)}`]: anyJson(g, depth + 1) };
}

function valueOf(schema: JsonSchema, g: Generator, depth = 0): unknown {
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union !== undefined) return valueOf(boundaryCast<JsonSchema>(pick(g, union), "json"), g, depth);
  if (Array.isArray(schema.enum)) return pick(g, schema.enum);
  const declared: unknown = schema.type;
  const types = Array.isArray(declared) ? declared.filter((t): t is string => typeof t === "string") : typeof declared === "string" ? [declared] : [];
  const type = types.length === 0 ? (isRecord(schema.properties) ? "object" : "any") : pick(g, types);
  if (type === "any") return anyJson(g, depth);
  if (type === "null") return null;
  if (type === "string") return typeof schema.pattern === "string" ? "a1" : `s${Math.floor(g.next() * 1000)}`;
  if (type === "number" || type === "integer") return Math.floor(g.next() * 1000);
  if (type === "boolean") return g.next() < 0.5;
  if (type === "array") return depth > 5 || !isRecord(schema.items) ? [] : Array.from({ length: Math.floor(g.next() * 3) + 1 }, () => valueOf(boundaryCast<JsonSchema>(schema.items, "json"), g, depth + 1));
  const value: Record<string, unknown> = {};
  if (isRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const [key, member] of Object.entries(schema.properties)) {
      if (!required.includes(key) && g.next() < 0.3) continue;
      value[key] = valueOf(boundaryCast<JsonSchema>(member, "json"), g, depth + 1);
    }
    value[`x_extra_${g.extras++}`] = depth > 4 ? "x" : anyJson(g, depth + 1);
  } else if (isRecord(schema.additionalProperties)) {
    for (let i = 0; i < 2; i++) value[`m${i}`] = valueOf(schema.additionalProperties, g, depth + 1);
  }
  return value;
}

async function bootExample(withPipelines?: (pipelines: Awaited<ReturnType<typeof loadPipelines>>) => Awaited<ReturnType<typeof loadPipelines>>): Promise<{ kestrel: Kestrel; config: KestrelConfigInput; base: string; dispose: () => Promise<void> }> {
  const loaded = await loadConfig(join(root, "kestrel.config.ts"));
  const dataDir = mkdtempSync(join(tmpdir(), "kestrel-minimal-anonymous-"));
  const config: KestrelConfigInput = {
    ...loaded,
    http: { ...boundaryCast<Record<string, unknown>>(loaded.http, "host"), port: 0, host: "127.0.0.1" },
    modules: loaded.modules.map((m) => {
      const own = boundaryCast<Record<string, unknown>>(m.config, "host");
      if (m.use === "@michaelthielemann/kestrel-persistence-sqlite") return { ...m, config: { ...own, file: ":memory:" } };
      if (m.use === "@michaelthielemann/kestrel-replication-sqlite") return { ...m, config: { ...own, file: join(dataDir, "replication.db") } };
      if (m.use === "@michaelthielemann/kestrel-blobstore-filesystem") return { ...m, config: { ...own, root: join(dataDir, "blobs") } };
      return m;
    }),
  };
  const modules = await loadModules(root, config);
  const pipelines = await loadPipelines(root, "pipelines");
  const dispose = () => Promise.resolve(rmSync(dataDir, { recursive: true, force: true }));
  let kestrel: Kestrel;
  try {
    kestrel = await boot({ config, modules, pipelines: withPipelines ? withPipelines(pipelines) : pipelines, root, validateOutput: true });
  } catch (error) {
    await dispose();
    throw error;
  }
  const started = await kestrel.start();
  return {
    kestrel,
    config,
    base: `http://127.0.0.1:${started.http?.port ?? 0}`,
    dispose: async () => {
      await kestrel.stop();
      await dispose();
    },
  };
}

function authzConfig(config: KestrelConfigInput): Config {
  const entry = config.modules.find((m) => m.use === "@michaelthielemann/kestrel-authz-roles");
  const own = boundaryCast<{ roles: Record<string, string[]>; anonymous?: string[]; anonymousFields?: Record<string, string[]> }>(entry?.config, "host");
  return { roles: own.roles, roleClaim: "roles", anonymous: own.anonymous ?? [], anonymousFields: own.anonymousFields ?? {}, fields: {} };
}

function cutOf(manifest: Manifest, pipeline: string): { spec: string; narrows: NarrowsDeclaration; fold: JsonSchema | undefined } {
  const steps = manifest.pipelines.find((p) => p.name === pipeline)!.steps;
  const last = steps.at(-1)!;
  expect(last.name, pipeline).toBe("authz.fields");
  return { spec: last.spec, narrows: last.description.narrows!, fold: resolveOutputSchema(steps.map((s) => s.description)) };
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
}

async function request(base: string, method: string, path: string, options: { token?: string; json?: unknown; form?: FormData } = {}): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.json !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, { method, headers, ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : options.form !== undefined ? { body: options.form } : {}) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("latin1");
  const json: unknown = (response.headers.get("content-type") ?? "").startsWith("application/json") ? JSON.parse(bytes.toString("utf8")) : undefined;
  return { status: response.status, headers: Object.fromEntries(response.headers), text, json };
}

async function ok(base: string, method: string, path: string, options: Parameters<typeof request>[3]): Promise<Record<string, unknown>> {
  const answer = await request(base, method, path, options);
  expect(answer.status, `${method} ${path}: ${answer.text}`).toBe(200);
  return boundaryCast<Record<string, unknown>>(answer.json, "json");
}

interface Seeded {
  token: string;
  homeId: string;
  programmId: string;
  draftId: string;
  mediaId: string;
  mediaName: string;
  variantFiles: string[];
}

async function seed(base: string): Promise<Seeded> {
  const token = String((await ok(base, "POST", "/login", { json: { username: "admin", password: "kestrel-demo" } })).token);
  const form = new FormData();
  form.set("folder", "sentinel-folder");
  form.set("provenance", "ai");
  form.set("file", new Blob([TEST_JPEG], { type: "image/jpeg" }), "photo.jpg");
  const media = await ok(base, "POST", "/media", { token, form });
  const mediaId = String(media.id);
  const draftId = String((await ok(base, "POST", "/pages", { token, json: { slug: "entwurf", title: "SENTINEL-DRAFT-PAGE", status: "draft", locale: "de" } })).id);
  const programmId = String((await ok(base, "POST", "/pages", { token, json: { slug: "programm", title: "Programm", status: "published", locale: "de" } })).id);
  const body = [{ type: "prose", props: { body: `<p><a href="kestrel:pages:${programmId}">Programm</a> <a href="kestrel:pages:${draftId}">Entwurf</a></p>` } }];
  const homeId = String((await ok(base, "POST", "/pages", { token, json: { slug: "home", title: "Start", status: "published", hero: mediaId, seo: { title: "Start" }, body, locale: "de" } })).id);
  await ok(base, "PATCH", `/pages/${homeId}`, { token, json: { locale: "en", slug: "home", title: "SENTINEL-EN-DRAFT", status: "draft" } });
  await ok(base, "PUT", "/settings", { token, json: { locale: "de", title: "Seite", description: "Beschreibung", navigation: [{ label: "Start", path: "/" }] } });
  await ok(base, "PUT", "/redirects", { token, json: { rules: [{ from: "/alt", to: "/programm" }] } });
  await ok(base, "PATCH", `/pages/${homeId}`, { token, json: { locale: "en", title: "SENTINEL-EN-DRAFT" } });
  const item = await ok(base, "GET", `/media/${mediaId}`, { token });
  const variants = boundaryCast<Array<{ path: string }>>(item.variants, "json");
  const fileOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  return { token, homeId, programmId, draftId, mediaId, mediaName: fileOf(String(item.path)), variantFiles: variants.map((variant) => fileOf(variant.path)) };
}

function requestsFor(s: Seeded): Record<string, string[]> {
  return {
    "GET /settings": ["/settings", "/settings?locale=en"],
    "GET /redirects.json": ["/redirects.json"],
    "GET /site/*path": ["/site/", "/site/en", "/site/programm", "/site/alt", "/site/entwurf"],
    "GET /pages": ["/pages", "/pages?locale=en"],
    "GET /pages/:id": [`/pages/${s.homeId}`, `/pages/${s.homeId}?locale=en`, `/pages/${s.programmId}`, `/pages/${s.draftId}`],
    "GET /media": [`/media?ids=${s.mediaId}`],
    "GET /media/:id": [`/media/${s.mediaId}`],
    "GET /media/:id/file": [`/media/${s.mediaId}/file`],
    "GET /media/:id/variants/:file": s.variantFiles.map((file) => `/media/${s.mediaId}/variants/${file}`),
    "GET /media/:id/:name": [`/media/${s.mediaId}/${s.mediaName}`],
  };
}

describe("examples/minimal: what a caller without an identity receives", () => {
  let example: Awaited<ReturnType<typeof bootExample>> | undefined;
  let manifest: Manifest;
  let config: Config;
  let openapi: { paths: Record<string, Record<string, { operationId: string; responses: Record<string, Record<string, unknown>> }>>; components: { schemas: Record<string, JsonSchema> } };

  beforeAll(async () => {
    const booted = await bootExample();
    example = booted;
    manifest = booted.kestrel.describe();
    config = authzConfig(booted.config);
    openapi = boundaryCast<typeof openapi>(generateOpenApi(booted.kestrel, { title: "t", version: "1" }), "json");
  });

  function booted(): Awaited<ReturnType<typeof bootExample>> {
    if (example === undefined) throw new Error("the example did not boot");
    return example;
  }
  afterAll(async () => {
    await example?.dispose();
  });

  function grantFor(spec: string): Grant {
    const resource = spec.slice("authz.fields:".length).split("?")[0]!;
    const paths = config.anonymousFields?.[resource];
    expect(paths, resource).toBeDefined();
    return grantOf(paths ?? []);
  }

  it("keeps nothing outside the anonymous grant of a random answer any public read can declare, and every granted member", async () => {
    const pipelines = anonymousPipelines(config, manifest).filter((p) => cutOf(manifest, p.name).narrows.shape !== "file");
    expect(pipelines.map((p) => p.name).sort()).toEqual(["getMedia", "getSettings", "listMedia", "listPages", "readPage", "renderRedirects", "resolvePage"]);
    for (const pipeline of pipelines) {
      const { spec, narrows, fold } = cutOf(manifest, pipeline.name);
      const grant = grantFor(spec);
      const step = booted().kestrel.steps.resolve(spec).fn;
      const schema = openapi.components.schemas[`${pipeline.name}.anonymous`];
      if (fold === undefined || schema === undefined) throw new Error(`${pipeline.name}: no declared answer`);
      for (let run = 0; run < 40; run++) {
        const g: Generator = { next: random(run * 7919 + pipeline.name.length), extras: 0 };
        const value = valueOf(fold, g);
        expect(g.extras, pipeline.name).toBeGreaterThan(0);
        const cut = await step({ ...createContext({ trigger: { kind: "http", name: "GET /x" } }), result: value });
        if (isErr(cut)) throw new Error(cut.error.message);
        const answer = cut.value.result;
        const label = `${pipeline.name} run ${run}`;
        expect(membersOutsideGrant(answer, narrows.shape, grant), label).toEqual([]);
        expect(answer, label).toEqual(projectAnswer(value, narrows.shape, grant));
        expect(validateSchema(schema, answer), label).toEqual([]);
      }
    }
  });

  it("answers every public read over HTTP with nothing outside its grant, and a signed-in caller a superset of it", async () => {
    const { base } = booted();
    const seeded = await seed(base);
    const table = requestsFor(seeded);
    const answered = new Set<string>();
    for (const pipeline of anonymousPipelines(config, manifest)) {
      const { spec, narrows } = cutOf(manifest, pipeline.name);
      const grant = grantFor(spec);
      const routes = manifest.triggers.http.filter((route) => route.pipeline === pipeline.name);
      expect(routes.length, pipeline.name).toBeGreaterThan(0);
      for (const route of routes) {
        const paths = table[`${route.method} ${route.path}`];
        if (paths === undefined) throw new Error(`no request for ${route.method} ${route.path}, which anonymous callers reach through "${pipeline.name}"`);
        for (const path of paths) {
          const anonymous = await request(base, route.method, path);
          const signedIn = await request(base, route.method, path, { token: seeded.token });
          const label = `${route.method} ${path}`;
          for (const sentinel of SENTINELS) {
            expect(anonymous.text, `${label} body`).not.toContain(sentinel);
            expect(JSON.stringify(anonymous.headers), `${label} headers`).not.toContain(sentinel);
          }
          if (anonymous.status !== 200) {
            expect(anonymous.status, label).toBeGreaterThanOrEqual(300);
            continue;
          }
          answered.add(pipeline.name);
          const response = openapi.paths[route.path.replace(/[:*](\w+)/g, "{$1}")]?.[route.method.toLowerCase()]?.responses["200"];
          const answers = boundaryCast<Record<string, { $ref?: string; headers?: string[] }>>(response?.["x-kestrel-answers"], "json");
          if (narrows.shape === "file") {
            const granted = new Set(answers.anonymous?.headers ?? []);
            const extra = Object.keys(anonymous.headers).filter((name) => !CORE_FILE_HEADERS.has(name) && !granted.has(name));
            expect(extra, label).toEqual([]);
            expect(signedIn.status, label).toBe(200);
            for (const [name, value] of Object.entries(anonymous.headers)) if (granted.has(name)) expect(signedIn.headers[name], `${label} ${name}`).toBe(value);
            continue;
          }
          const component = (answers.anonymous?.$ref ?? "").replace("#/components/schemas/", "");
          const anonymousSchema = openapi.components.schemas[component];
          const fullSchema = openapi.components.schemas[openapi.paths[route.path.replace(/[:*](\w+)/g, "{$1}")]![route.method.toLowerCase()]!.operationId];
          if (anonymousSchema === undefined || fullSchema === undefined) throw new Error(`${label}: no documented answers`);
          expect(validateSchema(anonymousSchema, anonymous.json), label).toEqual([]);
          expect(membersOutsideGrant(anonymous.json, narrows.shape, grant), label).toEqual([]);
          expect(signedIn.status, label).toBe(200);
          expect(validateSchema(fullSchema, signedIn.json), `${label} signed in`).toEqual([]);
          expect(contains(signedIn.json, anonymous.json), `${label} signed in contains the anonymous answer`).toBe(true);
        }
      }
    }
    expect([...answered].sort()).toEqual(anonymousPipelines(config, manifest).map((p) => p.name).sort());
  });
});

describe("examples/minimal: a public read without the field step", () => {
  it("does not boot", async () => {
    const pipelines = await loadPipelines(root, "pipelines");
    const victim = pipelines.find((p) => pipelineSteps(p.steps).at(-1)?.startsWith("authz.fields:"))!;
    await expect(bootExample((all) => all.map((p) => (p === victim ? definePipeline({ name: p.name, steps: pipelineSteps(p.steps).slice(0, -1) }) : p)))).rejects.toThrow(`pipeline "${victim.name}" answers anonymous callers but does not end with authz.fields:<resource>?shape=`);
  });
});
