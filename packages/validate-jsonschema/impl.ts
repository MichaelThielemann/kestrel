import { watch as fsWatch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Problem, Validate, Validation } from "@michaelthielemann/kestrel-contracts/validate";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { sanitize, sanitizeBySchema } from "./sanitize.ts";

export type { Problem, Validation };

export interface Config {
  schemas: Record<string, string | Record<string, unknown>>;
  maxDepth: number;
  maxNodes: number;
  watch?: boolean;
}

export interface Validator extends Validate {
  sanitize(target: string, value: unknown): unknown;
  sanitizeHtml(html: string): string;
  close(): void;
}

export class SchemaLoadError extends Error {}

export function measure(value: unknown): { depth: number; nodes: number } {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  let nodes = 0;
  let depth = 0;
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    nodes += 1;
    if (entry.depth > depth) depth = entry.depth;
    const children = Array.isArray(entry.node) ? entry.node : typeof entry.node === "object" && entry.node !== null ? Object.values(entry.node) : [];
    for (const child of children) stack.push({ node: child, depth: entry.depth + 1 });
  }
  return { depth, nodes };
}

function format(errors: ErrorObject[] | null | undefined): Problem[] {
  const out: (Problem & { nullBranch: boolean })[] = [];
  const seen = new Set<string>();
  for (const e of errors ?? []) {
    if (e.keyword === "oneOf" || e.keyword === "anyOf") continue;
    const problem =
      e.keyword === "discriminator"
        ? { path: `${e.instancePath}/type`, message: `unknown type ${JSON.stringify((e.params as { tagValue?: unknown }).tagValue)}` }
        : {
            path: e.instancePath === "" ? "/" : e.instancePath,
            message: e.keyword === "additionalProperties" ? `unexpected property "${String((e.params as { additionalProperty?: string }).additionalProperty)}"` : (e.message ?? e.keyword),
          };
    const key = `${problem.path}|${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...problem, nullBranch: e.keyword === "type" && (e.params as { type?: unknown }).type === "null" });
  }
  const kept = out.filter((p) => !p.nullBranch || !out.some((other) => other !== p && other.path.startsWith(`${p.path}/`)));
  const problems = kept.map(({ path, message }) => ({ path, message }));
  return problems.length > 0 ? problems : [{ path: "/", message: "does not match the schema" }];
}

type Node = Record<string, unknown>;

function resolveLocal(root: Node, node: unknown): Node | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const ref = (node as Node).$ref;
  if (typeof ref !== "string") return node as Node;
  if (!ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").reduce<unknown>((o, k) => (typeof o === "object" && o !== null ? (o as Node)[k] : undefined), root) as Node | undefined;
}

export function withDiscriminators(schema: unknown): unknown {
  const root = structuredClone(schema) as Node;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const n = node as Node;
    const branches = Array.isArray(n.oneOf) ? n.oneOf.map((b) => resolveLocal(root, b)) : [];
    if (branches.length > 0 && (n.type === undefined || n.type === "object") && branches.every((b) => b !== undefined && typeof (b.properties as Node | undefined)?.type === "object" && ((b.properties as Node).type as Node).const !== undefined)) {
      n.discriminator = { propertyName: "type" };
      n.type = "object";
      for (const b of branches as Node[]) {
        const required = Array.isArray(b.required) ? (b.required as string[]) : [];
        if (!required.includes("type")) b.required = [...required, "type"];
      }
    }
    for (const v of Object.values(n)) visit(v);
  };
  visit(root);
  return root;
}

function newAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, discriminator: true });
  addFormats.default(ajv);
  ajv.addFormat("html", () => true);
  return ajv;
}

function compileSchema(schema: Record<string, unknown>): { schema: Record<string, unknown>; fn: ValidateFunction } {
  return { schema, fn: newAjv().compile(withDiscriminators(schema) as object) };
}

async function loadSchema(path: string): Promise<{ schema: Record<string, unknown>; fn: ValidateFunction }> {
  return compileSchema(JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>);
}

const WATCH_DEBOUNCE_MS = 100;
const RELOAD_RETRY_DELAY_MS = 250;

export async function createValidator(config: Config, root: string, logger: Logger): Promise<Validator> {
  const compiled = new Map<string, ValidateFunction>();
  const raw = new Map<string, Record<string, unknown>>();
  const paths = new Map<string, string>();

  for (const [target, source] of Object.entries(config.schemas)) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][A-Za-z0-9_]*$/.test(target)) throw new SchemaLoadError(`validate/jsonschema: target "${target}" must look like "<type>.<field>"`);
    if (typeof source !== "string") {
      try {
        const inline = compileSchema(structuredClone(source));
        raw.set(target, inline.schema);
        compiled.set(target, inline.fn);
      } catch (err) {
        throw new SchemaLoadError(`validate/jsonschema: invalid inline schema for ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    const path = resolve(root, source);
    paths.set(target, path);
    let loaded: { schema: Record<string, unknown>; fn: ValidateFunction };
    try {
      loaded = await loadSchema(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isReadOrParseError = err instanceof SyntaxError || (err as NodeJS.ErrnoException).code !== undefined;
      if (isReadOrParseError) throw new SchemaLoadError(`validate/jsonschema: cannot read schema for ${target} at ${path}: ${message}`);
      throw new SchemaLoadError(`validate/jsonschema: invalid schema for ${target} at ${path}: ${message}`);
    }
    raw.set(target, loaded.schema);
    compiled.set(target, loaded.fn);
  }

  // Retried once after a short delay: an editor/git write can leave the file briefly
  // truncated or half-written between the change event and the actual final content.
  async function reloadTarget(target: string): Promise<void> {
    const path = paths.get(target);
    if (!path) return;
    try {
      const loaded = await loadSchema(path);
      raw.set(target, loaded.schema);
      compiled.set(target, loaded.fn);
      return;
    } catch {
      // fall through to retry
    }
    await new Promise((r) => setTimeout(r, RELOAD_RETRY_DELAY_MS));
    try {
      const loaded = await loadSchema(path);
      raw.set(target, loaded.schema);
      compiled.set(target, loaded.fn);
    } catch (err) {
      logger.error(`validate/jsonschema: failed to reload schema for ${target}, keeping previous schema`, { target, path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Per-target promise chain: a slow reload from an earlier event must not overwrite
  // the result of a later one that already finished.
  const reloadChains = new Map<string, Promise<void>>();
  function scheduleReload(target: string): void {
    const chained = (reloadChains.get(target) ?? Promise.resolve()).then(() => reloadTarget(target));
    reloadChains.set(target, chained);
  }

  const dirWatchers = new Map<string, ReturnType<typeof fsWatch>>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  if (config.watch) {
    const byDir = new Map<string, Array<{ target: string; base: string }>>();
    for (const [target, path] of paths) {
      const dir = dirname(path);
      const entries = byDir.get(dir) ?? [];
      entries.push({ target, base: basename(path) });
      byDir.set(dir, entries);
    }
    for (const [dir, entries] of byDir) {
      try {
        const watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
          if (!filename) return;
          for (const { target, base } of entries) {
            if (filename !== base) continue;
            const timer = debounceTimers.get(target);
            if (timer) clearTimeout(timer);
            debounceTimers.set(
              target,
              setTimeout(() => {
                debounceTimers.delete(target);
                scheduleReload(target);
              }, WATCH_DEBOUNCE_MS),
            );
          }
        });
        watcher.on("error", (err) => {
          logger.error("validate/jsonschema: watch error", { path: dir, error: err instanceof Error ? err.message : String(err) });
        });
        dirWatchers.set(dir, watcher);
      } catch (err) {
        logger.error("validate/jsonschema: could not watch directory", { path: dir, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    targets: () => [...compiled.keys()],
    sanitize(target, value) {
      const schema = raw.get(target);
      if (!schema) throw new Error(`validate/jsonschema: no schema for "${target}"`);
      return sanitizeBySchema(schema, schema, value);
    },
    sanitizeHtml: sanitize,
    check(target, value) {
      const fn = compiled.get(target);
      if (!fn) throw new Error(`validate/jsonschema: no schema for "${target}"`);
      const size = measure(value);
      if (size.depth > config.maxDepth) return { ok: false, problems: [{ path: "/", message: `nesting deeper than ${config.maxDepth}` }] };
      if (size.nodes > config.maxNodes) return { ok: false, problems: [{ path: "/", message: `more than ${config.maxNodes} nodes` }] };
      const ok = fn(value);
      return ok ? { ok: true, problems: [] } : { ok: false, problems: format(fn.errors) };
    },
    close() {
      for (const watcher of dirWatchers.values()) watcher.close();
      dirWatchers.clear();
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
    },
  };
}
