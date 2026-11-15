import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { messageOf } from "./context.ts";
import { ENVIRONMENTS_FILE, loadEnvironments } from "./environments.ts";
import { OpsError } from "./errors.ts";
import { installedPackageDir, packageDir, packagesBroughtBy } from "./packages.ts";
import { sha256File } from "./sqlite.ts";
import type { HostFacts, VersionSet } from "./update/types.ts";

/** The package a bundle runs. */
export const OPS_PACKAGE = "@michaelthielemann/kestrel-ops";

const RELEASE_PREFIX = "@michaelthielemann/kestrel";

/** The package an update opens a database copy with for its storage migrations. */
export const PERSISTENCE_PACKAGE = "@michaelthielemann/kestrel-persistence-sqlite";

/** The package an update cleans stored SVGs with during its storage migrations, when the release has it installed. */
export const SANITIZE_SVG_PACKAGE = "@michaelthielemann/kestrel-sanitize-svg";

/** `bundle.json`: what the bundle was built from. */
export interface BundleInfo {
  schema: "kestrel-ops/bundle@1";
  createdAt: number;
  /** Every package the bundle carries under `node_modules/`, by name. */
  packages: Record<string, string>;
  lockfileSha256: string | null;
  /** The release the bundle deploys: the versions of the project's kestrel packages and its lockfile hash. */
  release: { versions: VersionSet; lockfileSha256: string | null };
  /** The project root relative to the bundle directory; `update.release.dir` is relative to it. */
  releaseRoot: string;
  /** Module packages of the release whose `./storage` export the bundle carries, by name. */
  storagePackages: string[];
  /** Target manifest files the bundle carries, relative to the bundle directory. */
  manifests: string[];
  /** Facts the host project contributes, such as its readiness path; never secret values. */
  hostFacts: HostFacts;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new OpsError(`${file} is not valid JSON: ${messageOf(cause)}`, 2, file);
  }
}

function installedVersion(file: string): string | null {
  try {
    const version: unknown = Reflect.get(Object(readJsonFile(file)), "version");
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * The installed versions of the project's direct dependencies, and of the kestrel module packages with a `./storage`
 * export those dependencies bring along (one level deep, such as the module packages of a preset package), and the
 * hash of its lockfile.
 */
export function projectFacts(root: string): { versions: Record<string, string>; lockfileSha256: string | null } {
  const versions: Record<string, string> = {};
  const manifest = join(root, "package.json");
  if (existsSync(manifest)) {
    const pkg = boundaryCast<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(readJsonFile(manifest), "json");
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const version = installedVersion(join(root, "node_modules", name, "package.json"));
      if (version !== null) versions[name] = version;
    }
    for (const [name, dir] of packagesBroughtBy(root, RELEASE_PREFIX)) {
      const version = versions[name] === undefined && exportsStorage(dir) ? installedVersion(join(dir, "package.json")) : null;
      if (version !== null) versions[name] = version;
    }
  }
  const lock = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].map((f) => join(root, f)).find((f) => existsSync(f));
  return { versions, lockfileSha256: lock === undefined ? null : sha256File(lock) };
}

