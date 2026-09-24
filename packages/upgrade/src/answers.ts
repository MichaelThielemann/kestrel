import { createInterface } from "node:readline/promises";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { isRecord, isString } from "./guards.ts";
import type { AskFix, Finding } from "./report.ts";

export type PromptFn = (question: string, choices: readonly string[], defaultValue: string | undefined) => Promise<string>;

/** The real prompt: node:readline against the process's own stdin/stdout. */
export const ttyPrompt: PromptFn = async (question, choices, defaultValue) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const choiceText = choices.length > 0 ? ` (${choices.join(" / ")})` : "";
    const defaultText = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const line = await rl.question(`${question}${choiceText}${defaultText} `);
    const trimmed = line.trim();
    return trimmed === "" ? (defaultValue ?? "") : trimmed;
  } finally {
    rl.close();
  }
};

export function parseAnswersFile(source: string): Map<string, string> {
  const parsed = boundaryCast<unknown>(JSON.parse(source), "json");
  if (!isRecord(parsed)) throw new Error("--answers file must contain a JSON object of { id: value }");
  const map = new Map<string, string>();
  for (const [id, value] of Object.entries(parsed)) {
    if (!isString(value)) throw new Error(`--answers: "${id}" must be a string value`);
    map.set(id, value);
  }
  return map;
}

export function askFindings(findings: readonly Finding[]): Array<{ finding: Finding; fix: AskFix }> {
  return findings.flatMap((finding) => (finding.fix.kind === "ask" ? [{ finding, fix: finding.fix }] : []));
}

export interface ResolveOptions {
  fromFile?: ReadonlyMap<string, string>;
  yes: boolean;
  interactive: boolean;
  prompt: PromptFn;
}

/**
 * Resolves one question's answer in order: `--answers`, then a TTY prompt when interactive, then
 * `--yes`'s default. `undefined` means the finding stays open — no edit, no crash.
 */
export async function resolveAnswer(fix: AskFix, message: string, options: ResolveOptions): Promise<string | undefined> {
  const fromFile = options.fromFile?.get(fix.question);
  if (fromFile !== undefined) return fromFile;
  if (options.interactive) return options.prompt(`${message}\n${fix.prompt}`, fix.choices, fix.defaultValue);
  if (options.yes) return fix.defaultValue;
  return undefined;
}

/** Every id in the answers file that never matched an asked question: `--answers` refuses these (exit 2). */
export function unknownAnswerIds(fromFile: ReadonlyMap<string, string>, everAsked: ReadonlySet<string>): string[] {
  return [...fromFile.keys()].filter((id) => !everAsked.has(id));
}
