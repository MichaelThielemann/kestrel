/** What {@link Redactor} puts in place of a secret. */
export const MASK = "[redacted]";

/** The fields of a document whose string values are free text, such as an error message that may quote what a failed call answered. */
export const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set(["message", "error", "failure", "detail", "problems"]);

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

  /** Whether `text` holds a registered secret, whole or as a part, in any form {@link Redactor.apply} masks. */
  holds(text: string): boolean {
    for (const secret of this.#secrets) if (text.includes(secret)) return true;
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
