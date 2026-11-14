#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

export const VERSION = "5.8.1";
export const TAG = `v${VERSION}`;
export const DEMO_PASSWORD = "kestrel-demo";
export const EDITOR_PASSWORD = "fixture-editor-pw";
export const IMAGE_SIZES = [
  { name: "thumb", width: 32, height: 32, fit: "cover", format: "webp", quality: 80 },
  { name: "small", width: 64, height: 64, fit: "inside", format: "webp", quality: 80 },
  { name: "wide", width: 96, height: 48, fit: "cover", format: "original", quality: 80 },
];

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFAULT_OUT = join(REPO, "fixtures", "upgrade", VERSION);
const SEED_COPY = "seed-upgrade-fixture.mjs";
const SCOPE = "@michaelthielemann";
export const BACKUP_KEY = "backups/kestrel.db";

class GeneratorError extends Error {}

function fail(message) {
  throw new GeneratorError(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
}

function parseArgs(argv) {
  const parsed = { out: DEFAULT_OUT, keepWork: false, seed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") parsed.out = resolve(argv[++i] ?? fail("--out needs a directory"));
    else if (arg === "--keep-work") parsed.keepWork = true;
    else if (arg === "--seed") parsed.seed = true;
    else fail(`unknown argument ${arg}`);
  }
  return parsed;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, base));
    else out.push(relative(base, path).split("\\").join("/"));
  }
  return out.sort();
}

function prepareProject(work) {
  const archive = spawnSync("git", ["archive", TAG, "examples/minimal"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  if (archive.status !== 0) fail(`git archive ${TAG} failed; fetch the tag first (git fetch --tags)`);
  const extracted = spawnSync("tar", ["-x", "-C", work], { input: archive.stdout });
  if (extracted.status !== 0) fail("tar could not unpack the reference instance");
  const project = join(work, "project");
  cpSync(join(work, "examples", "minimal"), project, { recursive: true });
  rmSync(join(work, "examples"), { recursive: true, force: true });
  for (const leftover of ["config.test.ts", "manifest.json", "openapi.json", "README.md"]) rmSync(join(project, leftover), { force: true });

  const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  const dependencies = {};
  for (const name of Object.keys(manifest.dependencies)) dependencies[name] = VERSION;
  dependencies[`${SCOPE}/kestrel-backup-blobstore`] = VERSION;
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "upgrade-fixture-project", private: true, type: "module", dependencies }, null, 2)}\n`);
  return project;
}

function installedVersions(project) {
  const versions = {};
  const scope = join(project, "node_modules", "@michaelthielemann");
  for (const name of readdirSync(scope).sort()) {
    versions[`@michaelthielemann/${name}`] = JSON.parse(readFileSync(join(scope, name, "package.json"), "utf8")).version;
  }
  for (const name of ["sharp", "zod"]) {
    const file = join(project, "node_modules", name, "package.json");
    if (existsSync(file)) versions[name] = JSON.parse(readFileSync(file, "utf8")).version;
  }
  return versions;
}

async function generate(options) {
  if (existsSync(options.out) && readdirSync(options.out).length > 0) fail(`${options.out} is not empty; remove it first`);
  const work = mkdtempSync(join(tmpdir(), "kestrel-upgrade-fixture-"));
  try {
    const project = prepareProject(work);
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact"], { cwd: project });
    const versions = installedVersions(project);
    const wrong = Object.entries(versions).filter(([name, version]) => name.startsWith("@michaelthielemann/") && version !== VERSION);
    if (wrong.length > 0) fail(`installed packages differ from ${VERSION}: ${wrong.map(([n, v]) => `${n}@${v}`).join(", ")}`);

    cpSync(fileURLToPath(import.meta.url), join(project, SEED_COPY));
    run(process.execPath, ["--disable-warning=ExperimentalWarning", SEED_COPY, "--seed"], { cwd: project });

    const summary = JSON.parse(readFileSync(join(project, "seed-summary.json"), "utf8"));
    mkdirSync(options.out, { recursive: true });
    cpSync(join(project, "data", "kestrel.db"), join(options.out, "kestrel.db"));
    cpSync(join(project, "data", "blobs"), join(options.out, "blobs"), { recursive: true });
    const manifest = { version: VERSION, password: { admin: DEMO_PASSWORD, editor: EDITOR_PASSWORD }, packages: versions, ...summary, blobs: listFiles(join(options.out, "blobs")) };
    writeFileSync(join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const bytes = listFiles(options.out).reduce((sum, file) => sum + statSync(join(options.out, file)).size, 0);
    console.log(`fixture written to ${options.out} (${manifest.blobs.length} blobs, ${bytes} bytes)`);
  } finally {
    if (options.keepWork) console.log(`work directory kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

