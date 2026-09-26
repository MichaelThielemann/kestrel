import { readdirSync } from "node:fs";
import { join } from "node:path";
import { renameStringLiterals, rewriteMovedNamedImports, type MovedSpecifier } from "./edits.ts";
import type { Rule } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { finding, upgradingDocs } from "./ruleHelpers.ts";

const RULE_ID = "imports/contract-helpers";

const MOVED_HELPERS: readonly string[] = ["content-locale", "content-schema", "mediaType", "persistence.owned", "steps"];

const MIXED_MOVES: readonly MovedSpecifier[] = [
  { from: "events.envelope", to: "helpers/events.envelope", except: { EventEnvelope: "events.steps", EventIdentity: "events.steps" } },
  { from: "events.steps", except: { relaySummary: "helpers/events.envelope", mergeRelayReport: "helpers/events.envelope" } },
  { from: "stepSet", to: "helpers/stepSet", except: { StepSet: undefined } },
  { from: "links", to: "helpers/links", except: { INTERNAL_REF: undefined, InternalRef: undefined, LinkTarget: undefined } },
];

function oldSpecifier(name: string): string {
  return `@michaelthielemann/kestrel-contracts/${name}`;
}

function newSpecifier(name: string): string {
  return `@michaelthielemann/kestrel-contracts/helpers/${name}`;
}

const SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".vue"];
const EXCLUDED_DIRS = new Set(["node_modules", "dist"]);

function projectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || EXCLUDED_DIRS.has(entry.name)) continue;
        walkDir(path);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(path);
    }
  };
  walkDir(root);
  return out;
}

/** `imports/contract-helpers`: a consumer import of a contracts helper by a subpath the package does not export. */
export const contractHelperImportsRule: Rule = {
  id: RULE_ID,
  check(ctx) {
    const findings: Finding[] = [];
    for (const file of projectSourceFiles(ctx.scratch)) {
      const source = ctx.readFile(file);
      if (source === undefined) continue;
      const edits: Edit[] = [];
      const names: string[] = [];
      for (const name of MOVED_HELPERS) {
        const renamed = renameStringLiterals(file, source, oldSpecifier(name), newSpecifier(name));
        if (renamed.length === 0) continue;
        edits.push(...renamed);
        names.push(name);
      }
      for (const move of MIXED_MOVES) {
        const rewritten = rewriteMovedNamedImports(file, source, move);
        if (rewritten.length === 0) continue;
        edits.push(...rewritten);
        names.push(move.from);
      }
      if (edits.length === 0) continue;
      findings.push(
        finding(
          `${RULE_ID}:${file}`,
          RULE_ID,
          `imports a contracts helper (${names.join(", ")}) by a subpath the package does not export`,
          "rewrite the import specifier(s) to their helpers/<name> subpath",
          { file },
          edits,
          upgradingDocs("imports-contract-helpers"),
        ),
      );
    }
    return findings;
  },
};
