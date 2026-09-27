import { isIP, isIPv4, isIPv6 } from "node:net";

type V4Range = readonly [string, number];
type V6Rule = readonly [prefix: readonly number[], bits: number, action: "block" | "embedded-low" | "embedded-6to4"];

const V4_BLOCKED: readonly V4Range[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const V6_RULES: readonly V6Rule[] = [
  [[0, 0, 0, 0, 0, 0xffff], 96, "embedded-low"],
  [[0, 0, 0, 0, 0xffff, 0], 96, "block"],
  [[0, 0, 0, 0, 0, 0], 96, "block"],
  [[0x64, 0xff9b, 0, 0, 0, 0], 96, "embedded-low"],
  [[0x64, 0xff9b, 1], 48, "block"],
  [[0x100, 0, 0, 0], 64, "block"],
  [[0x2001, 0], 23, "block"],
  [[0x2001, 0xdb8], 32, "block"],
  [[0x2002], 16, "embedded-6to4"],
  [[0x3fff], 20, "block"],
  [[0x5f00], 16, "block"],
  [[0xfc00], 7, "block"],
  [[0xfe80], 10, "block"],
  [[0xfec0], 10, "block"],
  [[0xff00], 8, "block"],
];

const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

function v4Number(address: string): number {
  return address.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

function inV4Range(value: number, [network, bits]: V4Range): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(v4Number(network) / size);
}

function isBlockedV4(value: number): boolean {
  return V4_BLOCKED.some((range) => inV4Range(value, range));
}

function v6Hextets(address: string): number[] | null {
  let text = address.split("%")[0] ?? "";
  const lastColon = text.lastIndexOf(":");
  const dotted = text.slice(lastColon + 1);
  if (isIPv4(dotted)) {
    const n = v4Number(dotted);
    text = `${text.slice(0, lastColon + 1)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const hextets = [...head, ...Array.from({ length: halves.length === 2 ? fill : 0 }, () => 0), ...rest];
  return hextets.length === 8 && hextets.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? hextets : null;
}

function matchesPrefix(hextets: number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < prefix.length; i++) {
    const remaining = bits - i * 16;
    if (remaining <= 0) return true;
    const mask = remaining >= 16 ? 0xffff : (0xffff << (16 - remaining)) & 0xffff;
    if (((hextets[i] ?? 0) & mask) !== ((prefix[i] ?? 0) & mask)) return false;
  }
  return true;
}

function isBlockedV6(hextets: number[]): boolean {
  for (const [prefix, bits, action] of V6_RULES) {
    if (!matchesPrefix(hextets, prefix, bits)) continue;
    if (action === "block") return true;
    const [high, low] = action === "embedded-low" ? [hextets[6]!, hextets[7]!] : [hextets[1]!, hextets[2]!];
    return isBlockedV4(high * 65536 + low);
  }
  return false;
}

/**
 * Whether an IP address lies in a range a link check must not reach: loopback, private, shared,
 * link-local, documentation, benchmarking, multicast, broadcast and every other special-purpose range
 * that is not globally reachable, including IPv4 addresses embedded in IPv4-mapped, NAT64 and 6to4
 * IPv6 addresses. Anything that does not parse as an address counts as private.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  if (isIPv4(bare)) return isBlockedV4(v4Number(bare));
  if (!isIPv6(bare)) return true;
  const hextets = v6Hextets(bare.toLowerCase());
  return hextets === null || isBlockedV6(hextets);
}

/** A hostname as the checks compare it: without brackets, lower case, without trailing dots. */
export function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
}

/** Whether a URL hostname is a private name (`localhost`, `*.local`, …) or a private IP literal. */
export function isPrivateHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "" || host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isIP(host) !== 0 && isPrivateAddress(host);
}
