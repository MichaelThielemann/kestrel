type Token = { kind: "literal"; text: string } | { kind: "one" } | { kind: "many" };

function isPathChar(code: number): boolean {
  return code > 0x1f && code !== 0x7f && code !== 0x5c;
}

function isSegmentChar(code: number): boolean {
  return code !== 0x2f && isPathChar(code);
}

function tokenize(from: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of from.matchAll(/\*\*|\*/g)) {
    if (m.index > last) tokens.push({ kind: "literal", text: from.slice(last, m.index) });
    tokens.push({ kind: m[0] === "**" ? "many" : "one" });
    last = m.index + m[0].length;
  }
  if (last < from.length) tokens.push({ kind: "literal", text: from.slice(last) });
  return tokens;
}

/**
 * Match a canonical `from` (leading slash, no trailing slash, `*` one segment, `**` one or more) against a
 * request path and return the captures, or `null` on a miss. The result is the one the anchored regex from
 * `patternToRegexSource` yields — `*` takes as much as it can, `**` as little, a trailing slash is tolerated —
 * but the work grows only in proportion to the path length for every rule, so no path can make a rule expensive.
 */
export function matchWildcardPath(from: string, path: string): string[] | null {
  return compileWildcardPath(from)(path);
}

function countSlashes(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x2f) count++;
  return count;
}

/**
 * Counts the work of the matchers that share it: for every path a matcher compares in full, `steps` grows by the
 * path length plus 64 for the fixed cost of a comparison, times the tokens of the rule plus one.
 */
export interface MatchMeter {
  steps: number;
}

/**
 * Prepare a matcher for a canonical `from` once and use it for many paths: it returns what
 * `matchWildcardPath(from, path)` returns. A path that is shorter than the literals and wildcards of `from` need,
 * that lacks one of its literals, holds too few or, without `**`, too many slashes, or does not end with its
 * last literal is refused before the full comparison.
 */
export function compileWildcardPath(from: string): (path: string, meter?: MatchMeter) => string[] | null {
  if (from === "/") return (path) => (path === "/" ? [] : null);
  const tokens = tokenize(from);
  const literals = tokens.flatMap((token) => (token.kind === "literal" ? [token.text] : []));
  const first = tokens[0]?.kind === "literal" ? tokens[0].text : undefined;
  const lastToken = tokens[tokens.length - 1];
  const last = lastToken?.kind === "literal" ? lastToken.text : undefined;
  const minLength = tokens.reduce((sum, token) => sum + (token.kind === "literal" ? token.text.length : 1), 0);
  const slashes = countSlashes(from);
  const deep = tokens.some((token) => token.kind === "many");
  return (path, meter) => {
    if (path.length < minLength) return null;
    if (first !== undefined && !path.startsWith(first)) return null;
    if (last !== undefined && !path.endsWith(last) && !path.endsWith(`${last}/`)) return null;
    if (!literals.every((literal) => path.includes(literal))) return null;
    const pathSlashes = countSlashes(path);
    if (pathSlashes < slashes) return null;
    if (!deep && pathSlashes !== slashes && !(path.endsWith("/") && pathSlashes === slashes + 1)) return null;
    if (meter) meter.steps += (path.length + 64) * (tokens.length + 1);
    return matchTokens(tokens, path);
  };
}

function matchTokens(tokens: Token[], path: string): string[] | null {
  const n = path.length;
  const segmentRun = new Int32Array(n + 2);
  const pathRun = new Int32Array(n + 2);
  for (let p = n - 1; p >= 0; p--) {
    const code = path.charCodeAt(p);
    segmentRun[p] = isSegmentChar(code) ? segmentRun[p + 1]! + 1 : 0;
    pathRun[p] = isPathChar(code) ? pathRun[p + 1]! + 1 : 0;
  }

  const reach: Uint8Array[] = Array.from({ length: tokens.length + 1 }, () => new Uint8Array(n + 2));
  const end = reach[tokens.length]!;
  end[n] = 1;
  if (n > 0 && path.charCodeAt(n - 1) === 0x2f) end[n - 1] = 1;

  const nearest = new Int32Array(n + 3);
  for (let t = tokens.length - 1; t >= 0; t--) {
    const token = tokens[t]!;
    const next = reach[t + 1]!;
    const here = reach[t]!;
    if (token.kind === "literal") {
      const len = token.text.length;
      for (let p = 0; p + len <= n; p++) here[p] = next[p + len] === 1 && path.startsWith(token.text, p) ? 1 : 0;
      continue;
    }
    nearest[n + 1] = n + 1;
    nearest[n + 2] = n + 2;
    for (let q = n; q >= 0; q--) nearest[q] = next[q] === 1 ? q : nearest[q + 1]!;
    for (let p = 0; p < n; p++) {
      if (segmentRun[p] === 0) continue;
      const furthest = token.kind === "one" ? p + segmentRun[p]! : p + 1 + pathRun[p + 1]!;
      here[p] = nearest[p + 1]! <= furthest ? 1 : 0;
    }
  }
  if (reach[0]![0] !== 1) return null;

  const captures: string[] = [];
  let p = 0;
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!;
    const next = reach[t + 1]!;
    if (token.kind === "literal") {
      p += token.text.length;
      continue;
    }
    let q: number;
    if (token.kind === "one") {
      q = p + segmentRun[p]!;
      while (next[q] !== 1) q--;
    } else {
      q = p + 1;
      while (next[q] !== 1) q++;
    }
    captures.push(path.slice(p, q));
    p = q;
  }
  return captures;
}
