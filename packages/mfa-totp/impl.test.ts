import { describe, expect, it } from "vitest";
import type { Identity } from "@michaelthielemann/kestrel-contracts/authn";
import type { Authz } from "@michaelthielemann/kestrel-contracts/authz";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { ok } from "@michaelthielemann/kestrel/result";
import { createHash } from "node:crypto";
import { base32Decode, createMfaTotp, FACTORS, totp, type Config } from "./impl.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ALICE: Identity = { id: "u-alice", claims: { username: "alice", roles: ["editor"] } };
const ROOT: Identity = { id: "u-root", claims: { username: "root", roles: ["admin"] } };

function config(enforce: Config["enforce"] = "all"): Config {
  return { issuer: "Example CMS", secretKey: KEY, enforce, recoveryCodes: 10, maxFailures: 10, lockSeconds: 900, requireEnrollmentCode: false };
}

async function setup(enforce: Config["enforce"] = "all", authz?: Authz, db = createFakePersistence()) {
  let t = 1_800_000_000_000;
  const mfa = await createMfaTotp(config(enforce), db, () => t, authz);
  return { db, mfa, advance: (ms: number) => { t += ms; }, now: () => t };
}

type Env = Awaited<ReturnType<typeof setup>>;

const codeAt = (secret: string, at: number, offset = 0) => totp(base32Decode(secret), Math.floor(at / 30_000) + offset);

async function enroll(env: Env, identity: Identity = ALICE) {
  const started = expectOk(await env.mfa.startSetup(identity));
  const confirmed = expectOk(await env.mfa.check(identity, codeAt(started.secret, env.now())));
  if (confirmed.kind !== "pass") throw new Error(`expected the code to pass, got ${confirmed.reason}`);
  return { secret: started.secret, uri: started.uri, recoveryCodes: confirmed.recoveryCodes ?? [] };
}

