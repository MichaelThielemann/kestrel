import { OpsError } from "./errors.ts";

/**
 * Stable ids of the questions the tool can ask. `confirm` has a safe default that `--yes` takes; the others are
 * risky branches that `--yes` never answers: they need an explicit `accept` in the answers file or at the prompt.
 */
export const QUESTIONS = {
  confirm: { risky: false },
  "unsealed-stop": { risky: true },
  "access-changes": { risky: true },
  "prune-delete": { risky: false },
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

/** Asks question `id`; resolves when the answer is yes or accept, throws an {@link OpsError} otherwise. */
export async function confirm(source: AnswerSource, id: QuestionId, text: string): Promise<void> {
  const given = source.answers[id];
  const accepted = (value: string): boolean => /^(y|yes|accept)$/i.test(value.trim());
  if (given !== undefined) {
    if (accepted(given)) return;
    throw new OpsError(`stopped: the answers file answers "${id}" with "${given}"`, 1, id);
  }
  if (!QUESTIONS[id].risky && source.yes) return;
  if (source.prompt) {
    const answer = await source.prompt(`${text}\n${QUESTIONS[id].risky ? 'Type "accept" to continue' : "Continue? [y/N]"} (${id}): `);
    if (QUESTIONS[id].risky ? answer.trim().toLowerCase() === "accept" : accepted(answer)) return;
    throw new OpsError(`stopped at "${id}"`, 1, id);
  }
  throw new OpsError(`stopped: "${id}" needs an answer${QUESTIONS[id].risky ? ` ("${id}": "accept" in --answers; --yes does not answer it)` : " (--yes or --answers)"}. ${text}`, 1, id);
}
