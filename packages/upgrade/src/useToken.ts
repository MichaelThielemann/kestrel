/** The bare module token a `use` string names, e.g. `"@michaelthielemann/kestrel-events-direct"` and `"./events-direct.ts"` both become `"events-direct"`. */
export function useToken(use: string): string {
  const bare = use.split(/[?#]/)[0] ?? use;
  const parts = bare.split("/").filter((p) => p !== "" && p !== "." && p !== "..");
  const last = (parts.at(-1) ?? bare).replace(/\.[cm]?[jt]sx?$/, "");
  return last.startsWith("kestrel-") ? last.slice("kestrel-".length) : last;
}
