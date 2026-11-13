import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createAuthnMulti } from "./impl.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, scrypt: vi.fn(actual.scrypt), scryptSync: vi.fn(actual.scryptSync), timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const config = { identifier: "username" as const, minPasswordLength: 8, sessionTtlSeconds: 60, adminPermission: "users.manage" };

async function setup() {
  const authn = await createAuthnMulti(config, createFakePersistence());
  expectOk(await authn.createUser({ username: "bob", password: "long-enough" }));
  const carol = expectOk(await authn.createUser({ username: "carol", password: "long-enough" }));
  expectOk(await authn.setActive(carol.id, false));
  return authn;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

interface KeyWork {
  derivations: { password: unknown; saltBytes: number; keyBytes: unknown; options: unknown }[];
  comparisons: [number, number][];
}

async function keyWorkOf(login: () => Promise<unknown>): Promise<KeyWork> {
  vi.mocked(crypto.scrypt).mockClear();
  vi.mocked(crypto.timingSafeEqual).mockClear();
  await login();
  return {
    derivations: vi.mocked(crypto.scrypt).mock.calls.map(([password, salt, keyBytes, options]) => ({ password, saltBytes: typeof salt === "string" ? Buffer.byteLength(salt) : salt.byteLength, keyBytes, options: typeof options === "function" ? undefined : options })),
    comparisons: vi.mocked(crypto.timingSafeEqual).mock.calls.map(([a, b]) => [a.byteLength, b.byteLength]),
  };
}

describe("authn/multi password checks", () => {
  beforeEach(() => {
    vi.mocked(crypto.scrypt).mockClear();
    vi.mocked(crypto.scryptSync).mockClear();
  });

  it("derives the key exactly once per login, whether the user is unknown, inactive or has another password", async () => {
    const authn = await setup();
    for (const username of ["nobody", "carol", "bob"]) {
      vi.mocked(crypto.scrypt).mockClear();
      vi.mocked(crypto.scryptSync).mockClear();
      expect(expectOk(await authn.login({ username, password: "wrong-password" }))).toBeNull();
      expect(vi.mocked(crypto.scrypt).mock.calls.length + vi.mocked(crypto.scryptSync).mock.calls.length, username).toBe(1);
    }
  });

  it("derives the key off the event loop", async () => {
    const authn = await setup();
    for (const username of ["nobody", "bob"]) {
      vi.mocked(crypto.scryptSync).mockClear();
      await authn.login({ username, password: "wrong-password" });
      expect(vi.mocked(crypto.scryptSync), username).not.toHaveBeenCalled();
    }
  });

  it("derives and compares a key of the same cost for an unknown user as for a known one with a wrong password", async () => {
    const authn = await setup();
    const unknown = await keyWorkOf(() => authn.login({ username: "nobody", password: "wrong-password" }));
    const known = await keyWorkOf(() => authn.login({ username: "bob", password: "wrong-password" }));
    expect(known.derivations).toHaveLength(1);
    expect(known.comparisons).toEqual([[64, 64]]);
    expect(unknown).toEqual(known);
  });

  it("keeps the event loop free while a password is checked", async () => {
    const authn = await setup();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const scheduled = performance.now();
      const tick = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - scheduled), 0));
      const login = authn.login({ username: "bob", password: "wrong-password" });
      delays.push(await tick);
      await login;
    }
    expect(median(delays)).toBeLessThan(5);
  });
});
