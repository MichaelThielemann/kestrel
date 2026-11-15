import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { err, ok, type Result } from "@michaelthielemann/kestrel/result";
import { orderStorages, type ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { exportsStorage, SANITIZE_SVG_PACKAGE } from "../bundle.ts";
import { messageOf } from "../context.ts";
import { OpsError } from "../errors.ts";
import { installedPackageDir, packageDir } from "../packages.ts";
import type { UpdateContext } from "./types.ts";

/** The module package whose storage converts media keys; it is given the environment's media prefix. */
export const MEDIA_PACKAGE = "@michaelthielemann/kestrel-media-default";

/** Cleans the bytes of one stored SVG for a storage migration; `Err` holds why it refuses the file. */
export type SvgSanitizer = (file: { filename: string; contentType: string; data: Uint8Array }) => Promise<Result<Uint8Array, string>>;

const OPS_DIR = fileURLToPath(new URL("../..", import.meta.url));

function conditional(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  for (const condition of ["import", "node", "default"]) {
    const found = conditional(Reflect.get(value, condition));
    if (found !== null) return found;
  }
  return null;
}

function throughDependencies(name: string, from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const found = existsSync(join(dir, "package.json")) ? installedPackageDir(name, dir) : null;
    if (found !== null) return found;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The directory of package `name` as the release has it installed: resolved from the release directory; through the
 * direct dependencies of the nearest project at or above it, as {@link installedPackageDir} finds a package a preset
 * dependency brings along; or, in a deploy job, from the bundle that carries kestrel-ops; null when none has it.
 */
export function releasePackageDir(ctx: Pick<UpdateContext, "release">, name: string): string | null {
  return packageDir(name, ctx.release.dir) ?? throughDependencies(name, ctx.release.dir) ?? packageDir(name, OPS_DIR);
}

/** The module packages with a storage an update looks for, also when the release's versions do not name them. */
export const STORAGE_MODULE_PACKAGES: readonly string[] = [MEDIA_PACKAGE, "@michaelthielemann/kestrel-images-default"];

/** Imports export `subpath` (such as `./storage`) of the release's package `name`; null when the release lacks the package or the export. */
export async function importReleasePackage(ctx: Pick<UpdateContext, "release">, name: string, subpath: string): Promise<unknown> {
  const dir = releasePackageDir(ctx, name);
  if (dir === null) return null;
  const exports: unknown = Reflect.get(Object(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))), "exports");
  const entry = typeof exports === "object" && exports !== null && !Array.isArray(exports) ? conditional(Reflect.get(exports, subpath)) : null;
  if (entry === null) return null;
  try {
    return await import(pathToFileURL(join(dir, entry)).href);
  } catch (cause) {
    throw new OpsError(`cannot load ${name}${subpath.slice(1)} of the release: ${messageOf(cause)}`, 2, name);
  }
}

const SVG_ROOT = /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/;

/** The SVG sanitizer of the release's sanitize package, or null when the release does not have it installed. */
export async function releaseSvgSanitizer(ctx: Pick<UpdateContext, "release">): Promise<SvgSanitizer | null> {
  const mod = await importReleasePackage(ctx, SANITIZE_SVG_PACKAGE, "./impl");
  const sanitize: unknown = typeof mod === "object" && mod !== null ? Reflect.get(mod, "sanitizeSvg") : undefined;
  if (typeof sanitize !== "function") return null;
  const clean = boundaryCast<(svg: string) => string>(sanitize, "host");
  return async (file) => {
    try {
      const cleaned = clean(new TextDecoder("utf-8").decode(file.data));
      return SVG_ROOT.test(cleaned) ? ok(new TextEncoder().encode(cleaned)) : err(`${file.filename} has no svg root element once cleaned`);
    } catch (cause) {
      return err(`${file.filename} could not be cleaned: ${messageOf(cause)}`);
    }
  };
}

/**
 * The storages of the release's modules: the `storage` export of every module package installed for the release that
 * its versions or {@link STORAGE_MODULE_PACKAGES} name (from the project on this machine, also through a preset
 * dependency, or from the bundle in a deploy job), in the order `orderStorages` gives.
 */
export async function releaseStorages(ctx: UpdateContext): Promise<ModuleStorage[]> {
  const storages: ModuleStorage[] = [];
  const sanitizeSvg = await releaseSvgSanitizer(ctx);
  for (const name of [...new Set([...Object.keys(ctx.release.versions), ...STORAGE_MODULE_PACKAGES])].sort()) {
    const dir = releasePackageDir(ctx, name);
    if (dir === null || !exportsStorage(dir)) continue;
    const mod = await importReleasePackage(ctx, name, "./storage");
    const factory: unknown = typeof mod === "object" && mod !== null ? Reflect.get(mod, "storage") : undefined;
    if (typeof factory !== "function") throw new OpsError(`${name}/storage of the release exports no storage()`, 2, name);
    const build = boundaryCast<(config: Record<string, unknown>, deps: Record<string, unknown>) => ModuleStorage>(factory, "host");
    storages.push(name === MEDIA_PACKAGE ? build({ prefix: ctx.env.app.mediaPrefix }, sanitizeSvg === null ? {} : { sanitizeSvg }) : build({}, {}));
  }
  return orderStorages(storages);
}
