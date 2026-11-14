import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";

const PLACEHOLDER = /\(\(([A-Za-z0-9_.-]+)\)\)/g;

/** The manifest reduced to the entry of `app`, as JSON (which every YAML reader takes), and the placeholder names it uses. */
export function appManifest(file: string, app: string): { text: string; vars: string[] } {
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new OpsError(`${file}: cannot read the manifest: ${cause instanceof Error ? cause.message : String(cause)}`, 2, "target");
  }
  const applications: unknown = Reflect.get(Object(doc), "applications");
  const entry: unknown = Array.isArray(applications) ? applications.find((a: unknown) => Reflect.get(Object(a), "name") === app) : undefined;
  if (entry === undefined) throw new OpsError(`${file} has no application named ${app}`, 2, "target");
  const top: Record<string, unknown> = typeof doc === "object" && doc !== null ? Object.fromEntries(Object.entries(doc)) : {};
  const text = JSON.stringify({ ...top, applications: [entry] }, null, 2);
  return { text, vars: [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ""))].sort() };
}

/** Writes the manifest and the variables into a directory only this user can read, hands both paths to `use` and removes the directory whatever happens. */
export async function withManifestFiles<T>(manifest: string, vars: Record<string, string>, use: (manifestFile: string, varsFile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-cf-vars-"));
  try {
    const manifestFile = join(dir, "manifest.yml");
    const varsFile = join(dir, "vars.yml");
    await writeFile(manifestFile, manifest, { mode: 0o600 });
    await writeFile(varsFile, JSON.stringify(vars), { mode: 0o600 });
    return await use(manifestFile, varsFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