describe("mfa/totp codes", () => {
  it("computes the reference codes of the time-based one-time password standard", () => {
    const secret = Buffer.from("12345678901234567890");
    expect(totp(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totp(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totp(secret, Math.floor(2000000000 / 30))).toBe("279037");
  });

  it("refuses a secret key that is not 32 bytes", async () => {
    await expect(createMfaTotp({ ...config(), secretKey: "too-short" }, createFakePersistence())).rejects.toThrow(/32 bytes/);
  });
});

describe("mfa/totp checks", () => {
  it("asks an account without a factor to set one up before it may sign in", async () => {
    const env = await setup();
    expect(expectOk(await env.mfa.check(ALICE, undefined))).toEqual({ kind: "refuse", reason: "setup-required" });
  });

  it("confirms a new factor with a code, hands out the recovery codes once, and keeps neither the seed nor a code in the clear", async () => {
    const env = await setup();
    const { secret, uri, recoveryCodes } = await enroll(env);
    expect(uri).toBe(`otpauth://totp/Example%20CMS:alice?secret=${secret}&issuer=Example%20CMS&algorithm=SHA1&digits=6&period=30`);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    const rows = JSON.stringify(expectOk(await env.db.findMany(FACTORS, {})).items);
    expect(rows).not.toContain(secret);
    for (const code of recoveryCodes) expect(rows).not.toContain(code.replace("-", ""));
  });

  it("wants a code once the factor is set up, refuses a wrong one, and accepts each code only once", async () => {
    const env = await setup();
    const { secret } = await enroll(env);
    env.advance(30_000);
    expect(expectOk(await env.mfa.check(ALICE, undefined))).toEqual({ kind: "refuse", reason: "required" });
    const code = codeAt(secret, env.now());
    expect(expectOk(await env.mfa.check(ALICE, code === "000000" ? "111111" : "000000"))).toEqual({ kind: "refuse", reason: "wrong" });
    expect(expectOk(await env.mfa.check(ALICE, code))).toEqual({ kind: "pass" });
    expect(expectOk(await env.mfa.check(ALICE, code))).toEqual({ kind: "refuse", reason: "wrong" });
  });

  it("accepts the code of a neighbouring time step, but not two steps away", async () => {
    const env = await setup();
    const { secret } = await enroll(env);
    env.advance(90_000);
    expect(expectOk(await env.mfa.check(ALICE, codeAt(secret, env.now(), -2)))).toEqual({ kind: "refuse", reason: "wrong" });
    expect(expectOk(await env.mfa.check(ALICE, codeAt(secret, env.now(), 1)))).toEqual({ kind: "pass" });
  });

  it("accepts a recovery code once, in any spelling", async () => {
    const env = await setup();
    const { recoveryCodes } = await enroll(env);
    const first = recoveryCodes[0] ?? "";
    expect(expectOk(await env.mfa.check(ALICE, first.toLowerCase().replace("-", " ")))).toEqual({ kind: "pass" });
    expect(expectOk(await env.mfa.check(ALICE, first))).toEqual({ kind: "refuse", reason: "wrong" });
  });

  it("starts a setup only for an account without a confirmed factor", async () => {
    const env = await setup();
    await enroll(env);
    expectErr(await env.mfa.startSetup(ALICE), "CONFLICT");
  });

  it("forgets a reset factor, so the account has to set up a new one, and only with the one-time enrollment code the reset issued", async () => {
    const env = await setup();
    await enroll(env);
    const { enrollmentCode } = expectOk(await env.mfa.reset(ALICE.id));
    expect(enrollmentCode).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
    expect(JSON.stringify(expectOk(await env.db.findMany(FACTORS, {})).items)).not.toContain(enrollmentCode.replaceAll("-", ""));
    expect(expectOk(await env.mfa.check(ALICE, undefined))).toEqual({ kind: "refuse", reason: "setup-required" });
    expectErr(await env.mfa.startSetup(ALICE), "ENROLLMENT_CODE_REQUIRED");
    expectErr(await env.mfa.startSetup(ALICE, "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA"), "ENROLLMENT_CODE_REQUIRED");
    const started = expectOk(await env.mfa.startSetup(ALICE, enrollmentCode.toLowerCase()));
    expectErr(await env.mfa.startSetup(ALICE), "ENROLLMENT_CODE_REQUIRED");
    expect(expectOk(await env.mfa.check(ALICE, codeAt(started.secret, env.now()))).kind).toBe("pass");
  });

  it("with requireEnrollmentCode, an account that never had a factor needs a code an administrator issued", async () => {
    const env = await setup();
    const strict = await createMfaTotp({ ...config(), requireEnrollmentCode: true }, env.db, env.now);
    expectErr(await strict.startSetup(ROOT), "ENROLLMENT_CODE_REQUIRED");
    const { enrollmentCode } = expectOk(await strict.reset(ROOT.id));
    expectOk(await strict.startSetup(ROOT, enrollmentCode));
  });

  it("forgets every trace of a deleted user", async () => {
    const env = await setup();
    await enroll(env);
    expectOk(await env.mfa.forget(ALICE.id));
    expect(expectOk(await env.db.count(FACTORS, {}))).toBe(0);
  });

  it("lets an account without a factor through when none is required", async () => {
    const env = await setup("none");
    expect(expectOk(await env.mfa.check(ALICE, undefined))).toEqual({ kind: "pass" });
  });

  it("requires the factor only of accounts holding a listed permission", async () => {
    const authz: Authz = { async can(identity, permission) { return ok(permission === "users.manage" && Array.isArray(identity.claims.roles) && identity.claims.roles.includes("admin")); } };
    const env = await setup({ permissions: ["users.manage"] }, authz);
    expect(expectOk(await env.mfa.check(ALICE, undefined))).toEqual({ kind: "pass" });
    expect(expectOk(await env.mfa.check(ROOT, undefined))).toEqual({ kind: "refuse", reason: "setup-required" });
  });

  it("names the users with a factor", async () => {
    const env = await setup();
    await enroll(env);
    expectOk(await env.mfa.startSetup(ROOT));
    expect([...expectOk(await env.mfa.usersWithFactor())]).toEqual([ALICE.id]);
  });

  it("hands out recovery codes of at least 112 bits and keeps them only as keyed digests", async () => {
    const env = await setup();
    const { recoveryCodes } = await enroll(env);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
    const rows = JSON.stringify(expectOk(await env.db.findMany(FACTORS, {})).items);
    for (const code of recoveryCodes) expect(rows).not.toContain(createHash("sha256").update(code.replaceAll("-", "")).digest("hex"));
  });

  it("locks the factor after ten wrong codes in a row, for longer each time, and lets the right code in again afterwards", async () => {
    const env = await setup();
    const { secret } = await enroll(env);
    const wrong = () => (codeAt(secret, env.now()) === "000000" ? "111111" : "000000");
    for (let i = 0; i < 10; i++) {
      env.advance(30_000);
      expect(expectOk(await env.mfa.check(ALICE, wrong()))).toEqual({ kind: "refuse", reason: "wrong" });
    }
    env.advance(30_000);
    expect(expectOk(await env.mfa.check(ALICE, codeAt(secret, env.now())))).toEqual({ kind: "refuse", reason: "locked", retryAfterSeconds: 870 });
    env.advance(870_000);
    for (let i = 0; i < 10; i++) {
      env.advance(30_000);
      expectOk(await env.mfa.check(ALICE, wrong()));
    }
    env.advance(30_000);
    expect(expectOk(await env.mfa.check(ALICE, codeAt(secret, env.now())))).toMatchObject({ kind: "refuse", reason: "locked", retryAfterSeconds: 1770 });
    env.advance(1_770_000);
    expect(expectOk(await env.mfa.check(ALICE, codeAt(secret, env.now())))).toEqual({ kind: "pass" });
    for (let i = 0; i < 9; i++) {
      env.advance(30_000);
      expectOk(await env.mfa.check(ALICE, wrong()));
    }
    env.advance(30_000);
    expect(expectOk(await env.mfa.check(ALICE, codeAt(secret, env.now())))).toEqual({ kind: "pass" });
  });

  it("keeps the count across a restart", async () => {
    const db = createFakePersistence();
    const env = await setup("all", undefined, db);
    const { secret } = await enroll(env);
    for (let i = 0; i < 10; i++) {
      env.advance(30_000);
      expectOk(await env.mfa.check(ALICE, codeAt(secret, env.now()) === "000000" ? "111111" : "000000"));
    }
    const again = await createMfaTotp(config(), db, env.now);
    expect(expectOk(await again.check(ALICE, codeAt(secret, env.now())))).toMatchObject({ kind: "refuse", reason: "locked" });
  });

  it("lets one of two concurrent checks with the same code pass, and one recovery code sign in once", async () => {
    const env = await setup();
    const { secret, recoveryCodes } = await enroll(env);
    env.advance(30_000);
    const code = codeAt(secret, env.now());
    const both = await Promise.all([env.mfa.check(ALICE, code), env.mfa.check(ALICE, code)]);
    expect(both.map((r) => expectOk(r).kind).sort()).toEqual(["pass", "refuse"]);
    const recovery = recoveryCodes[0] ?? "";
    const twice = await Promise.all([env.mfa.check(ALICE, recovery), env.mfa.check(ALICE, recovery)]);
    expect(twice.map((r) => expectOk(r).kind).sort()).toEqual(["pass", "refuse"]);
  });
});
