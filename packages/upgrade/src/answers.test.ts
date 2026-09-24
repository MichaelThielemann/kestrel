import { describe, expect, it } from "vitest";
import type { AskFix } from "./report.ts";
import { parseAnswersFile, resolveAnswer, unknownAnswerIds } from "./answers.ts";

const fix: AskFix = { kind: "ask", question: "binary:notes/local.create", prompt: "should this step's result be binary?", choices: ["no", "yes"], defaultValue: "no" };

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
});

describe("unknownAnswerIds", () => {
  it("flags an id from the file that no question ever asked", () => {
    const fromFile = new Map([["binary:x", "yes"], ["nope:y", "yes"]]);
    expect(unknownAnswerIds(fromFile, new Set(["binary:x"]))).toEqual(["nope:y"]);
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
