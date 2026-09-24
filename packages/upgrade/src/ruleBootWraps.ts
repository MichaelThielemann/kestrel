import { markStepBinary, setStepRequired } from "./edits.ts";
import type { Rule } from "./plugin.ts";
import type { AskFix, Edit, Finding } from "./report.ts";
import { finding, moduleOwningStep, shortStepKey, whereOf } from "./ruleHelpers.ts";

function wrapManual(ruleId: string, code: string, docsAnchor: string): Rule {
  return {
    id: ruleId,
    check(ctx) {
      return ctx.bootCheck.errors
        .filter((e) => e.code === code)
        .map((e) =>
          finding(`${ruleId}:${e.pipeline ?? e.module ?? ""}:${e.step ?? ""}:${e.path ?? ""}`, ruleId, e.reason, "this needs a human decision; boot() names the exact location above", whereOf({ pipeline: e.pipeline, module: e.module, step: e.step, path: e.path }), undefined, `docs/upgrading.md#${docsAnchor}`),
        );
    },
  };
}

/** `undeclared-output`: a step writes `result` without declaring what it returns. Asks whether the result is binary; a "no" (or no answer) stays manual. */
export const undeclaredOutputRule: Rule = {
  id: "steps/undeclared-output",
  check(ctx) {
    return ctx.bootCheck.errors
      .filter((e) => e.code === "undeclared-output")
      .map((e) => {
        const owner = moduleOwningStep(ctx, e.step ?? "");
        const id = `steps/undeclared-output:${e.pipeline ?? ""}:${e.step ?? ""}`;
        const where = whereOf({ pipeline: e.pipeline, module: owner?.name, step: e.step });
        if (owner?.file === undefined) return finding(id, "steps/undeclared-output", e.reason, "the owning module's file could not be located; declare output, extendsOutput, extendsItems or binary: true by hand", where, undefined, "docs/upgrading.md#steps-undeclared-output");
        const answer = ctx.answers.get(`binary:${owner.name}.${shortStepKey(e.step ?? "")}`);
        if (answer === "yes") {
          const source = ctx.readFile(owner.file);
          const edits: Edit[] = [];
          if (source !== undefined) {
            const edit = markStepBinary(owner.file, source, shortStepKey(e.step ?? ""));
            if (edit) edits.push(edit);
          }
          return finding(id, "steps/undeclared-output", e.reason, `binary: true added to ${e.step}'s describe() entry`, where, edits, "docs/upgrading.md#steps-undeclared-output");
        }
        if (answer === "no") return finding(id, "steps/undeclared-output", e.reason, "declare output, extendsOutput or extendsItems by hand", where, undefined, "docs/upgrading.md#steps-undeclared-output");
        const fix: AskFix = { kind: "ask", question: `binary:${owner.name}.${shortStepKey(e.step ?? "")}`, prompt: `is "${e.step}"'s result a binary body?`, choices: ["no", "yes"], defaultValue: "no" };
        return { id, rule: "steps/undeclared-output", severity: "error", tier: "boot", where, message: e.reason, suggestion: "a \"yes\" adds binary: true; a \"no\" stays manual (declare output/extendsOutput/extendsItems by hand)", fix, docs: "docs/upgrading.md#steps-undeclared-output" } satisfies Finding;
      });
  },
  applyAnswer(id, value, ctx) {
    if (!id.startsWith("binary:") || value !== "yes") return undefined;
    const rest = id.slice("binary:".length);
    const dot = rest.lastIndexOf(".");
    if (dot === -1) return undefined;
    const file = ctx.project.moduleFiles.get(rest.slice(0, dot));
    const source = file === undefined ? undefined : ctx.readFile(file);
    if (file === undefined || source === undefined) return undefined;
    const edit = markStepBinary(file, source, rest.slice(dot + 1));
    return edit ? [edit] : undefined;
  },
};

