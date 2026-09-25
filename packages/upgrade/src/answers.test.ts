import { describe, expect, it } from "vitest";
import type { AskFix } from "./report.ts";
import { invalidClosedAnswers, parseAnswersFile, resolveAnswer, staleAnswerIds, unknownAnswerIds } from "./answers.ts";

const fix: AskFix = { kind: "ask", question: "binary:notes/local.create", prompt: "should this step's result be binary?", choices: ["no", "yes"], closedChoices: true, defaultValue: "no" };

describe("resolveAnswer", () => {
  it("prefers an answer from the file over everything else", async () => {
    const value = await resolveAnswer(fix, "msg", { fromFile: new Map([["binary:notes/local.create", "yes"]]), yes: true, interactive: true, prompt: () => Promise.resolve("nope") });
    expect(value).toBe("yes");
  });

  it("prompts when interactive and no file answer exists", async () => {
    let asked: string | undefined;
    const value = await resolveAnswer(fix, "msg", {
      yes: false,
      interactive: true,
      prompt: (q) => {
        asked = q;
        return Promise.resolve("yes");
      },
    });
    expect(value).toBe("yes");
    expect(asked).toContain("should this step's result be binary?");
  });

  it("falls back to the default under --yes when not interactive", async () => {
    const value = await resolveAnswer(fix, "msg", { yes: true, interactive: false, prompt: () => Promise.reject(new Error("must not prompt")) });
    expect(value).toBe("no");
  });

  it("leaves the question open with neither a file, a TTY nor --yes", async () => {
    const value = await resolveAnswer(fix, "msg", { yes: false, interactive: false, prompt: () => Promise.reject(new Error("must not prompt")) });
    expect(value).toBeUndefined();
  });

  it("--yes on a question with no default also leaves it open", async () => {
    const noDefault: AskFix = { kind: "ask", question: fix.question, prompt: fix.prompt, choices: fix.choices };
    const value = await resolveAnswer(noDefault, "msg", { yes: true, interactive: false, prompt: () => Promise.reject(new Error("must not prompt")) });
    expect(value).toBeUndefined();
  });

  it("rejects a file answer that is not one of a closed choice set, leaving the question open", async () => {
    const value = await resolveAnswer(fix, "msg", { fromFile: new Map([["binary:notes/local.create", "split manually"]]), yes: true, interactive: true, prompt: () => Promise.resolve("no") });
    expect(value).toBeUndefined();
  });

  it("accepts a file answer that matches one of a closed choice set", async () => {
    const value = await resolveAnswer(fix, "msg", { fromFile: new Map([["binary:notes/local.create", "yes"]]), yes: false, interactive: false, prompt: () => Promise.reject(new Error("must not prompt")) });
    expect(value).toBe("yes");
  });

  it("re-prompts on a TTY answer outside a closed choice set instead of accepting it", async () => {
    const answers = ["maybe", "yes"];
    let asked = 0;
    const value = await resolveAnswer(fix, "msg", {
      yes: false,
      interactive: true,
      prompt: () => {
        asked++;
        return Promise.resolve(answers.shift()!);
      },
    });
    expect(value).toBe("yes");
    expect(asked).toBe(2);
  });

  it("never validates against an open choice set (a template entry, or a pre-joined example)", async () => {
    const openFix: AskFix = { kind: "ask", question: "relay-pipelines", prompt: "which pipelines?", choices: ["publishPage, unpublishPage"], defaultValue: "publishPage, unpublishPage" };
    const value = await resolveAnswer(openFix, "msg", { fromFile: new Map([["relay-pipelines", "otherPipeline"]]), yes: false, interactive: false, prompt: () => Promise.reject(new Error("must not prompt")) });
    expect(value).toBe("otherPipeline");
  });
});

describe("unknownAnswerIds", () => {
  it("flags an id from the file that no question ever asked", () => {
    const fromFile = new Map([["binary:x", "yes"], ["nope:y", "yes"]]);
    expect(unknownAnswerIds(fromFile, new Set(["binary:x"]))).toEqual(["nope:y"]);
  });

  it("never flags an id from a built-in rule's own question family, even when this run never asked it", () => {
    const fromFile = new Map([["field-step", "yes"], ["idempotent:oldPipeline", "yes"], ["nope:y", "yes"]]);
    expect(unknownAnswerIds(fromFile, new Set())).toEqual(["nope:y"]);
  });
});

describe("staleAnswerIds", () => {
  it("flags an id from a known rule's question family this run never asked", () => {
    const fromFile = new Map([["field-step", "yes"], ["idempotent:oldPipeline", "yes"], ["nope:y", "yes"]]);
    expect(staleAnswerIds(fromFile, new Set())).toEqual(["field-step", "idempotent:oldPipeline"]);
  });

  it("never flags an id this run did ask, or one no family recognizes", () => {
    const fromFile = new Map([["field-step", "yes"], ["nope:y", "yes"]]);
    expect(staleAnswerIds(fromFile, new Set(["field-step"]))).toEqual([]);
  });
});

describe("invalidClosedAnswers", () => {
  it("flags a value that does not match its question's closed choices", () => {
    const fromFile = new Map([["binary:x", "maybe"]]);
    const askedFixes = new Map([["binary:x", fix]]);
    expect(invalidClosedAnswers(fromFile, askedFixes)).toEqual([{ id: "binary:x", value: "maybe" }]);
  });

  it("never flags a question whose choices are not closed", () => {
    const openFix: AskFix = { kind: "ask", question: "relay-pipelines", prompt: "which pipelines?", choices: ["publishPage"], defaultValue: "publishPage" };
    const fromFile = new Map([["relay-pipelines", "otherPipeline"]]);
    const askedFixes = new Map([["relay-pipelines", openFix]]);
    expect(invalidClosedAnswers(fromFile, askedFixes)).toEqual([]);
  });

  it("never flags an id no question asked (unknownAnswerIds already covers it)", () => {
    const fromFile = new Map([["nope:y", "yes"]]);
    expect(invalidClosedAnswers(fromFile, new Map())).toEqual([]);
  });
});

describe("parseAnswersFile", () => {
  it("parses a flat object of string answers", () => {
    expect(parseAnswersFile('{"a": "yes", "b": "no"}')).toEqual(new Map([["a", "yes"], ["b", "no"]]));
  });

  it("rejects a non-string value", () => {
    expect(() => parseAnswersFile('{"a": 1}')).toThrow(/must be a string/);
  });

  it("rejects a non-object document", () => {
    expect(() => parseAnswersFile("[1,2]")).toThrow(/JSON object/);
  });
});
