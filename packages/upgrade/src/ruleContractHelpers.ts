import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseTs } from "./ast.ts";
import { renameStringLiterals, rewriteMovedNamedImports, unsplittableMovedImportSpans, type MovedSpecifier } from "./edits.ts";
import type { Rule } from "./plugin.ts";
import type { Edit, Finding } from "./report.ts";
import { finding, upgradingDocs } from "./ruleHelpers.ts";

const RULE_ID = "imports/contract-helpers";
const UNSPLIT_RULE_ID = "imports/contract-helpers-unresolved";

const MOVED_HELPERS: readonly string[] = ["content-locale", "content-schema", "mediaType", "persistence.owned", "steps"];

const MIXED_MOVES: readonly MovedSpecifier[] = [
  { from: "events.envelope", to: "helpers/events.envelope", except: { EventEnvelope: "events.steps", EventIdentity: "events.steps" } },
  { from: "events.steps", except: { relaySummary: "helpers/events.envelope", mergeRelayReport: "helpers/events.envelope" } },
  { from: "stepSet", to: "helpers/stepSet", except: { StepSet: undefined } },
  { from: "links", to: "helpers/links", except: { INTERNAL_REF: undefined, InternalRef: undefined, LinkTarget: undefined } },
  { from: "persistence", except: { fieldDefinition: "helpers/persistence" } },
  { from: "renderer", except: { renderFailed: "helpers/renderer" } },
  { from: "migrations", except: { migrationFailed: "helpers/migrations" } },
];

function oldSpecifier(name: string): string {
  return `@michaelthielemann/kestrel-contracts/${name}`;
}

function newSpecifier(name: string): string {
  return `@michaelthielemann/kestrel-contracts/helpers/${name}`;
}

const SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".vue"];
const EXCLUDED_DIRS = new Set(["node_modules", "dist"]);

export function projectSourceFiles(root: string): string[] {
  return projectFiles(root, (name) => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)));
}

export function projectPackageJsonFiles(root: string): string[] {
  return projectFiles(root, (name) => name === "package.json");
}

function projectFiles(root: string, accept: (name: string) => boolean): string[] {
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
      if (entry.isFile() && accept(entry.name)) out.push(path);
    }
  };
  walkDir(root);
  return out;
}

const VUE_SCRIPT_BLOCK = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi;

function vueScriptRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = new RegExp(VUE_SCRIPT_BLOCK.source, VUE_SCRIPT_BLOCK.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const open = match[1] ?? "";
    const body = match[2] ?? "";
    const start = match.index + open.length;
    ranges.push({ start, end: start + body.length });
  }
  return ranges;
}

function parses(source: string): boolean {
  try {
    parseTs(source);
    return true;
  } catch {
    return false;
  }
}

interface Scan {
  edits: Edit[];
  names: string[];
  unresolvedFrom: string[];
  unparseable: boolean;
}

const CONTRACTS_REFERENCE = /@michaelthielemann\/kestrel-contracts\//;

function scanSlice(file: string, source: string): Omit<Scan, "unparseable"> {
  const edits: Edit[] = [];
  const names: string[] = [];
  for (const name of MOVED_HELPERS) {
    const renamed = renameStringLiterals(file, source, oldSpecifier(name), newSpecifier(name));
    if (renamed.length === 0) continue;
    edits.push(...renamed);
    names.push(name);
  }
  const unresolvedFrom: string[] = [];
  for (const move of MIXED_MOVES) {
    const rewritten = rewriteMovedNamedImports(file, source, move);
    if (rewritten.length > 0) {
      edits.push(...rewritten);
      names.push(move.from);
    }
    if (unsplittableMovedImportSpans(source, move).length > 0) unresolvedFrom.push(move.from);
  }
  return { edits, names, unresolvedFrom };
}

function offsetEdits(edits: readonly Edit[], by: number): Edit[] {
  return by === 0 ? [...edits] : edits.map((e) => ({ ...e, start: e.start + by, end: e.end + by }));
}

function scanFile(file: string, source: string): Scan {
  const ranges = file.endsWith(".vue") ? vueScriptRanges(source) : [{ start: 0, end: source.length }];
  const scan: Scan = { edits: [], names: [], unresolvedFrom: [], unparseable: false };
  for (const range of ranges) {
    const slice = source.slice(range.start, range.end);
    if (!parses(slice)) {
      if (CONTRACTS_REFERENCE.test(slice)) scan.unparseable = true;
      continue;
    }
    const found = scanSlice(file, slice);
    scan.edits.push(...offsetEdits(found.edits, range.start));
    scan.names.push(...found.names);
    scan.unresolvedFrom.push(...found.unresolvedFrom);
  }
  return scan;
}

/** `imports/contract-helpers`: a consumer import of a contracts helper by a subpath the package does not export. */
export const contractHelperImportsRule: Rule = {
  id: RULE_ID,
  check(ctx) {
    const findings: Finding[] = [];
    for (const file of projectSourceFiles(ctx.scratch)) {
      const source = ctx.readFile(file);
      if (source === undefined || !CONTRACTS_REFERENCE.test(source)) continue;
      let scan: Scan;
      try {
        scan = scanFile(file, source);
      } catch {
        continue;
      }
      if (scan.edits.length > 0) {
        const names = [...new Set(scan.names)];
        findings.push(
          finding(
            `${RULE_ID}:${file}`,
            RULE_ID,
            `imports a contracts helper (${names.join(", ")}) by a subpath the package does not export`,
            "rewrite the import specifier(s) to their helpers/<name> subpath",
            { file },
            scan.edits,
            upgradingDocs("imports-contract-helpers"),
          ),
        );
      }
      const unresolvedFrom = [...new Set(scan.unresolvedFrom)];
      if (unresolvedFrom.length > 0) {
        findings.push(
          finding(
            `${UNSPLIT_RULE_ID}:${file}`,
            UNSPLIT_RULE_ID,
            `reaches @michaelthielemann/kestrel-contracts/${unresolvedFrom.join(", ")} through a namespace, default, side-effect, export * or dynamic import; some of its names moved under helpers/*`,
            "name each symbol explicitly: import it from @michaelthielemann/kestrel-contracts/<name> if it stayed, or from @michaelthielemann/kestrel-contracts/helpers/<name> if it moved",
            { file },
            undefined,
            upgradingDocs("imports-contract-helpers"),
            "warning",
          ),
        );
      } else if (scan.unparseable) {
        findings.push(
          finding(
            `${UNSPLIT_RULE_ID}:${file}`,
            UNSPLIT_RULE_ID,
            "mentions @michaelthielemann/kestrel-contracts/ but could not be parsed to check for a moved import",
            "check this file by hand for an import of a contracts helper at its pre-6.0.0 path",
            { file },
            undefined,
            upgradingDocs("imports-contract-helpers"),
            "warning",
          ),
        );
      }
    }
    return findings;
  },
};
