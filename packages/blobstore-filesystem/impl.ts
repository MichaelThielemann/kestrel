import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { BlobInfo, Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { failure } from "@michaelthielemann/kestrel/errors";
import { type Err, err, ok } from "@michaelthielemann/kestrel/result";

export interface Config {
  root: string;
}

const META = ".meta.json";

export function assertKey(key: string): void {
  if (key === "" || key.startsWith("/") || key.split("/").some((part) => part === "" || part === "." || part === "..") || key.endsWith(META)) {
    throw new Error(`blobstore/filesystem: invalid key ${JSON.stringify(key)}`);
  }
}

function errno(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null ? (cause as NodeJS.ErrnoException).code : undefined;
}

const TRANSIENT_CODES = new Set(["EBUSY", "EAGAIN", "EMFILE", "ENFILE"]);

/** Rethrows anything but the four transient IO codes; those become a TRANSIENT Err instead of a bug. */
function transientOrRethrow(cause: unknown): Err<BlobstoreError> {
  const code = errno(cause);
  if (code !== undefined && TRANSIENT_CODES.has(code)) {
    return err(failure("TRANSIENT", `blobstore/filesystem: ${code}`, { cause }));
  }
  throw cause;
}

export function createBlobstoreFilesystem(config: Config): Blobstore {
  const root = resolve(config.root);
  const pathOf = (key: string): string => {
    assertKey(key);
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new Error(`blobstore/filesystem: key ${JSON.stringify(key)} escapes root`);
    return path;
  };

  const PRUNABLE = new Set(["ENOTEMPTY", "ENOENT", "EBUSY", "EEXIST"]);
  const prune = async (dir: string): Promise<void> => {
    let current = dir;
    while (current.startsWith(root + sep)) {
      try {
        await rmdir(current);
      } catch (cause) {
        if (PRUNABLE.has(errno(cause) ?? "")) return;
        throw cause;
      }
      current = dirname(current);
    }
  };

  const walk = async (dir: string, out: BlobInfo[]): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
      if (errno(cause) === "ENOENT") return;
      throw cause;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, out);
      else if (entry.name.endsWith(META)) {
        const file = path.slice(0, -META.length);
        const meta = JSON.parse(await readFile(path, "utf8")) as { contentType: string };
        out.push({ key: relative(root, file).split(sep).join("/"), size: (await stat(file)).size, contentType: meta.contentType });
      }
    }
  };

  return {
    async put(key, blob) {
      const path = pathOf(key);
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, blob.data);
        await writeFile(path + META, JSON.stringify({ contentType: blob.contentType }));
        return ok();
      } catch (cause) {
        return transientOrRethrow(cause);
      }
    },
    async get(key) {
      const path = pathOf(key);
      try {
        const [data, meta] = await Promise.all([readFile(path), readFile(path + META, "utf8")]);
        return ok({ data: new Uint8Array(data), contentType: (JSON.parse(meta) as { contentType: string }).contentType });
      } catch (cause) {
        if (errno(cause) === "ENOENT") return ok(null);
        return transientOrRethrow(cause);
      }
    },
    async remove(key) {
      const path = pathOf(key);
      try {
        await rm(path, { force: true });
        await rm(path + META, { force: true });
        await prune(dirname(path));
        return ok();
      } catch (cause) {
        return transientOrRethrow(cause);
      }
    },
    async move(from, to) {
      const source = pathOf(from);
      const target = pathOf(to);
      try {
        await Promise.all([stat(source), stat(source + META)]);
      } catch (cause) {
        if (errno(cause) === "ENOENT") return err(failure("NOT_FOUND", `blobstore/filesystem: ${JSON.stringify(from)} not found`, { cause }));
        return transientOrRethrow(cause);
      }
      try {
        await mkdir(dirname(target), { recursive: true });
        // meta first: a crash between the two renames leaves the data file's meta
        // already pointing at the target, so get(from) stays not-found and get(to)
        // fails closed (missing data) until the data rename completes.
        await rename(source + META, target + META);
        await rename(source, target);
        await prune(dirname(source));
        return ok();
      } catch (cause) {
        return transientOrRethrow(cause);
      }
    },
    async list(prefix) {
      try {
        const out: BlobInfo[] = [];
        await walk(root, out);
        return ok(out.filter((info) => info.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key)));
      } catch (cause) {
        return transientOrRethrow(cause);
      }
    },
  };
}