/** `undeclared-required`: an output schema declares properties without saying which are always present. Asks which ones are, or accepts "none" (`required: []`). */
export const undeclaredRequiredRule: Rule = {
  id: "steps/undeclared-required",
  check(ctx) {
    return ctx.bootCheck.errors
      .filter((e) => e.code === "undeclared-required")
      .map((e) => {
        const owner = moduleOwningStep(ctx, e.step ?? "");
        const id = `steps/undeclared-required:${e.pipeline ?? ""}:${e.step ?? ""}:${e.path ?? ""}`;
        const where = whereOf({ pipeline: e.pipeline, module: owner?.name, step: e.step, path: e.path });
        const questionId = `required:${owner?.name ?? ""}.${shortStepKey(e.step ?? "")}:${e.path ?? ""}`;
        if (owner?.file === undefined || e.path !== "$.output") {
          return finding(id, "steps/undeclared-required", e.reason, "declare required at this schema path by hand (only the top-level $.output schema is edited automatically)", where, undefined, "docs/upgrading.md#steps-undeclared-required");
        }
        const answer = ctx.answers.get(questionId);
        if (answer !== undefined && answer !== "manual") {
          const properties = answer === "all" ? undefined : answer === "none" ? [] : answer.split(",").map((s) => s.trim()).filter((s) => s !== "");
          if (properties !== undefined) {
            const source = ctx.readFile(owner.file);
            const edits: Edit[] = [];
            if (source !== undefined) {
              const edit = setStepRequired(owner.file, source, shortStepKey(e.step ?? ""), properties);
              if (edit) edits.push(edit);
            }
            return finding(id, "steps/undeclared-required", e.reason, `required: [${properties.map((p) => `"${p}"`).join(", ")}] added`, where, edits, "docs/upgrading.md#steps-undeclared-required");
          }
        }
        const fix: AskFix = { kind: "ask", question: questionId, prompt: `which of "${e.step}"'s output properties are always present? (comma-separated, "all", or "none")`, choices: ["all", "none", "<comma-separated>", "manual"] };
        return { id, rule: "steps/undeclared-required", severity: "error", tier: "boot", where, message: e.reason, suggestion: "no default: declaring required makes a claim nobody verified yet", fix, docs: "docs/upgrading.md#steps-undeclared-required" } satisfies Finding;
      });
  },
  applyAnswer(id, value, ctx) {
    if (!id.startsWith("required:") || value === "manual") return undefined;
    const rest = id.slice("required:".length);
    const [target] = rest.split(":");
    const dot = target?.lastIndexOf(".") ?? -1;
    if (target === undefined || dot === -1) return undefined;
    const file = ctx.project.moduleFiles.get(target.slice(0, dot));
    const source = file === undefined ? undefined : ctx.readFile(file);
    if (file === undefined || source === undefined) return undefined;
    const properties = value === "all" ? [] : value === "none" ? [] : value.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const edit = setStepRequired(file, source, target.slice(dot + 1), properties);
    return edit ? [edit] : undefined;
  },
};

export const outputFoldRule = wrapManual("steps/output-fold", "output-fold-contradiction", "steps-output-fold");
export const terminalOutputRule = wrapManual("steps/terminal-output", "terminal-output-misplaced", "steps-terminal-output");
export const optionalReadOrderRule = wrapManual("pipelines/optional-read-order", "optional-read-order", "pipelines-optional-read-order");
export const dependencyCycleRule = wrapManual("boot/dependency-cycle", "dependency-cycle", "boot-dependency-cycle");

/** `unwritten-optional-read` is a boot *warning*, not an error: an optional read whose key nothing writes and no trigger provides. */
export const unwrittenOptionalReadRule: Rule = {
  id: "pipelines/unwritten-optional-read",
  check(ctx) {
    return ctx.bootCheck.warnings
      .filter((w) => w.code === "unwritten-optional-read")
      .map((w) => finding(`pipelines/unwritten-optional-read:${w.pipeline}:${w.step}:${w.key}`, "pipelines/unwritten-optional-read", w.message, "almost always a typo in the key; check the reading step by hand", whereOf({ pipeline: w.pipeline, step: w.step, path: w.key }), undefined, "docs/upgrading.md#pipelines-unwritten-optional-read", "warning"));
  },
};

export const bootWrapRules: readonly Rule[] = [undeclaredOutputRule, undeclaredRequiredRule, outputFoldRule, terminalOutputRule, optionalReadOrderRule, dependencyCycleRule, unwrittenOptionalReadRule];
