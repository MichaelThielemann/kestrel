#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = (process.env.KESTREL_RELEASE_REGISTRY ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const PLAN = "release.json";
const SUMS = "SHA512SUMS";

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function args(argv) {
  const out = { command: argv[0], dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--tag") out.tag = argv[++i];
    else if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "--root") out.root = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else fail(`unknown argument ${argv[i]}`);
  }
  return out;
}

function versionOf(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? "");
  if (match === null) fail(`"${tag ?? ""}" is not a release tag of the form v<major>.<minor>.<patch>`);
  return match[1];
}

function publishablePackages(root) {
  const packagesDir = join(root, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")))
    .map((entry) => {
      const dir = join(packagesDir, entry.name);
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return { dir, name: manifest.name, version: manifest.version, private: manifest.private === true };
    })
    .filter((pkg) => !pkg.private)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function integrityOf(file) {
  return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

function sha512Hex(file) {
  return createHash("sha512").update(readFileSync(file)).digest("hex");
}

async function publishedIntegrity(name, version) {
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`, { signal: globalThis.AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  if (!response.ok) fail(`the registry answered ${response.status} for ${name}@${version}`);
  const body = await response.json();
  return typeof body?.dist?.integrity === "string" ? body.dist.integrity : "";
}

function plan(options) {
  const root = resolve(options.root ?? ROOT);
  const version = versionOf(options.tag);
  const packages = publishablePackages(root);
  const mismatched = packages.filter((pkg) => pkg.version !== version);
  if (mismatched.length > 0) fail(`every published package must carry the tag version ${version}: ${mismatched.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`);
  if (packages.length === 0) fail("no publishable package found");
  const dir = resolve(options.dir ?? "release-artifacts");
  mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const pkg of packages) {
    execFileSync("pnpm", ["pack", "--pack-destination", dir], { cwd: pkg.dir, stdio: ["ignore", "ignore", "inherit"] });
    const file = tarballName(pkg.name, pkg.version);
    if (!existsSync(join(dir, file))) fail(`pnpm pack did not write ${file}`);
    entries.push({ name: pkg.name, version: pkg.version, file, integrity: integrityOf(join(dir, file)) });
  }
  writeFileSync(join(dir, PLAN), `${JSON.stringify({ tag: options.tag, packages: entries }, null, 2)}\n`);
  writeFileSync(join(dir, SUMS), entries.map((entry) => `${sha512Hex(join(dir, entry.file))}  ${entry.file}\n`).join(""));
  for (const entry of entries) process.stdout.write(`packed  ${entry.name}@${entry.version}\n`);
}

async function publish(options) {
  const dir = resolve(options.dir ?? "release-artifacts");
  const version = versionOf(options.tag);
  const release = JSON.parse(readFileSync(join(dir, PLAN), "utf8"));
  if (release.tag !== options.tag) fail(`the artifacts were built for ${release.tag}, not ${options.tag}`);
  const sums = new Map(readFileSync(join(dir, SUMS), "utf8").trim().split("\n").map((line) => {
    const [hash, file] = line.split(/\s+/);
    return [file, hash];
  }));
  for (const entry of release.packages) {
    if (entry.version !== version) fail(`${entry.name}@${entry.version} does not carry the tag version ${version}`);
    const file = join(dir, entry.file);
    if (sums.get(entry.file) !== sha512Hex(file) || integrityOf(file) !== entry.integrity) fail(`${entry.file} does not match its recorded checksum`);
  }
  for (const entry of release.packages) {
    const published = await publishedIntegrity(entry.name, entry.version);
    if (published === entry.integrity) {
      process.stdout.write(`done    ${entry.name}@${entry.version} (this artifact is already on the registry)\n`);
      continue;
    }
    if (published !== null) fail(`${entry.name}@${entry.version} is already on the registry with different content; nothing of this release is published after it`);
    process.stdout.write(`publish ${entry.name}@${entry.version}\n`);
    if (options.dryRun) continue;
    execFileSync("pnpm", ["publish", join(dir, entry.file), "--access", "public", "--provenance", "--no-git-checks"], { cwd: dir, stdio: "inherit" });
  }
}

const options = args(process.argv.slice(2));
if (options.command === "plan") plan(options);
else if (options.command === "publish") await publish(options);
else fail("usage: release.mjs plan --tag v<version> [--dir <dir>] | publish --tag v<version> [--dir <dir>] [--dry-run]");
