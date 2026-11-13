import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot as bootKestrel, defineModule } from "@michaelthielemann/kestrel";
import type { Context } from "@michaelthielemann/kestrel/context";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { createDeviceCookies, DEVICE_COOKIE, SECURE_DEVICE_COOKIE } from "./device.ts";
import module from "./module.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY = "f".repeat(64);
const PASSWORD = "correct horse";

function cookieHeader(setCookie: string): Record<string, string> {
  return { cookie: setCookie.split(";")[0] ?? "" };
}

describe("device cookies", () => {
  it("are HttpOnly, SameSite=Strict, Secure with the __Host- name, limited in lifetime, and valid only for the exact account name they were issued for", () => {
    const cookies = createDeviceCookies({ secretKey: KEY, maxAgeSeconds: 3600, secure: true });
    const issued = cookies.issue("owner");
    expect(issued).toMatch(new RegExp(`^${SECURE_DEVICE_COOKIE}=[^;]+; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict$`));
    expect(cookies.verify(cookieHeader(issued), "owner")).toBeDefined();
    for (const lookalike of [" OWNER ", "Owner", "ｏｗｎｅｒ", "owner ", "someone-else"]) expect(cookies.verify(cookieHeader(issued), lookalike)).toBeUndefined();
    expect(cookies.verify({}, "owner")).toBeUndefined();
  });

  it("drop the Secure flag and the __Host- name only when told to", () => {
    const issued = createDeviceCookies({ secretKey: KEY, maxAgeSeconds: 60, secure: false }).issue("account");
    expect(issued.startsWith(`${DEVICE_COOKIE}=`)).toBe(true);
    expect(issued).not.toContain("Secure");
  });

  it("stop being valid once their lifetime is over", () => {
    let t = 1_000_000;
    const cookies = createDeviceCookies({ secretKey: KEY, maxAgeSeconds: 60, secure: true }, () => t);
    const issued = cookieHeader(cookies.issue("account"));
    t += 59_000;
    expect(cookies.verify(issued, "account")).toBeDefined();
    t += 1_000;
    expect(cookies.verify(issued, "account")).toBeUndefined();
  });

  it("refuse a changed signature, lifetime or device, and a cookie signed under an unknown key", () => {
    const cookies = createDeviceCookies({ secretKey: KEY, maxAgeSeconds: 60, secure: true });
    const [name, value = ""] = (cookieHeader(cookies.issue("account")).cookie ?? "").split("=");
    const [expires = "", nonce = "", signature = ""] = value.split(".");
    const forged = (v: string) => ({ cookie: `${name}=${v}` });
    expect(cookies.verify(forged(`${Number(expires) + 1000}.${nonce}.${signature}`), "account")).toBeUndefined();
    expect(cookies.verify(forged(`${expires}.${"A".repeat(22)}.${signature}`), "account")).toBeUndefined();
    expect(cookies.verify(forged(`${expires}.${nonce}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`), "account")).toBeUndefined();
    expect(cookies.verify(forged(`${expires}.${nonce}.${signature}.x`), "account")).toBeUndefined();
    const other = createDeviceCookies({ secretKey: OTHER_KEY, maxAgeSeconds: 60, secure: true });
    expect(other.verify(forged(value), "account")).toBeUndefined();
  });

  it("stay valid across a key change while the old key is listed as a previous key", () => {
    const issued = cookieHeader(createDeviceCookies({ secretKey: KEY, maxAgeSeconds: 60, secure: true }).issue("account"));
    expect(createDeviceCookies({ secretKey: OTHER_KEY, previousSecretKeys: [KEY], maxAgeSeconds: 60, secure: true }).verify(issued, "account")).toBeDefined();
    expect(createDeviceCookies({ secretKey: OTHER_KEY, maxAgeSeconds: 60, secure: true }).verify(issued, "account")).toBeUndefined();
  });

  it("refuse a key that is not 32 bytes", () => {
    expect(() => createDeviceCookies({ secretKey: "too-short", maxAgeSeconds: 60, secure: true })).toThrow(/32 bytes/);
  });
});

const signIn = defineModule({
  name: "signin/test",
  provides: [],
  requires: [],
  configSchema: z.object({}),
  async setup() {
    return {};
  },
  steps: () => {
    const signInBy = (field: "username" | "email") => async (ctx: Context) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const name = ctx.payload[field];
      if (typeof name !== "string" || ctx.payload.password !== PASSWORD) return ctx.fail("UNAUTHENTICATED", "invalid credentials");
      return ok({ ...ctx, identity: { id: `user-${name}`, claims: { username: name } }, result: { ok: true } });
    };
    return { login: signInBy("username"), loginByEmail: signInBy("email") };
  },
  describe: () => ({
    login: { summary: "Signs in to the account named exactly by payload.username, with one fixed password", reads: [], writes: ["identity", "result"], output: { type: "object" } },
    loginByEmail: { summary: "Signs in to the account named exactly by payload.email, with one fixed password", reads: [], writes: ["identity", "result"], output: { type: "object" } },
  }),
});