function png(width, height, seed) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const at = y * stride + 1 + x * 3;
      raw[at] = (x * 255) / width + seed * 37;
      raw[at + 1] = (y * 255) / height + seed * 91;
      raw[at + 2] = ((x + y) * 3 + seed * 53) % 256;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" fill="#336699"/><circle cx="24" cy="24" r="12" fill="#ffffff"/></svg>');

const UPLOADS = [
  { key: "logo", folder: "", filename: "logo.png", contentType: "image/png", data: () => png(96, 48, 1) },
  { key: "galleryPhoto", folder: "gallery", filename: "photo.png", contentType: "image/png", data: () => png(80, 60, 2) },
  { key: "teamPhoto", folder: "team", filename: "photo.png", contentType: "image/png", data: () => png(72, 72, 3) },
  { key: "beach", folder: "gallery/2026/summer", filename: "beach.png", contentType: "image/png", data: () => png(120, 80, 4) },
  { key: "guide", folder: "docs", filename: "guide.pdf", contentType: "application/pdf", data: () => PDF },
  { key: "mark", folder: "", filename: "mark.svg", contentType: "image/svg+xml", data: () => SVG },
  { key: "lost", folder: "gallery", filename: "lost.png", contentType: "image/png", data: () => png(64, 64, 5) },
];

const RASTER_COUNT = UPLOADS.filter((upload) => upload.contentType === "image/png").length;
const FOLDERS = ["gallery", "gallery/2026", "gallery/2026/summer", "team", "docs", "archive"];

