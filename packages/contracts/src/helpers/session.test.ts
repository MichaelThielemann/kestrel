import { describe, expect, it } from "vitest";
import { clearedSessionCookie, requestToken, sessionCookie, sessionCookieName } from "./session.ts";

describe("session cookie names", () => {
  it("uses the __Host- prefix whenever the cookie is Secure, and the plain name only without Secure", () => {
    expect(sessionCookieName(true)).toBe("__Host-kestrel_token");
    expect(sessionCookieName(false)).toBe("kestrel_token");
    expect(sessionCookie("t", { maxAgeSeconds: 60, secure: true })).toMatch(/^__Host-kestrel_token=t; Path=\/; Max-Age=60; HttpOnly; Secure; SameSite=Strict$/);
    expect(sessionCookie("t", { maxAgeSeconds: 60, secure: false })).toMatch(/^kestrel_token=t; Path=\/; Max-Age=60; HttpOnly; SameSite=Strict$/);
    expect(clearedSessionCookie({ secure: true })).toMatch(/^__Host-kestrel_token=;/);
  });

  it("reads only the cookie of the configured name", () => {
    expect(requestToken({ cookie: "kestrel_token=a; __Host-kestrel_token=b" })).toEqual({ token: "b", source: "cookie" });
    expect(requestToken({ cookie: "kestrel_token=a" })).toBeUndefined();
    expect(requestToken({ cookie: "__Host-kestrel_token=b; kestrel_token=a" }, "kestrel_token")).toEqual({ token: "a", source: "cookie" });
  });
});
