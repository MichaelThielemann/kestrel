import { describe, it, expect } from "vitest";
import { createAllowlist, normalizeIp } from "./allowlist.ts";

describe("ip allowlist", () => {
  it("is null for an empty list", () => {
    expect(createAllowlist([])).toBeNull();
  });

  it("matches IPv4 addresses and ranges", () => {
    const list = createAllowlist(["10.0.0.5", "203.0.113.0/24"])!;
    expect(list.check("10.0.0.5")).toBe(true);
    expect(list.check("10.0.0.6")).toBe(false);
    expect(list.check("203.0.113.200")).toBe(true);
    expect(list.check("203.0.114.1")).toBe(false);
    expect(list.check(undefined)).toBe(false);
    expect(list.check("not-an-ip")).toBe(false);
  });

  it("matches IPv6 addresses, ranges and zone ids", () => {
    const list = createAllowlist(["::1/128", "2001:db8::/32"])!;
    expect(list.check("::1")).toBe(true);
    expect(list.check("2001:db8:1::42")).toBe(true);
    expect(list.check("2001:db9::1")).toBe(false);
    expect(list.check("fe80::1%eth0")).toBe(false);
    expect(createAllowlist(["fe80::/10"])!.check("fe80::1%eth0")).toBe(true);
  });

  it("checks IPv4-mapped IPv6 peers and entries as IPv4", () => {
    const list = createAllowlist(["10.0.0.0/8"])!;
    expect(list.check("::ffff:10.1.2.3")).toBe(true);
    expect(list.check("::FFFF:192.168.0.1")).toBe(false);
    expect(createAllowlist(["::ffff:127.0.0.1"])!.check("127.0.0.1")).toBe(true);
    expect(normalizeIp("::ffff:127.0.0.1")).toEqual({ address: "127.0.0.1", family: "ipv4" });
    expect(normalizeIp("::1")).toEqual({ address: "::1", family: "ipv6" });
    expect(normalizeIp("example.org")).toBeNull();
  });

  it("rejects entries that are neither an address nor a CIDR range, naming the entry", () => {
    expect(() => createAllowlist(["example.org"])).toThrow('ip allowlist: invalid entry "example.org"');
    expect(() => createAllowlist(["10.0.0.0/33"])).toThrow(/"10.0.0.0\/33" \(prefix must be 0-32\)/);
    expect(() => createAllowlist(["2001:db8::/129"])).toThrow(/prefix must be 0-128/);
    expect(() => createAllowlist(["10.0.0.0/8/1"])).toThrow(/"10.0.0.0\/8\/1"/);
    expect(() => createAllowlist(["10.0.0.0/x"])).toThrow(/"10.0.0.0\/x"/);
    expect(() => createAllowlist([""])).toThrow(/invalid entry ""/);
  });
});