async function seed() {
  const { boot } = await import("@michaelthielemann/kestrel");
  const { loadConfig, loadModules, loadPipelines } = await import("@michaelthielemann/kestrel/load");
  const { isErr } = await import("@michaelthielemann/kestrel/result");
  const { DatabaseSync } = await import("node:sqlite");
  const root = process.cwd();

  const config = await loadConfig(resolve(root, "kestrel.config.ts"));
  config.triggers = config.triggers.filter((trigger) => trigger.event !== undefined);
  delete config.http;
  const images = config.modules.find((entry) => entry.use.includes("images-default"));
  images.config = { ...images.config, sizes: IMAGE_SIZES };

  const modules = await loadModules(root, config);
  const pipelines = await loadPipelines(root, config.pipelinesDir ?? "./pipelines");
  const quiet = new Proxy({}, { get: (_target, level) => (level === "warn" || level === "error" ? (...args) => console.error(level, ...args) : () => {}) });
  const kestrel = await boot({ config, modules, pipelines, logger: quiet, root });
  await kestrel.start();

  const trigger = { kind: "http", name: "seed" };
  const call = async (name, input = {}, token) => {
    const result = await kestrel.run(name, { trigger, ...input, headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (result.status >= 400) throw new Error(`${name}: ${result.status} ${result.code ?? ""} ${result.error ?? ""} ${JSON.stringify(result.details ?? {})}`);
    return result.result;
  };
  const until = async (label, check) => {
    for (let i = 0; i < 400; i++) {
      if (await check()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  const admin = (await call("login", { body: { username: "admin", password: DEMO_PASSWORD } })).token;
  await call("createUser", { body: { username: "fixture-editor", password: EDITOR_PASSWORD, roles: ["editor"] } }, admin);
  const editor = (await call("login", { body: { username: "fixture-editor", password: EDITOR_PASSWORD } })).token;

  for (const folder of FOLDERS) await call("createMediaFolder", { params: { path: folder }, body: { path: folder } }, admin);
  const media = {};
  for (const upload of UPLOADS) {
    const item = await call("uploadMedia", { body: { folder: upload.folder }, files: [{ field: "file", filename: upload.filename, contentType: upload.contentType, data: upload.data() }] }, admin);
    media[upload.key] = item;
  }
  await call("updateMedia", { params: { id: media.logo.id }, body: { locale: "de", alt: "Firmenlogo", title: "Logo" } }, admin);
  await call("updateMedia", { params: { id: media.logo.id }, body: { locale: "en", alt: "Company logo", title: "Logo" } }, admin);
  await call("updateMedia", { params: { id: media.galleryPhoto.id }, body: { locale: "en", alt: "A gallery photo" } }, admin);
  await until("variants of every raster image", async () => {
    const status = await call("imagesStatus", {}, admin);
    return status.sizes.length === IMAGE_SIZES.length && status.sizes.every((size) => size.variants.done === RASTER_COUNT);
  });

  const page = (slug, title, body, extra = {}) => ({ slug, title, body, status: "published", ...extra });
  const prose = (text) => ({ id: `p-${text.length}`, type: "prose", props: { body: `<p>${text}</p>` } });
  const file = (item) => `/media/${item.id}/file`;
  const variant = (item, size, ext) => `/media/${item.id}/variants/${size}.${ext}`;
  const markup = (id, html) => ({ id, type: "prose", props: { body: html } });
  const aboutMedia = markup("m-about", [
    `<p><img src="${file(media.teamPhoto)}" alt="Team"> <img src="${file(media.galleryPhoto)}" alt="Gallery"></p>`,
    `<p><img src="${variant(media.teamPhoto, "thumb", "webp")}" alt="Team thumbnail"> <img src="${variant(media.galleryPhoto, "thumb", "webp")}" alt="Gallery thumbnail"></p>`,
    `<p><img src="${variant(media.beach, "small", "webp")}" alt="Beach"> <img src="${variant(media.beach, "wide", "png")}" alt="Beach, wide"></p>`,
    `<p><img src="${file(media.beach)}" alt="Beach original"> <img src="${file(media.mark)}" alt="Mark"> <a href="${file(media.guide)}">Guide</a></p>`,
  ].join(""));
  const galleryMedia = markup("m-gallery", `<p><img src="${variant(media.lost, "thumb", "webp")}" alt="Missing original"> <img src="${variant(media.galleryPhoto, "wide", "png")}" alt="Gallery, wide"></p>`);
  const homeEnMedia = markup("m-home-en", `<p><img src="${file(media.logo)}" alt="Logo"> <img src="${variant(media.logo, "small", "webp")}" alt="Logo, small"></p>`);
  const imageBlock = (id) => ({ id: `i-${id.slice(0, 8)}`, type: "image", props: { image: id, alt: "Fixture image" } });

  const create = async (token, body) => (await call("createPage", { body }, token)).document;
  const home = await create(admin, { locale: "de", ...page("home", "Startseite", [{ id: "h1", type: "hero", props: { heading: "Willkommen", image: media.logo.id } }, prose('Eine erfundene Startseite. <a href="https://example.com/info">Mehr</a>')], { hero: media.logo.id }) });
  await call("updatePage", { params: { id: home.id }, body: { locale: "en", ...page("home", "Home", [{ id: "h1", type: "hero", props: { heading: "Welcome", image: media.logo.id } }, prose("An invented start page."), homeEnMedia], { hero: media.logo.id }) } }, admin);
  const about = await create(admin, { locale: "de", ...page("about", "Über uns", [prose("Das Team."), imageBlock(media.teamPhoto.id)], { hero: media.teamPhoto.id }) });
  const gallery = await create(admin, { locale: "de", ...page("gallery", "Galerie", [imageBlock(media.galleryPhoto.id), imageBlock(media.beach.id), imageBlock(media.lost.id), galleryMedia], { hero: media.beach.id }) });
  const draft = await create(editor, { locale: "de", ...page("entwurf", "Entwurf", [prose("Noch nicht fertig.")], { status: "draft" }) });

  await call("setSettings", { body: { locale: "de", title: "Beispielseite", description: "Erfundene Inhalte", navigation: [{ label: "Start", path: "/" }, { label: "Über uns", path: "/about" }] } }, admin);
  await call("setSettings", { body: { locale: "en", title: "Example site", description: "Invented content", navigation: [{ label: "Start", path: "/" }] } }, admin);
  await call("setRedirects", { body: { rules: [{ from: "/old-about", to: "/about", status: "301" }, { from: "/team", to: "/about", status: "302" }] } }, admin);

  await call("replicationSnapshot", {}, admin);

  await call("updatePage", { params: { id: home.id }, body: { locale: "de", title: "Startseite (neu)", hero: media.galleryPhoto.id } }, admin);
  const revisions = await call("pageRevisions", { params: { id: home.id }, body: {}, query: { locale: "de" } }, admin);
  await call("labelPageRevision", { params: { id: home.id, revisionId: revisions.items.at(-1).id }, body: { label: "first version" } }, admin);
  await call("updatePage", { params: { id: about.id }, body: { locale: "de", body: [prose("Das Team, erweitert."), imageBlock(media.teamPhoto.id), imageBlock(media.logo.id), aboutMedia] } }, admin);
  await call("updatePage", { params: { id: gallery.id }, body: { locale: "de", hero: media.lost.id } }, admin);
  await call("updatePage", { params: { id: draft.id }, body: { locale: "de", title: "Entwurf 2" } }, editor);
  await call("replicate", {});
  await call("rebuildReferences", {}, admin);
  await call("rebuildLinks", {}, admin);
  await call("publishAllPages", {}, admin);
  await call("syncImages", {}, admin);
  await call("logout", {}, editor);

  const persistence = kestrel.contracts.get({ name: "persistence@1" });
  const variants = await persistence.findMany("images_variants", { mediaId: { eq: media.galleryPhoto.id }, size: { eq: "thumb" } }, { limit: 1 });
  const original = isErr(variants) ? undefined : variants.value.items[0];
  if (original === undefined) throw new Error("no thumb variant to duplicate");
  const copy = { ...original };
  delete copy.id;
  for (let i = 0; i < 2; i++) {
    const added = await persistence.createOne("images_variants", { ...copy, updatedAt: original.updatedAt + i + 1 });
    if (isErr(added)) throw new Error(`cannot duplicate a variant row: ${added.error.message}`);
  }

  const blobs = join(root, "data", "blobs");
  rmSync(join(blobs, media.lost.key), { force: true });

  await call("replicate", {});
  await kestrel.stop();

  const db = new DatabaseSync(join(root, "data", "kestrel.db"), { readOnly: true });
  const tables = db.prepare("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name").all().map((row) => row.name);
  const counts = {};
  for (const table of tables) counts[table] = db.prepare(`select count(*) as n from "${table}"`).get().n;
  db.close();

  const { createBackupBlobstore } = await import(`${SCOPE}/kestrel-backup-blobstore/impl`);
  const { createBlobstoreFilesystem } = await import(`${SCOPE}/kestrel-blobstore-filesystem/impl`);
  let backupClock = Date.now();
  const backup = createBackupBlobstore({ file: join(root, "data", "kestrel.db"), key: BACKUP_KEY, restoreOnStart: false, versions: 3 }, createBlobstoreFilesystem({ root: blobs }), () => backupClock);
  let backedUp;
  for (let i = 0; i < 2; i++) {
    backedUp = await backup.backup();
    if (isErr(backedUp)) throw new Error(`cannot back up the database: ${backedUp.error.message}`);
    backupClock += 60_000;
  }

  const summary = {
    media: Object.fromEntries(Object.entries(media).map(([name, item]) => [name, { id: item.id, key: item.key, folder: item.folder, filename: item.filename }])),
    missingOriginal: media.lost.id,
    duplicatedVariant: { mediaId: media.galleryPhoto.id, size: "thumb", rows: 3 },
    pages: { home: home.id, about: about.id, gallery: gallery.id, draft: draft.id },
    imageSizes: IMAGE_SIZES.map((size) => size.name),
    collections: counts,
    backup: { key: BACKUP_KEY, versions: backedUp.value.versions },
  };
  writeFileSync(join(root, "seed-summary.json"), JSON.stringify(summary));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.seed) await seed();
    else await generate(options);
  } catch (error) {
    if (!(error instanceof GeneratorError)) throw error;
    console.error(`seed-upgrade-fixture: ${error.message}`);
    process.exit(1);
  }
}
