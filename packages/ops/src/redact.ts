const MASK = "[redacted]";

/** Replaces every registered secret, and its URL-encoded form, in text before it leaves the process. */
export class Redactor {
  readonly #secrets = new Set<string>();

  /** Registers a secret; values shorter than four characters are ignored, since masking them would garble ordinary text. */
  add(value: string): void {
    if (value.length < 4) return;
    this.#secrets.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) this.#secrets.add(encoded);
  }

  apply(text: string): string {
    let out = text;
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join(MASK);
    return out;
  }

  /** Serializes a value as JSON with every secret masked. */
  json(value: unknown, space?: number): string {
    return this.apply(JSON.stringify(value, null, space));
  }
}
