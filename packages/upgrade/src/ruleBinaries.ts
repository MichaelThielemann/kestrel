import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { SourceRule, SourceRuleContext } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { finding, packageJsonPath, upgradingDocs } from "./ruleHelpers.ts";

const RULE = "scripts/kestrel-binaries";
const DOCS = upgradingDocs("scripts-kestrel-binaries");

const DLX = /(^|[;&|]|\n)(\s*)(pnpm\s+dlx|npx(?:\s+(?:-y|--yes))?)\s+@michaelthielemann\/kestrel-upgrade(@[^\s"'`;&|]+)?(?=\s|$|[;&|])/g;
const SCRIPT_TOKEN = /(^|[;&|]|\n|node_modules\/\.bin\/)(\s*)(kestrel-openapi|kestrel-upgrade)(?![\w@./-])/g;
const FILE_TOKEN = /(^|[\s"'`;&|(=]|node_modules\/\.bin\/)(kestrel-openapi|kestrel-upgrade)(?![\w@./-])/;

const OPENAPI_VALUE_FLAGS = new Set(["--out", "--title", "--version", "--server", "--mount", "--root", "--run-setup"]);
const OPENAPI_BOOLEAN_FLAGS = new Set(["--no-plugins"]);

function replacement(command: string): string {
  return command === "kestrel-openapi" ? "kestrel openapi" : "kestrel upgrade";
}

/** The command with every removed binary replaced by its `kestrel` subcommand; unchanged when nothing matched. */
export function rewriteCommand(command: string): string {
  return command
    .replace(DLX, (_m, sep: string, space: string, runner: string, version: string | undefined) => {
      const prefix = runner.startsWith("pnpm") ? "pnpm dlx" : "npx -y";
      return `${sep}${space}${prefix} @michaelthielemann/kestrel-cli${version ?? ""} upgrade`;
    })
    .replace(SCRIPT_TOKEN, (_m, sep: string, space: string, bin: string) => `${sep}${space}${replacement(bin)}`);
}

/** The flags after each `kestrel openapi` in `command` that the command's strict parser refuses. */
export function refusedOpenapiFlags(command: string): string[] {
  const refused: string[] = [];
  for (const match of command.matchAll(/(?:^|[;&|\s/])kestrel\s+openapi\b([^;&|]*)/g)) {
    const tokens = (match[1] ?? "").trim().split(/\s+/).filter((t) => t !== "");
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!token.startsWith("-")) continue;
      if (OPENAPI_BOOLEAN_FLAGS.has(token)) continue;
      if (OPENAPI_VALUE_FLAGS.has(token)) {
        i++;
        continue;
      }
      refused.push(token);
    }
  }
  return refused;
}

interface ScriptValue {
  name: string;
  start: number;
  end: number;
  raw: string;
}

function scriptValues(source: string): ScriptValue[] {
  const key = /"scripts"\s*:\s*\{/.exec(source);
  if (key === null) return [];
  const out: ScriptValue[] = [];
  const entry = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(,|\})/g;
  entry.lastIndex = key.index + key[0].length;
  for (let match = entry.exec(source); match !== null; match = entry.exec(source)) {
    const valueStart = match.index + match[0].indexOf(":") + match[0].slice(match[0].indexOf(":")).indexOf('"') + 1;
    out.push({ name: match[1]!, start: valueStart, end: valueStart + match[2]!.length, raw: match[2]! });
    if (match[3] === "}") break;
  }
  return out;
}

const SCANNED_NAMES = [/^Dockerfile/, /\.service$/, /\.ya?ml$/, /\.sh$/, /^Makefile$/, /^Procfile$/, /\.json$/, /\.[cm]?js$/, /\.[cm]?ts$/];
const SKIPPED_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

function scannedFiles(dir: string, top: boolean, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !(top && entry.name === "sandbox")) scannedFiles(path, false, out);
      continue;
    }
    if (!entry.isFile() || SKIPPED_FILES.has(entry.name)) continue;
    if (SCANNED_NAMES.some((pattern) => pattern.test(entry.name))) out.push(path);
  }
  return out;
}

function packageScriptFindings(ctx: SourceRuleContext): Finding[] {
  const file = packageJsonPath(ctx);
  const source = ctx.readFile(file);
  if (source === undefined) return [];
  const findings: Finding[] = [];
  for (const value of scriptValues(source)) {
    const rewritten = rewriteCommand(value.raw);
    if (rewritten === value.raw) continue;
    const edit: Edit = { file, start: value.start, end: value.end, text: rewritten };
    findings.push(finding(`${RULE}:script:${value.name}`, RULE, `script "${value.name}" runs a binary that 6.0.0 removed: ${value.raw}`, `run "${rewritten}" instead`, { file }, [edit], DOCS));
    const refused = refusedOpenapiFlags(rewritten);
    if (refused.length > 0) {
      findings.push(finding(`${RULE}:openapi-flag:${value.name}`, RULE, `script "${value.name}" passes ${refused.join(", ")} to kestrel openapi, which refuses unknown flags`, `remove ${refused.join(", ")} from the script`, { file }, undefined, DOCS, "warning"));
    }
  }
  return findings;
}

function otherFileFindings(ctx: SourceRuleContext): Finding[] {
  const findings: Finding[] = [];
  for (const file of scannedFiles(ctx.root, true)) {
    if (basename(file) === "package.json") continue;
    const source = ctx.readFile(file);
    if (source === undefined) continue;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = FILE_TOKEN.exec(line);
      if (match === null) continue;
      const rewritten = rewriteCommand(line.replace(FILE_TOKEN, (_m, sep: string, bin: string) => `${sep}${replacement(bin)}`));
      findings.push(finding(`${RULE}:${file}:${i + 1}`, RULE, `${basename(file)} line ${i + 1} runs ${match[2]!}, a binary 6.0.0 removed`, `change the line to: ${rewritten.trim()}`, { file, line: i + 1 }, undefined, DOCS, "warning"));
    }
  }
  return findings;
}

/** `scripts/kestrel-binaries`: rewrites the removed `kestrel-openapi`/`kestrel-upgrade` binaries in package.json scripts and warns about them in other project files. */
export const kestrelBinariesRule: SourceRule = {
  id: RULE,
  needs: "source",
  check(ctx) {
    return [...packageScriptFindings(ctx), ...otherFileFindings(ctx)];
  },
};
