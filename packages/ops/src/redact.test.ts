import { describe, expect, it } from "vitest";
import { fixedText, literal, MASK, Redactor } from "./redact.ts";

const redactorOf = (...secrets: string[]): Redactor => {
  const redactor = new Redactor();
  for (const secret of secrets) redactor.add(secret);
  return redactor;
};

describe("Redactor.apply on text the tool composes", () => {
  it("keeps the literal parts and literal values and masks a credential in an interpolated value", () => {
    const redactor = redactorOf("kestrel", "update", "prod");
    const cause = "the store answered AccessDenied for kestrel";
    const line = fixedText`kestrel update resume --env ${literal("prod")} --run ${literal("a1b2c3")} failed: ${cause}`;
    expect(line).toBe("kestrel update resume --env prod --run a1b2c3 failed: the store answered AccessDenied for kestrel");
    expect(redactor.apply(line)).toBe(`kestrel update resume --env prod --run a1b2c3 failed: the store answered AccessDenied for ${MASK}`);
  });

  it("masks every credential of a plain string, also where it is part of a word", () => {
    expect(redactorOf("kestrel").apply("next: kestrel update accept --env prod")).toBe(`next: ${MASK} update accept --env prod`);
    expect(redactorOf("kestrel").apply("bucket kestrel-media")).toBe(`bucket ${MASK}-media`);
  });

  it("masks an interpolated value that is not marked as literal, even when it equals a word of the literal parts", () => {
    expect(redactorOf("prod").apply(fixedText`--env ${"prod"} for prod`)).toBe(`--env ${MASK} for prod`);
  });

  it("keeps numbers and the structure of a composed string interpolated into another one", () => {
    const redactor = redactorOf("kestrel", "update");
    const inner = fixedText`kestrel update accept --run ${literal("ff00")} after ${"a call that quoted kestrel"}`;
    const outer = fixedText`update run ${literal("ff00")} took ${12} s; ${inner}`;
    expect(redactor.apply(outer)).toBe(`update run ff00 took 12 s; kestrel update accept --run ff00 after a call that quoted ${MASK}`);
  });

  it("masks a credential that spans a literal part and a value", () => {
    expect(redactorOf("kestrel-x9").apply(fixedText`app kestrel${"-x9 failed"}`)).toBe(`app ${MASK} failed`);
  });

  it("masks a credential of real length wherever it appears, also in a literal value", () => {
    const secret = "AKIA0123456789ABCDEF";
    expect(redactorOf(secret).apply(fixedText`--run ${literal(secret)}`)).toBe(`--run ${MASK}`);
  });

  it("masks the URL-encoded and JSON-escaped forms of a credential in a value", () => {
    const redactor = redactorOf("p@ss \"word\"");
    expect(redactor.apply(fixedText`url ${"https://u:p%40ss%20%22word%22@host"} json ${'{"k":"p@ss \\"word\\""}'}`)).toBe(`url https://u:${MASK}@host json {"k":"${MASK}"}`);
  });

  it("masks every interpolated value of a text that was composed twice with different parts", () => {
    const redactor = redactorOf("prod");
    const first = fixedText`env ${literal("prod")}`;
    const again = fixedText`env ${"prod"}`;
    expect(again).toBe(first);
    expect(redactor.apply(again)).toBe(`env ${MASK}`);
    expect(redactor.apply(fixedText`env ${literal("prod")}`)).toBe(`env ${MASK}`);
  });

  it("masks free-text fields of a document by the parts of the text they hold", () => {
    const redactor = redactorOf("update");
    const message = fixedText`run update resume --env ${literal("prod")} after ${"update refused"}`;
    expect(JSON.parse(redactor.document({ schema: "kestrel-ops/update-deploy@1", message }))).toEqual({ schema: "kestrel-ops/update-deploy@1", message: `run update resume --env prod after ${MASK} refused` });
  });
});