const ACCOUNT = { limit: 3, windowSeconds: 300, key: "username", counts: "failures", maxBlockSeconds: 900, knownDevices: { limit: 4, windowSeconds: 300, maxBlockSeconds: 900 } };

async function bootLogin(buckets: Record<string, unknown> = { account: ACCOUNT }, signInStep = "signin.login") {
  const kestrel = await bootKestrel({
    config: {
      modules: [{ use: "./signin.ts", config: {} }, { use: "@michaelthielemann/kestrel-ratelimit-memory", config: { buckets, deviceCookies: { secretKey: KEY } } }],
      triggers: [],
      http: null,
    },
    modules: [signIn, module],
    pipelines: [definePipeline({ name: "login", steps: ["ratelimit.check:account", signInStep, "ratelimit.rememberDevice:account"] })],
    logger: silentLogger,
  });
  const attempt = (username: string, password: string, headers: Record<string, string> = {}) => kestrel.run("login", { trigger: { kind: "http", name: "POST /login" }, ip: "192.0.2.1", headers, body: { username, password } });
  const send = (body: Record<string, unknown>, headers: Record<string, string> = {}) => kestrel.run("login", { trigger: { kind: "http", name: "POST /login" }, ip: "192.0.2.1", headers, body });
  return { kestrel, attempt, send };
}

type Attempt = Awaited<ReturnType<typeof bootLogin>>["attempt"];

async function deviceOf(attempt: Attempt, username: string): Promise<Record<string, string>> {
  const signedIn = await attempt(username, PASSWORD);
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.cookies?.[0];
  expect(cookie).toMatch(new RegExp(`^${SECURE_DEVICE_COOKIE}=`));
  return cookieHeader(cookie ?? "");
}

describe("known devices at sign-in", () => {
  it("hand out a device cookie after a successful sign-in, and none after a failed one", async () => {
    const { kestrel, attempt } = await bootLogin();
    expect((await attempt("owner", "wrong")).cookies).toBeUndefined();
    await deviceOf(attempt, "owner");
    await kestrel.stop();
  });

  it("let the owner with a device cookie sign in while a third party without one has blocked the account", async () => {
    const { kestrel, attempt } = await bootLogin();
    const device = await deviceOf(attempt, "owner");
    const attacks = [];
    for (let i = 0; i < 6; i++) attacks.push((await attempt("owner", "guess")).status);
    expect(attacks).toEqual([401, 401, 401, 429, 429, 429]);
    expect((await attempt("owner", PASSWORD)).status).toBe(429);
    expect((await attempt("owner", PASSWORD, device)).status).toBe(200);
    expect((await attempt("owner", PASSWORD)).status).toBe(429);
    await kestrel.stop();
  });

  it("keep a parallel wave of guesses at the account limit, and let the owner's device through in the middle of it", async () => {
    const { kestrel, attempt } = await bootLogin();
    const device = await deviceOf(attempt, "owner");
    const wave = await Promise.all([...Array.from({ length: 50 }, () => attempt("owner", "guess")), attempt("owner", PASSWORD, device), ...Array.from({ length: 50 }, () => attempt("owner", "guess"))]);
    const owner = wave[50];
    const guesses = [...wave.slice(0, 50), ...wave.slice(51)].map((result) => result.status);
    expect(owner?.status).toBe(200);
    expect(guesses.filter((status) => status === 401)).toHaveLength(3);
    expect(guesses.filter((status) => status === 429)).toHaveLength(97);
    await kestrel.stop();
  });

  it("do not let a parallel wave of guesses from a stolen device cookie through beyond the device's own budget and then the account's", async () => {
    const { kestrel, attempt } = await bootLogin();
    const device = await deviceOf(attempt, "owner");
    const wave = await Promise.all(Array.from({ length: 40 }, () => attempt("owner", "guess", device)));
    const statuses = wave.map((result) => result.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(4 + 3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(33);
    await kestrel.stop();
  });

  it("count a device that keeps failing in its own budget, then treat it as unknown", async () => {
    const { kestrel, attempt } = await bootLogin();
    const device = await deviceOf(attempt, "owner");
    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await attempt("owner", "guess", device)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401, 401, 429, 429]);
    expect((await attempt("owner", PASSWORD, device)).status).toBe(429);
    await kestrel.stop();
  });

  it("do not help with another account than the one the cookie was issued for", async () => {
    const { kestrel, attempt } = await bootLogin();
    const device = await deviceOf(attempt, "owner");
    for (let i = 0; i < 3; i++) expect((await attempt("colleague", "guess")).status).toBe(401);
    expect((await attempt("colleague", PASSWORD, device)).status).toBe(429);
    await kestrel.stop();
  });

  it("clear a known device's failures when it signs in, and leave the block for unknown devices in place", async () => {
    const { kestrel, attempt } = await bootLogin();
    const device = await deviceOf(attempt, "owner");
    for (let i = 0; i < 3; i++) expect((await attempt("owner", "guess", device)).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await attempt("owner", "guess")).status).toBe(401);
    expect((await attempt("owner", PASSWORD, device)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await attempt("owner", "guess", device)).status).toBe(401);
    expect((await attempt("owner", PASSWORD)).status).toBe(429);
    await kestrel.stop();
  });
});

