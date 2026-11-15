/** What {@link Redactor} puts in place of a secret. */
export const MASK = "[redacted]";

/** The fields of a document whose string values are free text, such as an error message that may quote what a failed call answered. */
export const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set(["message", "error", "failure", "detail", "problems"]);

/** The length from which {@link Redactor.holds} finds a registered secret anywhere in a value, as real access keys and secrets have it. */
export const EMBEDDED_SECRET_LENGTH = 16;

/** A value {@link fixedText} keeps as written, made by {@link literal}. */
export class Literal {
  constructor(
    /** The value as the tool names it. */
    readonly value: string,
  ) {}
}

/** Marks a value the tool itself names in fixed text, such as a command, a flag, an environment name, a run or backup id or a state, so {@link fixedText} keeps it as written. */
export function literal(value: string): Literal {
  return new Literal(value);
}

interface Piece {
  text: string;
  fixed: boolean;
}

const COMPOSED_LIMIT = 10_000;
const composed = new Map<string, Piece[] | null>();

const samePieces = (a: Piece[], b: Piece[]): boolean => a.length === b.length && a.every((piece, i) => piece.text === b[i]?.text && piece.fixed === b[i]?.fixed);

function remember(text: string, pieces: Piece[]): void {
  const earlier = composed.get(text);
  if (earlier === undefined) {
    if (composed.size >= COMPOSED_LIMIT) composed.delete(composed.keys().next().value ?? "");
    composed.set(text, pieces);
  } else if (earlier !== null && !samePieces(earlier, pieces)) composed.set(text, null);
}

function fixedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let at = 0;
  for (const piece of composed.get(text) ?? []) {
    if (piece.fixed) ranges.push([at, at + piece.text.length]);
    at += piece.text.length;
  }
  return ranges;
}

/**
 * Composes a line of text the tool prints or reports, and returns it as a plain string. The literal parts of the
 * template, numbers and {@link literal} values are the tool's fixed text; every other interpolated string is a value
 * from elsewhere, such as an error message or the output of a command. {@link Redactor.apply} keeps a short secret
 * that lies wholly within the fixed text and masks it in a value. A value that was itself composed this way keeps its
 * own parts. The parts are remembered by the text in this process; a string composed twice with different parts
 * counts as a plain string.
 */
export function fixedText(literals: TemplateStringsArray, ...values: ReadonlyArray<string | number | Literal>): string {
  const pieces: Piece[] = [];
  const push = (text: string, fixed: boolean): void => {
    if (text === "") return;
    const last = pieces.at(-1);
    if (last?.fixed === fixed) last.text += text;
    else pieces.push({ text, fixed });
  };
  literals.forEach((part, i) => {
    push(part, true);
    if (i >= values.length) return;
    const value = values[i];
    if (value instanceof Literal) push(value.value, true);
    else if (typeof value === "number") push(String(value), true);
    else if (value !== undefined) {
      const parts = composed.get(value);
      if (parts) for (const part of parts) push(part.text, part.fixed);
      else push(value, false);
    }
  });
  const text = pieces.map((piece) => piece.text).join("");
  remember(text, pieces);
  return text;
}

function credentialPositions(text: string): string[] {
  const values = [text];
  for (const match of text.matchAll(/\/\/([^/?#\s@]+)@/g)) {
    const userinfo = match[1] ?? "";
    const colon = userinfo.indexOf(":");
    if (colon < 0) values.push(userinfo);
    else values.push(userinfo.slice(0, colon), userinfo.slice(colon + 1));
  }
  for (const match of text.matchAll(/=\s*(["']?)([^\s"'&;,]*)\1/g)) values.push(match[2] ?? "");
  return values;
}

/** Replaces every registered secret, and its URL-encoded and JSON-escaped forms, in text before it leaves the process. */
export class Redactor {
  readonly #secrets = new Set<string>();

  /** Registers a secret; values shorter than four characters are ignored, since masking them would garble ordinary text. */
  add(value: string): void {
    if (value.length < 4) return;
    this.#secrets.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) this.#secrets.add(encoded);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) this.#secrets.add(escaped);
  }

  /**
   * Masks every registered secret in a line of text for a person: terminal output, a question, an error message. In
   * text composed by {@link fixedText}, a secret shorter than {@link EMBEDDED_SECRET_LENGTH} stays where it lies wholly
   * within the fixed text, so a credential that equals a command name, a flag or an environment name leaves a command
   * the text names as written; every other occurrence, in an interpolated value or in a plain string, is masked.
   */
  apply(text: string): string {
    const fixed = fixedRanges(text);
    const found: Array<[number, number]> = [];
    for (const secret of this.#secrets) {
      for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) {
        const end = at + secret.length;
        if (secret.length < EMBEDDED_SECRET_LENGTH && fixed.some(([from, to]) => from <= at && end <= to)) continue;
        found.push([at, end]);
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    let out = "";
    let copied = 0;
    for (const [at, end] of found) {
      if (end <= copied) continue;
      if (at >= copied) out += text.slice(copied, at) + MASK;
      copied = end;
    }
    return out + text.slice(copied);
  }

  /**
   * Whether the value `text` carries a registered secret, in any form {@link Redactor.apply} masks: as the whole value,
   * as the user or password of a URL, as the value of a `key=value` pair, or, for a secret of at least
   * {@link EMBEDDED_SECRET_LENGTH} characters, anywhere in it. A shorter secret that is only part of other text, such
   * as an access key `kestrel` in `kestrel-media`, does not count.
   */
  holds(text: string): boolean {
    const positions = credentialPositions(text);
    for (const secret of this.#secrets) if (secret.length >= EMBEDDED_SECRET_LENGTH ? text.includes(secret) : positions.includes(secret)) return true;
    return false;
  }

  /**
   * Serializes a document the tool writes, stored or printed with `--json`, as JSON. Every value is written as it is,
   * since a document holds names, ids, keys and hashes and never a secret value; only the free text in the fields
   * {@link FREE_TEXT_FIELDS} (a string, or the strings of an array), at any depth, is masked like {@link Redactor.apply}.
   */
  document(value: unknown, space?: number): string {
    return JSON.stringify(
      value,
      (key, field: unknown) => {
        if (!FREE_TEXT_FIELDS.has(key)) return field;
        if (typeof field === "string") return this.apply(field);
        if (Array.isArray(field)) return field.map((item: unknown) => (typeof item === "string" ? this.apply(item) : item));
        return field;
      },
      space,
    );
  }
}
