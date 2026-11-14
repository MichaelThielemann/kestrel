import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";

const PLACEHOLDER = /\(\(([A-Za-z0-9_.-]+)\)\)/g;

/**
 * The manifest reduced to its `version` and the entry of `app`, as JSON (which every YAML reader takes), and the
 * placeholder names that entry uses. It is read as YAML 1.1 with merge keys, as cf reads it.
 */
export function appManifest(file: string, app: string): { text: string; vars: string[] } {
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"), { version: "1.1", merge: true });
  } catch (cause) {
    throw new OpsError(`${file}: cannot read the manifest: ${cause instanceof Error ? cause.message : String(cause)}`, 2, "target");
  }
  const applications: unknown = Reflect.get(Object(doc), "applications");
  const entry: unknown = Array.isArray(applications) ? applications.find((a: unknown) => Reflect.get(Object(a), "name") === app) : undefined;
  if (entry === undefined) throw new OpsError(`${file} has no application named ${app}`, 2, "target");
  const version: unknown = Reflect.get(Object(doc), "version");
  const text = JSON.stringify({ ...(version === undefined ? {} : { version }), applications: [entry] }, null, 2);
  return { text, vars: [...new Set([...JSON.stringify(entry).matchAll(PLACEHOLDER)].map((m) => m[1] ?? ""))].sort() };
}

/** Writes the manifest and the variables into a directory only this user can read, hands both paths to `use` and removes the directory when `use` settles or the process exits first. */
export async function withManifestFiles<T>(manifest: string, vars: Record<string, string>, use: (manifestFile: string, varsFile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-cf-vars-"));
  const removeOnExit = (): void => rmSync(dir, { recursive: true, force: true });
  process.once("exit", removeOnExit);
  try {
    const manifestFile = join(dir, "manifest.yml");
    const varsFile = join(dir, "vars.yml");
    await writeFile(manifestFile, manifest, { mode: 0o600 });
    await writeFile(varsFile, JSON.stringify(vars), { mode: 0o600 });
    return await use(manifestFile, varsFile);
  } finally {
    process.off("exit", removeOnExit);
    await rm(dir, { recursive: true, force: true });
  }
}
