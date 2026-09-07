import { BlockList, isIP } from "node:net";

export interface Allowlist {
  check(ip: string | undefined): boolean;
}

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function invalid(entry: string, reason: string): Error {
  return new Error(`ip allowlist: invalid entry ${JSON.stringify(entry)} (${reason})`);
}

// Strips an IPv6 zone id and unwraps an IPv4-mapped IPv6 address so both sides of the check use
// the same family the operator wrote into the list.
export function normalizeIp(ip: string): { address: string; family: "ipv4" | "ipv6" } | null {
  const bare = ip.includes("%") ? (ip.split("%")[0] ?? "") : ip;
  const mapped = MAPPED_IPV4.exec(bare);
  const address = mapped ? (mapped[1] ?? bare) : bare;
  const version = isIP(address);
  if (version === 4) return { address, family: "ipv4" };
  if (version === 6) return { address, family: "ipv6" };
  return null;
}

/** `null` for an empty list: nothing to enforce. Throws on an entry that is neither an address nor a CIDR. */
export function createAllowlist(entries: readonly string[]): Allowlist | null {
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [raw, prefixText, ...rest] = entry.trim().split("/");
    if (raw === undefined || raw === "" || rest.length > 0) throw invalid(entry, "expected an IP address or a CIDR range");
    const ip = normalizeIp(raw);
    if (ip === null) throw invalid(entry, "not an IPv4 or IPv6 address");
    if (prefixText === undefined) {
      list.addAddress(ip.address, ip.family);
      continue;
    }
    const bits = ip.family === "ipv4" ? 32 : 128;
    const prefix = /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : Number.NaN;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw invalid(entry, `prefix must be 0-${bits}`);
    list.addSubnet(ip.address, prefix, ip.family);
  }
  return {
    check(ip) {
      if (ip === undefined) return false;
      const normalized = normalizeIp(ip);
      return normalized !== null && list.check(normalized.address, normalized.family);
    },
  };
}
