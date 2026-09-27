import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createAuthnSingle, hashPassword } from "./impl.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, scrypt: vi.fn(actual.scrypt), scryptSync: vi.fn(actual.scryptSync) };
});

const config = { username: "admin", passwordHash: hashPassword("secret"), sessionTtlSeconds: 60, roles: ["admin"] };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

describe("authn/single password checks", () => {
  it("derives the key exactly once per login, off the event loop, for an unknown user and for a wrong password", async () => {
    const authn = createAuthnSingle(config);
    for (const username of ["nobody", "admin"]) {
      vi.mocked(crypto.scrypt).mockClear();
      vi.mocked(crypto.scryptSync).mockClear();
      expect(expectOk(await authn.login({ username, password: "wrong-password" }))).toBeNull();
      expect(vi.mocked(crypto.scrypt), username).toHaveBeenCalledTimes(1);
      expect(vi.mocked(crypto.scryptSync), username).not.toHaveBeenCalled();
    }
  });

  it("takes as long for an unknown user as for the known one with a wrong password", async () => {
    const authn = createAuthnSingle(config);
    const unknown: number[] = [];
    const known: number[] = [];
    for (let i = 0; i < 21; i++) {
      unknown.push(await timed(() => authn.login({ username: "nobody", password: "wrong-password" })));
      known.push(await timed(() => authn.login({ username: "admin", password: "wrong-password" })));
    }
    expect(Math.abs(median(unknown.map((ms, i) => ms - (known[i] ?? 0))))).toBeLessThan(5);
  });

  it("keeps the event loop free while a password is checked", async () => {
    const authn = createAuthnSingle(config);
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const scheduled = performance.now();
      const tick = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - scheduled), 0));
      const login = authn.login({ username: "admin", password: "wrong-password" });
      delays.push(await tick);
      await login;
    }
    expect(median(delays)).toBeLessThan(5);
  });
});
