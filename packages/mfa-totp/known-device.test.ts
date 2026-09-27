import { describe, expect, it } from "vitest";
import { boot as bootKestrel } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import authnMulti from "@michaelthielemann/kestrel-authn-multi";
import { hashPassword } from "@michaelthielemann/kestrel-authn-multi/impl";
import persistence from "@michaelthielemann/kestrel-persistence-sqlite";
import ratelimit from "@michaelthielemann/kestrel-ratelimit-memory";
import { base32Decode, totp } from "./impl.ts";
import module from "./module.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DEVICE_KEY = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const PASSWORD = "the owner's long password";

async function bootSite(accountLimit: number, enforce: "all" | "none" = "all") {
  const kestrel = await bootKestrel({
    config: {
      modules: [
        { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: ":memory:" } },
        { use: "@michaelthielemann/kestrel-authn-multi", config: { bootstrap: { username: "owner", passwordHash: hashPassword(PASSWORD) } } },
        { use: "@michaelthielemann/kestrel-mfa-totp", config: { secretKey: KEY, enforce } },
        {
          use: "@michaelthielemann/kestrel-ratelimit-memory",
          config: {
            buckets: { loginAccount: { limit: accountLimit, windowSeconds: 300, maxBlockSeconds: 900, key: "username", counts: "failures", knownDevices: { limit: 10, windowSeconds: 300, maxBlockSeconds: 900 } } },
            deviceCookies: { secretKey: DEVICE_KEY },
          },
        },
      ],
      triggers: [],
      http: null,
    },
    modules: [persistence, authnMulti, module, ratelimit],
    pipelines: [
      definePipeline({ name: "login", steps: ["ratelimit.check:loginAccount", "authn.login", "mfa.check", "ratelimit.rememberDevice:loginAccount"] }),
      definePipeline({ name: "setup", steps: ["ratelimit.check:loginAccount", "mfa.startSetup"] }),
      definePipeline({ name: "createUser", steps: ["authn.createUser"] }),
    ],
    logger: silentLogger,
  });
  let address = 0;
  const post = (pipeline: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    address += 1;
    return kestrel.run(pipeline, { trigger: { kind: "http", name: "POST /login" }, ip: `198.51.100.${address % 250}`, headers, body });
  };
  const started = await post("setup", { username: "owner", password: PASSWORD });
  const { secret } = boundaryCast<{ secret: string }>(started.result, "json");
  const code = (offset: number) => totp(base32Decode(secret), Math.floor(Date.now() / 30_000) + offset);
  const enrolled = await post("login", { username: "owner", password: PASSWORD, code: code(-1) });
  expect(enrolled.status).toBe(200);
  expect(enrolled.headers?.["set-cookie"]).toMatch(/^__Host-kestrel_token=/);
  const deviceCookie = enrolled.cookies?.[0] ?? "";
  expect(deviceCookie).toMatch(/^__Host-kestrel_device=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
  return { kestrel, post, code, device: { cookie: deviceCookie.split(";")[0] ?? "" } };
}

async function lookalikeCookies(post: Awaited<ReturnType<typeof bootSite>>["post"], names: string[], perName: number): Promise<{ cookie: string }[]> {
  const cookies: { cookie: string }[] = [];
  for (const name of names) {
    expect((await post("createUser", { username: name, password: "the look-alike's own password" })).status).toBe(200);
    for (let i = 0; i < perName; i++) {
      const signedIn = await post("login", { username: name, password: "the look-alike's own password" });
      expect(signedIn.status).toBe(200);
      cookies.push({ cookie: (signedIn.cookies?.[0] ?? "").split(";")[0] ?? "" });
    }
  }
  return cookies;
}

describe("sign-in from a known device", () => {
  it("lets the owner sign in with password and code while a parallel wave of wrong passwords blocks the account for every other device", async () => {
    const { kestrel, post, code, device } = await bootSite(10);
    const wave = await Promise.all([
      ...Array.from({ length: 30 }, () => post("login", { username: "owner", password: "a wrong guess" })),
      post("login", { username: "owner", password: PASSWORD, code: code(0) }, device),
      ...Array.from({ length: 30 }, () => post("login", { username: "owner", password: "a wrong guess" })),
    ]);
    const guesses = [...wave.slice(0, 30), ...wave.slice(31)].map((result) => result.status);
    expect(wave[30]?.status).toBe(200);
    expect(guesses.filter((status) => status === 401)).toHaveLength(10);
    expect(guesses.filter((status) => status === 429)).toHaveLength(50);
    expect((await post("login", { username: "owner", password: PASSWORD, code: code(1) })).status).toBe(429);
    await kestrel.stop();
  });

  it("lets the owner's known device past a second factor that someone with the password locked with wrong codes", async () => {
    const { kestrel, post, code, device } = await bootSite(100);
    const wrong = () => (code(0) === "000000" ? "111111" : "000000");
    const wave = await Promise.all(Array.from({ length: 20 }, () => post("login", { username: "owner", password: PASSWORD, code: wrong() })));
    expect(wave.filter((result) => result.status === 401)).toHaveLength(10);
    expect(wave.filter((result) => result.status === 429 && result.code === "RATE_LIMITED")).toHaveLength(10);
    expect((await post("login", { username: "owner", password: PASSWORD, code: code(0) })).status).toBe(429);
    const owner = await post("login", { username: "owner", password: PASSWORD, code: code(0) }, device);
    expect(owner.status).toBe(200);
    expect(owner.cookies?.[0]).toMatch(/^__Host-kestrel_device=/);
    expect((await post("login", { username: "owner", password: PASSWORD, code: code(1) })).status).toBe(429);
    await kestrel.stop();
  });

  it("does not let the device cookies of look-alike accounts past the second-factor lock of the account they imitate", async () => {
    const { kestrel, post, code, device } = await bootSite(1000, "none");
    const cookies = await lookalikeCookies(post, ["Owner", "OWNER", "ｏｗｎｅｒ", " owner "], 5);
    const wrong = () => (code(0) === "000000" ? "111111" : "000000");
    const wave = await Promise.all(cookies.map((cookie) => post("login", { username: "owner", password: PASSWORD, code: wrong() }, cookie)));
    expect(wave.filter((result) => result.status === 401)).toHaveLength(10);
    expect(wave.filter((result) => result.status === 429 && result.code === "RATE_LIMITED")).toHaveLength(10);
    expect((await post("login", { username: "owner", password: PASSWORD, code: code(0) }, cookies[0])).status).toBe(429);
    expect((await post("login", { username: "owner", password: PASSWORD, code: code(0) }, device)).status).toBe(200);
    await kestrel.stop();
  });

  it("does not give the device cookies of look-alike accounts a budget against the account they imitate", async () => {
    const { kestrel, post, code, device } = await bootSite(10, "none");
    const cookies = await lookalikeCookies(post, ["Owner", "ｏｗｎｅｒ"], 10);
    const wave = await Promise.all(cookies.flatMap((cookie) => Array.from({ length: 3 }, () => post("login", { username: "owner", password: "a wrong guess" }, cookie))));
    expect(wave.filter((result) => result.status === 401)).toHaveLength(10);
    expect(wave.filter((result) => result.status === 429)).toHaveLength(50);
    expect((await post("login", { username: "owner", password: PASSWORD, code: code(0) }, device)).status).toBe(200);
    await kestrel.stop();
  });
});
