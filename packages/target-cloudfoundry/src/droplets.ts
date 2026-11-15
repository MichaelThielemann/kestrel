import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
// eslint-disable-next-line no-restricted-imports -- a target adapter implements the update interface of kestrel-ops
import type { DropletInfo, RevisionInfo } from "@michaelthielemann/kestrel-ops";
// eslint-disable-next-line no-restricted-imports -- a target adapter reports failures as the errors of the kestrel-ops run that loads it
import { OpsError } from "@michaelthielemann/kestrel-ops";
import { CfUnfinished } from "./cf.ts";
import { CfApiError, type CfSession } from "./session.ts";

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const pageSchema = <T extends z.ZodType>(item: T) => z.object({ pagination: z.object({ next: z.object({ href: z.string() }).nullish() }).nullish(), resources: z.array(item) });

const dropletSchema = z.object({ guid: z.string(), state: z.string(), created_at: z.string(), process_types: z.record(z.string(), z.string()).nullish(), image: z.string().nullish() });

const DOWNLOAD_ATTEMPTS = 3;
const revisionSchema = z.object({ guid: z.string(), version: z.number().int(), created_at: z.string(), droplet: z.object({ guid: z.string() }).nullish() });
const currentSchema = z.object({ guid: z.string() });
const savedHeader = z.object({ schema: z.literal("kestrel-target-cloudfoundry/droplet@1"), processTypes: z.record(z.string(), z.string()) });

const DROPLET_HEADER = "kestrel-target-cloudfoundry/droplet@1";

const pathOf = (href: string): string => {
  const url = new URL(href);
  return url.pathname + url.search;
};

async function allPages<T>(session: CfSession, first: string, item: z.ZodType<T>): Promise<T[]> {
  const out: T[] = [];
  let path: string | null = first;
  for (let page = 0; path !== null && page < 100; page++) {
    const answer: { pagination?: { next?: { href: string } | null | undefined } | null | undefined; resources: T[] } = await session.api(path, pageSchema(item));
    out.push(...answer.resources);
    const next = answer.pagination?.next?.href;
    path = next === undefined ? null : pathOf(next);
  }
  return out;
}

/**
 * Calls the v3 API at `path` with `body` as the request body, read by cf from a file only this user can read
 * (`cf curl -d @<file>`), so no value of the body appears on a command line. An empty answer is null.
 */
