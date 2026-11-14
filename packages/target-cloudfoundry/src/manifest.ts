import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, type Tags } from "yaml";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";

const asCfReads = (tags: Tags): Tags => tags.filter((tag) => typeof tag === "string" || (tag.tag !== "tag:yaml.org,2002:timestamp" && tag.format !== "TIME"));

const PLACEHOLDER = /\(\((!?[-/.\w\p{L}]+)\)\)/gu;

const isRawJson = (value: unknown): value is (text: string) => unknown => typeof value === "function";

const rawJson: unknown = Reflect.get(JSON, "rawJSON");

const exactIntegers = (_key: string, value: unknown): unknown => {
  if (typeof value !== "bigint") return value;
  if (!isRawJson(rawJson)) throw new OpsError("this Node version has no JSON.rawJSON; the target needs Node 22.18 or later", 2, "target");
  return rawJson(value.toString());
};

const toJson = (value: unknown, indent?: number): string => JSON.stringify(value, exactIntegers, indent);

/**
 * The manifest reduced to its `version` and the entry of `app`, as JSON (which every YAML reader takes), and the
 * placeholder names that entry uses, without a leading `!`. A name with a dot, or an entry that scales the web process
 * to another count than 1, ends with exit 2. It is read as YAML 1.1 with merge keys, as cf reads it: dates and clock times
 * such as `03:00` stay strings.
 */
export function appManifest(file: string, app: string): { text: string; vars: string[] } {
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"), { version: "1.1", merge: true, intAsBigInt: true, customTags: asCfReads });
  } catch (cause) {
    throw new OpsError(`${file}: cannot read the manifest: ${cause instanceof Error ? cause.message : String(cause)}`, 2, "target");
  }
  const applications: unknown = Reflect.get(Object(doc), "applications");
  const entry: unknown = Array.isArray(applications) ? applications.find((a: unknown) => Reflect.get(Object(a), "name") === app) : undefined;
  if (entry === undefined) throw new OpsError(`${file} has no application named ${app}`, 2, "target");
  const processes: unknown = Reflect.get(Object(entry), "processes");
  const web: unknown = Array.isArray(processes) ? processes.find((p: unknown) => Reflect.get(Object(p), "type") === "web") : undefined;
  for (const instances of [Reflect.get(Object(entry), "instances"), Reflect.get(Object(web), "instances")]) {
    if (instances !== undefined && instances !== 1n) throw new OpsError(`${file}: the entry of ${app} sets ${String(instances)} instances of its web process; backup and restore need exactly one, so the entry sets 1 or leaves the count out`, 2, "target");
  }
  const version: unknown = Reflect.get(Object(doc), "version");
  const text = toJson({ ...(version === undefined ? {} : { version }), applications: [entry] }, 2);
  const vars = [...new Set([...toJson(entry).matchAll(PLACEHOLDER)].map((m) => (m[1] ?? "").replace(/^!/, "")))].sort();
  const dotted = vars.filter((name) => name.includes("."));
  if (dotted.length > 0) throw new OpsError(`${file}: the entry of ${app} uses ${dotted.map((name) => `((${name}))`).join(", ")}, which cf reads as a field of the variable before the first dot; target.vars fills only names without a dot`, 2, "target");
  return { text, vars };
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Writes the manifest and the variables into a directory only this user can read, hands both paths to `use` and
 * removes the directory when `use` settles, the process exits first or SIGINT, SIGTERM or SIGHUP arrives. A signal
 * that no other listener of the process handles is raised again once the directory is gone.
 */
export async function withManifestFiles<T>(manifest: string, vars: Record<string, string>, use: (manifestFile: string, varsFile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-cf-vars-"));
  const removeNow = (): void => rmSync(dir, { recursive: true, force: true });
  const onSignal = new Map<NodeJS.Signals, () => void>();
  const unlisten = (): void => {
    process.off("exit", removeNow);
    for (const [signal, handler] of onSignal) process.off(signal, handler);
  };
  for (const signal of SIGNALS) {
    const handler = (): void => {
      removeNow();
      unlisten();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    onSignal.set(signal, handler);
    process.on(signal, handler);
  }
  process.once("exit", removeNow);
  try {
    const manifestFile = join(dir, "manifest.yml");
    const varsFile = join(dir, "vars.yml");
    await writeFile(manifestFile, manifest, { mode: 0o600 });
    await writeFile(varsFile, JSON.stringify(vars), { mode: 0o600 });
    return await use(manifestFile, varsFile);
  } finally {
    unlisten();
    await rm(dir, { recursive: true, force: true });
  }
}
