import { describe, expect, it } from "vitest";
import { isSecretName, isSecretSchema, isSecretValue, REDACTED, snapshotValue } from "./configValue.ts";

describe("isSecretName", () => {
  it("catches the usual credential words in any spelling", () => {
    for (const key of ["password", "passwordHash", "password_hash", "secret", "secretAccessKey", "token", "refresh-token", "credentials", "authorization", "passphrase", "dsn", "connectionString"]) {
      expect(isSecretName(key)).toBe(true);
    }
  });

  it("leaves a plain key, a prefix and ordinary names alone", () => {
    for (const key of ["key", "keyPrefix", "file", "bucket", "roleClaim", "publicPath", "keepAlive", "monkey"]) {
      expect(isSecretName(key)).toBe(false);
    }
  });

  it("takes a key only together with a word that makes it a credential", () => {
    expect(isSecretName("accessKeyId")).toBe(true);
    expect(isSecretName("apiKey")).toBe(true);
    expect(isSecretName("signingKeys")).toBe(true);
  });
});

describe("isSecretValue", () => {
  it("is true for a URL that carries credentials", () => {
    expect(isSecretValue("postgres://user:pw@db.example/app")).toBe(true);
    expect(isSecretValue("https://user:pw@example.com")).toBe(true);
  });

  it("is false for a URL without them and for anything that is not a string", () => {
    expect(isSecretValue("https://example.com:8080/path")).toBe(false);
    expect(isSecretValue("/var/data/app.db")).toBe(false);
    expect(isSecretValue(42)).toBe(false);
  });
});

describe("isSecretSchema", () => {
  it("reads writeOnly, format password and x-secret", () => {
    expect(isSecretSchema({ type: "string", writeOnly: true })).toBe(true);
    expect(isSecretSchema({ type: "string", format: "password" })).toBe(true);
    expect(isSecretSchema({ type: "string", "x-secret": true })).toBe(true);
    expect(isSecretSchema({ type: "string", format: "email" })).toBe(false);
  });
});

describe("snapshotValue", () => {
  it("passes primitives and plain structures through", () => {
    expect(snapshotValue("de")).toBe("de");
    expect(snapshotValue(3000)).toBe(3000);
    expect(snapshotValue(false)).toBe(false);
    expect(snapshotValue(null)).toBe(null);
    expect(snapshotValue(undefined)).toBe(null);
    expect(snapshotValue({ a: [1, "x", { b: true }] })).toEqual({ a: [1, "x", { b: true }] });
  });

  it("labels what JSON cannot hold", () => {
    expect(snapshotValue(() => 1)).toBe("[function]");
    expect(snapshotValue(Buffer.from("abcd"))).toBe("[Buffer 4 bytes]");
    expect(snapshotValue(new Uint8Array(3))).toBe("[Uint8Array 3 bytes]");
    expect(snapshotValue(new ArrayBuffer(8))).toBe("[ArrayBuffer 8 bytes]");
    expect(snapshotValue(new Map([["a", 1]]))).toBe("[Map 1 entries]");
    expect(snapshotValue(new Set([1, 2]))).toBe("[Set 2 items]");
    expect(snapshotValue(new URL("https://example.com"))).toBe("[URL]");
    expect(snapshotValue(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(snapshotValue(/ab+/i)).toBe("[RegExp ab+]");
    expect(snapshotValue(10n)).toBe("[bigint 10]");
    expect(snapshotValue(Number.POSITIVE_INFINITY)).toBe("[number Infinity]");
  });

  it("truncates a long string, a long array and a wide object", () => {
    expect(snapshotValue("x".repeat(260))).toBe(`${"x".repeat(200)}…[+60 chars]`);
    const array = snapshotValue(Array.from({ length: 25 }, (_, i) => i));
    expect(Array.isArray(array) && array.length).toBe(21);
    expect(Array.isArray(array) && array[20]).toBe("…[+5 items]");
    const wide = snapshotValue(Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`k${String(i)}`, i])));
    expect(wide).toMatchObject({ k0: 0, k19: 19, "…": "[+3 keys]" });
    expect(wide).not.toHaveProperty("k20");
  });

  it("stops at depth and at a cycle", () => {
    expect(snapshotValue({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })).toEqual({ a: { b: { c: { d: { e: { f: "[object]" } } } } } });
    const cycle: Record<string, unknown> = { name: "x" };
    cycle.self = cycle;
    expect(snapshotValue(cycle)).toEqual({ name: "x", self: "[circular]" });
  });

  it("redacts nested credential keys and credential URLs wherever they sit", () => {
    expect(snapshotValue({ user: "admin", password: "pw", nested: { apiKey: "k" } })).toEqual({ user: "admin", password: REDACTED, nested: { apiKey: REDACTED } });
    expect(snapshotValue({ endpoint: "postgres://user:pw@db/app" })).toEqual({ endpoint: REDACTED });
  });
});