export async function curlWithBody(session: CfSession, path: string, method: string, body: Uint8Array | string, headers: readonly string[] = []): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-cf-body-"));
  try {
    const file = join(dir, "body");
    await writeFile(file, body, { mode: 0o600 });
    await session.confirmTarget();
    const args = ["curl", path, "-X", method, ...headers.flatMap((header) => ["-H", header]), "-d", `@${file}`];
    const result = await session.run(args, { timeoutMs: 600_000 }).catch((error: unknown) => {
      throw error instanceof CfUnfinished ? new CfApiError(error.message) : error;
    });
    if (result.code !== 0) throw new CfApiError(`cf curl -X ${method} ${path} exited with ${result.code}`);
    return parseAnswer(path, result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseAnswer(path: string, stdout: string): unknown {
  if (stdout.trim() === "") return null;
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    throw new CfApiError(`cf curl ${path} answered no JSON`);
  }
  const errors: unknown = Reflect.get(Object(answer), "errors");
  if (Array.isArray(errors) && errors.length > 0) {
    const titles = errors.map((e: unknown): unknown => Reflect.get(Object(e), "title")).filter((t): t is string => typeof t === "string");
    throw new CfApiError(`cf curl ${path} answered ${titles.join(", ") || "an error"}`, titles);
  }
  return answer;
}

async function currentGuid(session: CfSession): Promise<string | null> {
  const current = await session.api(`/v3/apps/${await session.appGuid()}/droplets/current`, currentSchema).catch((error: unknown) => {
    if (error instanceof CfApiError && error.titles.includes("CF-ResourceNotFound")) return null;
    throw error;
  });
  return current?.guid ?? null;
}

/** Every droplet of the app, oldest first, marking the current one. */
export async function listDroplets(session: CfSession): Promise<DropletInfo[]> {
  const guid = await session.appGuid();
  const droplets = await allPages(session, `/v3/apps/${guid}/droplets?per_page=100`, dropletSchema);
  const current = await currentGuid(session);
  return droplets.map((d) => ({ guid: d.guid, createdAt: Date.parse(d.created_at), current: d.guid === current })).sort((a, b) => a.createdAt - b.createdAt || (a.guid < b.guid ? -1 : 1));
}

/** Every revision of the app, oldest first, with the droplet each names. */
export async function listRevisions(session: CfSession): Promise<RevisionInfo[]> {
  const revisions = await allPages(session, `/v3/apps/${await session.appGuid()}/revisions?per_page=100`, revisionSchema);
  return revisions.map((r) => ({ guid: r.guid, version: r.version, droplet: r.droplet?.guid ?? null, createdAt: Date.parse(r.created_at) })).sort((a, b) => a.version - b.version);
}

/** Deletes droplet `guid` of the app; refuses with exit 1 for the current droplet or one of another app. */
export async function deleteDroplet(session: CfSession, guid: string): Promise<void> {
  const droplets = await listDroplets(session);
  const found = droplets.find((d) => d.guid === guid);
  if (found === undefined) throw new OpsError(`refusing to delete droplet ${guid}: it is not a droplet of ${session.app}`, 1, "target");
  if (found.current) throw new OpsError(`refusing to delete droplet ${guid}: it is the current droplet of ${session.app}`, 1, "target");
  await session.confirmTarget();
  const path = `/v3/droplets/${guid}`;
  const result = await session.run(["curl", path, "-X", "DELETE"], { timeoutMs: 120_000 }).catch((error: unknown) => {
    throw error instanceof CfUnfinished ? new CfApiError(error.message) : error;
  });
  if (result.code !== 0) throw new CfApiError(`cf curl -X DELETE ${path} exited with ${result.code}`);
  parseAnswer(path, result.stdout);
  const deadline = session.deps.clock() + 120_000;
  for (;;) {
    const gone = await session.api(path, currentSchema).then(
      () => false,
      (error: unknown) => {
        if (error instanceof CfApiError && error.titles.includes("CF-ResourceNotFound")) return true;
        throw error;
      },
    );
    if (gone) return;
    if (session.deps.clock() >= deadline) throw new OpsError(`droplet ${guid} of ${session.app} was still listed 120 s after its deletion was requested`, 1, "target");
    await sleep(session.pollMs);
  }
}

/**
 * Downloads the bits of droplet `guid` into `file` (mode 0600), behind a header line with the droplet's process
 * types, which a new droplet needs. False for a droplet of a container image, whose bits the platform does not hand
 * out. A failed or empty download is tried three times in all; after that it refuses with exit 1.
 */
export async function saveDroplet(session: CfSession, guid: string, file: string): Promise<boolean> {
  const droplet = await session.api(`/v3/droplets/${guid}`, dropletSchema);
  if (typeof droplet.image === "string" && droplet.image !== "") return false;
  const dir = await mkdtemp(join(tmpdir(), "kestrel-cf-droplet-"));
  try {
    const bits = join(dir, "droplet.tgz");
    for (let attempt = 1; ; attempt++) {
      await session.confirmTarget();
      const result = await session.run(["download-droplet", session.app, "--droplet", guid, "--path", bits], { timeoutMs: 1_800_000 });
      const size =
        result.code !== 0
          ? 0
          : await stat(bits).then(
              (s) => s.size,
              () => 0,
            );
      if (size > 0) {
        const header = `${JSON.stringify({ schema: DROPLET_HEADER, processTypes: droplet.process_types ?? {} })}\n`;
        await writeFile(file, Buffer.concat([Buffer.from(header), await readFile(bits)]), { mode: 0o600 });
        return true;
      }
      if (attempt >= DOWNLOAD_ATTEMPTS) throw new OpsError(`downloading the bits of droplet ${guid} of ${session.app} failed ${attempt} times (cf download-droplet ${result.code === 0 ? "wrote an empty file" : `exited with ${result.code}`})`, 1, "target");
      await sleep(session.pollMs * attempt);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Uploads droplet bits saved by {@link saveDroplet} as a new droplet of the app and resolves to its guid once it is staged. */
export async function restoreDroplet(session: CfSession, file: string): Promise<string> {
  const content = await readFile(file);
  const newline = content.indexOf(0x0a);
  let header: unknown;
  try {
    header = newline < 0 ? null : JSON.parse(content.subarray(0, newline).toString("utf8"));
  } catch {
    header = null;
  }
  const parsed = savedHeader.safeParse(header);
  if (!parsed.success) throw new OpsError(`${file} holds no droplet saved by this target`, 1, "target");
  const bits = content.subarray(newline + 1);
  const created = dropletSchema.safeParse(await curlWithBody(session, "/v3/droplets", "POST", JSON.stringify({ relationships: { app: { data: { guid: await session.appGuid() } } }, process_types: parsed.data.processTypes }), ["Content-Type: application/json"]));
  if (!created.success) throw new CfApiError("cf curl -X POST /v3/droplets answered an unexpected document");
  const boundary = `kestrel-${randomBytes(12).toString("hex")}`;
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bits"; filename="droplet.tgz"\r\nContent-Type: application/gzip\r\n\r\n`), bits, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const guid = created.data.guid;
  await curlWithBody(session, `/v3/droplets/${guid}/upload`, "POST", body, [`Content-Type: multipart/form-data; boundary=${boundary}`]);
  const deadline = session.deps.clock() + 600_000;
  for (;;) {
    const now = await session.api(`/v3/droplets/${guid}`, dropletSchema);
    if (now.state === "STAGED") return guid;
    if (now.state === "FAILED" || now.state === "EXPIRED") throw new OpsError(`the uploaded droplet ${guid} of ${session.app} ended in state ${now.state}`, 1, "target");
    if (session.deps.clock() >= deadline) throw new OpsError(`the uploaded droplet ${guid} of ${session.app} was not staged within 600 s`, 1, "target");
    await sleep(session.pollMs);
  }
}
