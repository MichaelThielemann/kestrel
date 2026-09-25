import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, stat, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { trackTempDir, untrackTempDir } from "./cleanup.ts";

const run = promisify(execFile);

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".nuxt", ".output", "dist"]);
const MAX_BYTES = 10 * 1024 * 1024;
const EXCLUDED_FILE_PATTERNS = [/^\.env(\..*)?$/, /\.db(-wal|-shm)?$/i, /\.sqlite3?(-wal|-shm)?$/i];

function isExcludedFile(name: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

async function gitTrackedFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
    return stdout.split("\n").filter((line) => line !== "");
  } catch {
    return undefined;
  }
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(root, relPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isExcludedFile(entry.name)) continue;
    const info = await stat(join(root, relPath));
    if (info.size > MAX_BYTES) continue;
    out.push(relPath);
  }
}

async function projectFiles(root: string): Promise<string[]> {
  const tracked = await gitTrackedFiles(root);
  if (tracked) return tracked;
  const out: string[] = [];
  await walk(root, "", out);
  return out;
}

async function nearestNodeModules(dir: string): Promise<string | undefined> {
  for (let current = resolve(dir); ; ) {
    const candidate = join(current, "node_modules");
    try {
      await stat(candidate);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

async function symlinkNodeModules(root: string, scratch: string): Promise<void> {
  const sourceModules = await nearestNodeModules(root);
  const targetModules = join(scratch, "node_modules");
  if (sourceModules === undefined) return;
  let entries: string[];
  try {
    entries = await readdir(sourceModules);
  } catch {
    return;
  }
  await mkdir(targetModules, { recursive: true });
  for (const name of entries) {
    if (name === ".cache") {
      await mkdir(join(targetModules, ".cache"), { recursive: true });
      continue;
    }
    try {
      await symlink(resolve(sourceModules, name), join(targetModules, name), "dir");
    } catch {
      try {
        await symlink(resolve(sourceModules, name), join(targetModules, name), "file");
      } catch {
        continue;
      }
    }
  }
}

export interface ScratchCopy {
  dir: string;
  root: string;
}

/** Copies the project's own files into a fresh temp directory and points a symlinked `node_modules` at the project's real one, so loading and any file writes it triggers never touch the project. Removes and untracks its own partial copy before rethrowing when a step fails partway through, instead of leaking the directory. */
export async function createScratchCopy(root: string): Promise<ScratchCopy> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-"));
  trackTempDir(dir);
  try {
    const files = await projectFiles(root);
    for (const file of files) {
      const from = join(root, file);
      const to = join(dir, file);
      await mkdir(dirname(to), { recursive: true });
      const info = await lstat(from);
      if (info.isSymbolicLink()) {
        const target = await readlink(from);
        const absoluteTarget = isAbsolute(target) ? target : resolve(dirname(from), target);
        const relToRoot = relative(root, absoluteTarget);
        const insideRoot = !relToRoot.startsWith("..") && !isAbsolute(relToRoot);
        const linkTarget = insideRoot ? (isAbsolute(target) ? resolve(dir, relToRoot) : target) : absoluteTarget;
        await symlink(linkTarget, to);
        continue;
      }
      await copyFile(from, to);
    }
    await symlinkNodeModules(root, dir);
    await mkdir(join(dir, "sandbox"), { recursive: true });
    return { dir, root };
  } catch (err) {
    untrackTempDir(dir);
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Removes a scratch copy's directory; always call this once a scratch copy is no longer needed. */
export async function removeScratchCopy(scratch: ScratchCopy): Promise<void> {
  untrackTempDir(scratch.dir);
  await rm(scratch.dir, { recursive: true, force: true });
}

export function relativeToRoot(root: string, file: string): string {
  return relative(root, file);
}