describe("device cookies of look-alike accounts", () => {
  it("do not help against an account whose name only differs in case, width or surrounding space, however many of them are collected", async () => {
    const { kestrel, attempt } = await bootLogin();
    const cookies: Record<string, string>[] = [];
    for (const lookalike of ["OWNER", "Owner", "ｏｗｎｅｒ", " owner "]) for (let i = 0; i < 5; i++) cookies.push(await deviceOf(attempt, lookalike));
    const wave = await Promise.all(cookies.flatMap((cookie) => Array.from({ length: 3 }, () => attempt("owner", "guess", cookie))));
    expect(wave.filter((result) => result.status === 401)).toHaveLength(3);
    expect(wave.filter((result) => result.status === 429)).toHaveLength(57);
    expect(wave.every((result) => result.cookies === undefined)).toBe(true);
    await kestrel.stop();
  });

  it("are not issued for a name the request only claims when the login reads another field", async () => {
    const { kestrel, send } = await bootLogin({ account: ACCOUNT }, "signin.loginByEmail");
    const decoy = await send({ email: "someone@example.org", username: "owner", password: PASSWORD });
    expect(decoy.status).toBe(200);
    expect(decoy.cookies).toBeUndefined();
    await kestrel.stop();
  });

  it("bind to the exact e-mail address, so a variant spelling of it gets no budget of the other account's", async () => {
    const { kestrel, send } = await bootLogin({ account: { ...ACCOUNT, field: "email" } }, "signin.loginByEmail");
    const issued = await send({ email: "Alice@example.org", password: PASSWORD });
    expect(issued.status).toBe(200);
    const cookie = cookieHeader(issued.cookies?.[0] ?? "");
    const guesses = await Promise.all(Array.from({ length: 10 }, () => send({ email: "alice@example.org", password: "guess" }, cookie)));
    expect(guesses.filter((result) => result.status === 401)).toHaveLength(3);
    await kestrel.stop();
  });
});

describe("known devices at boot", () => {
  const bootWith = (config: Record<string, unknown>, steps: string[] = ["ratelimit.check:account"]) =>
    bootKestrel({ config: { modules: [{ use: "@michaelthielemann/kestrel-ratelimit-memory", config }], triggers: [], http: null }, modules: [module], pipelines: [definePipeline({ name: "login", steps })], logger: silentLogger });

  it("refuse a bucket with knownDevices without deviceCookies", async () => {
    await expect(bootWith({ buckets: { account: ACCOUNT } })).rejects.toThrow(/knownDevices, which needs deviceCookies/);
  });

  it("refuse knownDevices on a bucket that does not count by username", async () => {
    await expect(bootWith({ buckets: { account: { ...ACCOUNT, key: "ip" } }, deviceCookies: { secretKey: KEY } })).rejects.toThrow(/only a username bucket/);
  });

  it("refuse rememberDevice for a bucket without knownDevices", async () => {
    const bucket = { limit: 3, windowSeconds: 300, key: "username" };
    await expect(bootWith({ buckets: { account: bucket }, deviceCookies: { secretKey: KEY } }, ["ratelimit.check:account", "ratelimit.rememberDevice:account"])).rejects.toThrow(/has no knownDevices/);
  });

  it("refuse rememberDevice before a step that signs the caller in", async () => {
    await expect(bootWith({ buckets: { account: ACCOUNT }, deviceCookies: { secretKey: KEY } }, ["ratelimit.rememberDevice:account"])).rejects.toThrow(/identity/);
  });
});
