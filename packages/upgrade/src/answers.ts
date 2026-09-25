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
  fromFile?: ReadonlyMap<string, string> | undefined;
  yes: boolean;
  interactive: boolean;
  prompt: PromptFn;
}

/**
 * Resolves one question's answer in order: `--answers`, then a TTY prompt when interactive, then
 * `--yes`'s default. `undefined` means the finding stays open — no edit, no crash. `fix.closedChoices`
 * decides whether the answer is checked against `fix.choices` at all: a question whose `choices` are
 * only a default or example (a comma list, a free-form name, a literal path) never validates, since
 * the rule parses the raw answer itself. A rejected answer from `--answers` leaves the question open;
 * from a TTY prompt, the question is asked again.
 */
export async function resolveAnswer(fix: AskFix, message: string, options: ResolveOptions): Promise<string | undefined> {
  const validate = fix.closedChoices === true;
  const fromFile = options.fromFile?.get(fix.question);
  if (fromFile !== undefined) return !validate || fix.choices.includes(fromFile) ? fromFile : undefined;
  if (options.interactive) {
    for (;;) {
      const answer = await options.prompt(`${message}\n${fix.prompt}`, fix.choices, fix.defaultValue);
      if (!validate || fix.choices.includes(answer)) return answer;
    }
  }
  if (options.yes) return fix.defaultValue;
  return undefined;
}

const KNOWN_QUESTION_IDS = new Set(["switch-to-queue", "relay-pipelines", "field-step"]);
const KNOWN_QUESTION_PREFIXES = ["idempotent:", "binary:", "verified-user-path:", "underscore-field:", "emits:"];

function isKnownQuestionFamily(id: string): boolean {
  return KNOWN_QUESTION_IDS.has(id) || KNOWN_QUESTION_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Every id in the answers file that neither matched an asked question nor belongs to a built-in
 * rule's own question family: `--answers` refuses these (exit 2). A plugin's own custom rule and its
 * own question ids are not in this family list, so a stale answer of its own still counts as unknown.
 */
export function unknownAnswerIds(fromFile: ReadonlyMap<string, string>, everAsked: ReadonlySet<string>): string[] {
  return [...fromFile.keys()].filter((id) => !everAsked.has(id) && !isKnownQuestionFamily(id));
}

/**
 * Every id in the answers file that belongs to a built-in rule's own question family but this run
 * never asked it: an earlier pass's answer that pass's own edit has since resolved, or a question this
 * run's conditions never reach. `--answers` notes these instead of refusing them, so an answers file
 * accumulated across several passes keeps working as later passes resolve what earlier ones asked.
 */
export function staleAnswerIds(fromFile: ReadonlyMap<string, string>, everAsked: ReadonlySet<string>): string[] {
  return [...fromFile.keys()].filter((id) => !everAsked.has(id) && isKnownQuestionFamily(id));
}

/** Every answers-file value that named an asked, closed-choice question but does not match its choices: `--answers` refuses these (exit 2), naming the id and the value, instead of leaving the question silently open. */
export function invalidClosedAnswers(fromFile: ReadonlyMap<string, string>, askedFixes: ReadonlyMap<string, AskFix>): Array<{ id: string; value: string }> {
  const invalid: Array<{ id: string; value: string }> = [];
  for (const [id, value] of fromFile) {
    const fix = askedFixes.get(id);
    if (fix !== undefined && fix.closedChoices === true && !fix.choices.includes(value)) invalid.push({ id, value });
  }
  return invalid;
}
