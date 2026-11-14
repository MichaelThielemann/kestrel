import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { ENVIRONMENTS_FILE, loadEnvironments } from "./environments.ts";
import { OpsError } from "./errors.ts";
import { packageDir } from "./packages.ts";
import { sha256File } from "./sqlite.ts";

/** The package a bundle runs. */
export const OPS_PACKAGE = "@michaelthielemann/kestrel-ops";

/** `bundle.json`: what the bundle was built from. */
export interface BundleInfo {
  schema: "kestrel-ops/bundle@1";
  createdAt: number;
  packages: Record<string, string>;
  lockfileSha256: string | null;
  /** Facts the host project contributes, such as its readiness path; never secret values. */
  hostFacts: Record<string, unknown>;
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
process.exitCode = await runOps(process.argv.slice(2), { cwd: fileURLToPath(dir), project: { versions: info.packages, lockfileSha256: info.lockfileSha256 } });
`;

/**
 * Writes a self-contained `.kestrel-ops/` into `outDir`: `run.mjs`, the installed kestrel-ops and the target adapter
 * package of every environment, each with the packages it needs, under `node_modules/`, the project's
 * `kestrel.environments.json` and `bundle.json`. A deploy job then needs
 * only Node and the bundle: `node .kestrel-ops/run.mjs status --env <name>`.
 */
export function writeBundle(projectRoot: string, outDir: string, hostFacts: Record<string, unknown> = {}, clock: () => number = Date.now): { dir: string; packages: Record<string, string> } {
  const ops = packageDir(OPS_PACKAGE, projectRoot);
  if (ops === null) throw new OpsError(`${OPS_PACKAGE} is not installed in ${projectRoot}`, 2, OPS_PACKAGE);
  const environments = join(projectRoot, ENVIRONMENTS_FILE);
  if (!existsSync(environments)) throw new OpsError(`${ENVIRONMENTS_FILE} not found in ${projectRoot}`, 2, ENVIRONMENTS_FILE);
  const dir = join(outDir, ".kestrel-ops");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  const packages: Record<string, string> = {};
  const adapters = new Set(Object.values(loadEnvironments(projectRoot)).map((env) => env.target.adapter));
  adapters.delete("local");
  const queue: Array<{ name: string; from: string; optional: boolean }> = [{ name: OPS_PACKAGE, from: projectRoot, optional: false }, ...[...adapters].map((name) => ({ name, from: projectRoot, optional: false }))];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || packages[next.name] !== undefined) continue;
    const source = next.name === OPS_PACKAGE ? ops : packageDir(next.name, next.from);
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
  const lock = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].map((f) => join(projectRoot, f)).find((f) => existsSync(f));
  const info: BundleInfo = { schema: "kestrel-ops/bundle@1", createdAt: clock(), packages, lockfileSha256: lock === undefined ? null : sha256File(lock), hostFacts };
  writeFileSync(join(dir, "bundle.json"), JSON.stringify(info, null, 2) + "\n");
  writeFileSync(join(dir, "run.mjs"), RUNNER);
  return { dir, packages };
}