/** The versions of the kestrel packages in `versions`, sorted by name. */
export function releaseVersions(versions: Readonly<Record<string, string>>): VersionSet {
  return Object.fromEntries(Object.entries(versions).filter(([name]) => name.startsWith(RELEASE_PREFIX)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** True when the package in `dir` exports `./storage`. */
export function exportsStorage(dir: string): boolean {
  const exports: unknown = Reflect.get(Object(readJsonFile(join(dir, "package.json"))), "exports");
  return typeof exports === "object" && exports !== null && !Array.isArray(exports) && Object.hasOwn(exports, "./storage");
}

function manifestFiles(projectRoot: string): string[] {
  const files = new Set<string>();
  for (const [name, env] of Object.entries(loadEnvironments(projectRoot))) {
    const manifest: unknown = Reflect.get(env.target, "manifest");
    if (typeof manifest !== "string") continue;
    const path = resolve(projectRoot, manifest);
    const inside = relative(projectRoot, path);
    if (isAbsolute(manifest) || inside.startsWith("..") || isAbsolute(inside)) throw new OpsError(`${ENVIRONMENTS_FILE}: the manifest ${manifest} of ${name} lies outside the project, so a bundle cannot carry it`, 2, `${name}.target.manifest`);
    if (!existsSync(path)) throw new OpsError(`${ENVIRONMENTS_FILE}: the manifest ${manifest} of ${name} does not exist`, 2, `${name}.target.manifest`);
    files.add(inside.split(sep).join("/"));
  }
  return [...files].sort();
}

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const RUNNER = `import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  emitWarning(warning, ...rest);
};
const { runOps } = await import("${OPS_PACKAGE}/run");

const dir = new URL(".", import.meta.url);
const info = JSON.parse(readFileSync(new URL("bundle.json", dir), "utf8"));
const cwd = fileURLToPath(dir);
const options = { cwd, releaseRoot: join(cwd, info.releaseRoot), project: { versions: info.release.versions, lockfileSha256: info.release.lockfileSha256 }, host: info.hostFacts };
const argv = process.argv.slice(2);
const update = argv[0] === "update" ? argv.slice(1) : argv[0] === "deploy" || argv[0] === "verify" ? argv : null;
process.exitCode = update === null ? await runOps(argv, options) : await (await import("${OPS_PACKAGE}/run")).runUpdate(update, options);
`;

/**
 * Writes a self-contained `.kestrel-ops/` into `outDir`: `run.mjs`, the installed kestrel-ops, the target adapter
 * package of every environment, the module packages of the release that export `./storage` together with the
 * persistence package (and the SVG sanitizer, when installed) an update migrates a database copy with, also when a
 * dependency of the project brings them along, each with the packages it needs, under `node_modules/`; the project's `kestrel.environments.json` and every target manifest it
 * names, at the same relative path; and `bundle.json` with the release's versions and `hostFacts`. A deploy job then
 * needs only Node, the platform's CLI and the bundle: `node .kestrel-ops/run.mjs deploy --env <name>`, or
 * `node .kestrel-ops/run.mjs update status --env <name>`; `run.mjs` hands `deploy`, `verify` and `update …` to
 * `runUpdate` and every other command to `runOps`.
 */
export function writeBundle(projectRoot: string, outDir: string, hostFacts: HostFacts = {}, clock: () => number = Date.now): { dir: string; packages: Record<string, string> } {
  const ops = packageDir(OPS_PACKAGE, projectRoot);
  if (ops === null) throw new OpsError(`${OPS_PACKAGE} is not installed in ${projectRoot}`, 2, OPS_PACKAGE);
  const environments = join(projectRoot, ENVIRONMENTS_FILE);
  if (!existsSync(environments)) throw new OpsError(`${ENVIRONMENTS_FILE} not found in ${projectRoot}`, 2, ENVIRONMENTS_FILE);
  const manifests = manifestFiles(projectRoot);
  const facts = projectFacts(projectRoot);
  const release = releaseVersions(facts.versions);
  const dir = join(outDir, ".kestrel-ops");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  const packages: Record<string, string> = {};
  const adapters = new Set(Object.values(loadEnvironments(projectRoot)).map((env) => env.target.adapter));
  adapters.delete("local");
  const storagePackages = Object.keys(release).filter((name) => {
    const found = installedPackageDir(name, projectRoot);
    return found !== null && exportsStorage(found);
  });
  const installed = (name: string, optional: boolean) => ({ name, from: projectRoot, optional, dir: installedPackageDir(name, projectRoot) });
  const queue: Array<{ name: string; from: string; optional: boolean; dir?: string | null }> = [
    { name: OPS_PACKAGE, from: projectRoot, optional: false },
    ...[...adapters].map((name) => ({ name, from: projectRoot, optional: false })),
    ...storagePackages.map((name) => installed(name, false)),
    ...(storagePackages.length > 0 ? [installed(PERSISTENCE_PACKAGE, true), installed(SANITIZE_SVG_PACKAGE, true)] : []),
  ];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || packages[next.name] !== undefined) continue;
    const source = next.name === OPS_PACKAGE ? ops : (next.dir ?? packageDir(next.name, next.from));
    if (source === null && next.optional) continue;
    if (source === null) throw new OpsError(`cannot resolve ${next.name} from ${next.from}`, 2, next.name);
    const manifest = boundaryCast<Manifest>(JSON.parse(readFileSync(join(source, "package.json"), "utf8")), "json");
    packages[next.name] = manifest.version;
    cpSync(source, join(dir, "node_modules", next.name), { recursive: true, dereference: true, filter: (path) => !/[\\/]node_modules([\\/]|$)/.test(path.slice(source.length)) });
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dep, from: source, optional: false });
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ name: dep, from: source, optional: true });
    for (const dep of Object.keys(manifest.peerDependencies ?? {})) if (manifest.peerDependenciesMeta?.[dep]?.optional !== true) queue.push({ name: dep, from: source, optional: false });
  }
  cpSync(environments, join(dir, ENVIRONMENTS_FILE));
  for (const file of manifests) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(projectRoot, file), join(dir, file));
  }
  const info: BundleInfo = {
    schema: "kestrel-ops/bundle@1",
    createdAt: clock(),
    packages,
    lockfileSha256: facts.lockfileSha256,
    release: { versions: release, lockfileSha256: facts.lockfileSha256 },
    releaseRoot: relative(dir, projectRoot).split(sep).join("/") || ".",
    storagePackages,
    manifests,
    hostFacts,
  };
  writeFileSync(join(dir, "bundle.json"), JSON.stringify(info, null, 2) + "\n");
  writeFileSync(join(dir, "run.mjs"), RUNNER);
  return { dir, packages };
}
