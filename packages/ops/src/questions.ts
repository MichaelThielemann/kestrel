import { OpsError } from "./errors.ts";
import { fixedText, literal } from "./redact.ts";

/**
 * Stable ids of the questions the tool can ask. `confirm`, `prune-delete` and `update-stop` have a safe default that
 * `--yes` takes; the others are risky branches that `--yes` never answers: they need an explicit `accept` in the
 * answers file or at the prompt. `rollback-accepted` takes the environment's name instead of `accept`.
 */
export const QUESTIONS = {
  confirm: { risky: false },
  "unsealed-stop": { risky: true },
  "access-changes": { risky: true },
  "unreadable-current": { risky: true },
  "prune-delete": { risky: false },
  "break-lock": { risky: true },
  "update-stop": { risky: false },
  "rollback-accepted": { risky: true },
  "cleanup-delete": { risky: true },
} as const;

export type QuestionId = keyof typeof QUESTIONS;

/** Asks the operator; resolves to the answer typed. */
export type Prompt = (question: string) => Promise<string>;

/** How questions are answered in a run. */
export interface AnswerSource {
  /** Answers by question id, from `--answers <file>`. */
  answers: Record<string, string>;
  /** `--yes`: take the safe default of every question that has one. */
  yes: boolean;
  /** Ask at a terminal; absent when the run is not interactive. */
  prompt?: Prompt;
}

/**
 * Asks question `id`; resolves when the answer is yes or accept, throws an {@link OpsError} otherwise. `text` is
 * best composed with {@link fixedText}, so a credential equal to a word of the question leaves it as written.
 */
export async function confirm(source: AnswerSource, id: QuestionId, text: string): Promise<void> {
  const given = source.answers[id];
  const accepted = (value: string): boolean => /^(y|yes|accept)$/i.test(value.trim());
  const name = literal(id);
  if (given !== undefined) {
    if (accepted(given)) return;
    throw new OpsError(fixedText`stopped: the answers file answers "${name}" with "${given}"`, 1, id);
  }
  if (!QUESTIONS[id].risky && source.yes) return;
  if (source.prompt) {
    const answer = await source.prompt(fixedText`${text}\n${QUESTIONS[id].risky ? literal('Type "accept" to continue') : literal("Continue? [y/N]")} (${name}): `);
    if (QUESTIONS[id].risky ? answer.trim().toLowerCase() === "accept" : accepted(answer)) return;
    throw new OpsError(fixedText`stopped at "${name}"`, 1, id);
  }
  throw new OpsError(fixedText`stopped: "${name}" needs an answer${QUESTIONS[id].risky ? fixedText` ("${name}": "accept" in --answers; --yes does not answer it)` : literal(" (--yes or --answers)")}. ${text}`, 1, id);
}
