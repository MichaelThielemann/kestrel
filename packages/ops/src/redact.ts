/** What {@link Redactor} puts in place of a secret. */
export const MASK = "[redacted]";

/** The fields of a document whose string values are free text, such as an error message that may quote what a failed call answered. */
export const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set(["message", "error", "failure", "detail", "problems"]);

/** The length from which {@link Redactor.holds} finds a registered secret anywhere in a value, as real access keys and secrets have it. */
export const EMBEDDED_SECRET_LENGTH = 16;

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

  /** Masks every registered secret in a line of text for a person: terminal output, a question, an error message. */
  apply(text: string): string {
    let out = text;
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join(MASK);
    return out;
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
