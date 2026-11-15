/** What {@link Redactor} puts in place of a secret. */
export const MASK = "[redacted]";

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

  apply(text: string): string {
    let out = text;
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join(MASK);
    return out;
  }

  /** Serializes a value as JSON with every secret masked. */
  json(value: unknown, space?: number): string {
    return this.apply(JSON.stringify(value, (_key, field: unknown) => (typeof field === "string" ? this.apply(field) : field), space));
  }
}
