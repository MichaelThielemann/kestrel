import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ZodTypeAny } from "zod";
import type { ModuleDefinition } from "@michaelthielemann/kestrel";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { BLOBSTORE, type BlobInfo, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";

function isErrno(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error;
}

function isEnoent(cause: unknown): boolean {
  return isErrno(cause) && cause.code === "ENOENT";
}

function createStandInBlobstore(root: string): Blobstore {
  const pathOf = (key: string): string => resolve(root, key);
  return {
    async put(key, data) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
      return ok();
    },
    async get(key) {
      try {
        return ok(new Uint8Array(await readFile(pathOf(key))));
      } catch (cause) {
        if (isEnoent(cause)) return ok(null);
        return err(failure("TRANSIENT", "blobstore stand-in: read failed", { cause }));
      }
    },
    async remove(key) {
      await rm(pathOf(key), { force: true });
      return ok();
    },
    async move(from, to) {
      const source = pathOf(from);
      try {
        await stat(source);
      } catch (cause) {
        if (isEnoent(cause)) return err(failure("NOT_FOUND", `blobstore stand-in: ${JSON.stringify(from)} not found`, { cause }));
        return err(failure("TRANSIENT", "blobstore stand-in: move failed", { cause }));
      }
      const target = pathOf(to);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
      return ok();
    },
    async list(prefix) {
      const out: BlobInfo[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (cause) {
          if (isEnoent(cause)) return;
          throw cause;
        }
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else out.push({ key: relative(root, path).split(sep).join("/"), size: (await stat(path)).size });
        }
      };
      await walk(root);
      return ok(out.filter((info) => info.key.startsWith(prefix)));
    },
  };
}

/**
 * A local, filesystem-backed stand-in for a blobstore module the sandbox neither rewrites nor
 * trusts to run outside it, such as a network object store: proves every module requiring
 * `blobstore@1` boots, without reaching the network or touching the project's own storage. Keeps
 * the replaced module's own `configSchema` so an invalid config still fails the same way it would
 * for the real module; the parsed value itself is never read, since the real config never applies.
 */
export function blobstoreStandIn(name: string, scratchDir: string, configSchema: ZodTypeAny): ModuleDefinition {
  return {
    name,
    provides: [BLOBSTORE],
    requires: [],
    configSchema,
    async setup() {
      const root = join(scratchDir, "sandbox", "blobstore-standin");
      await mkdir(root, { recursive: true });
      return createStandInBlobstore(root);
    },
  };
}

/** Whether a loaded module provides `blobstore@1`, regardless of its own name or package. */
export function providesBlobstore(mod: ModuleDefinition): boolean {
  return mod.provides.some((c) => c.name === BLOBSTORE.name);
}
