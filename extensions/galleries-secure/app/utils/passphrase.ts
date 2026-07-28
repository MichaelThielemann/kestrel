// Word-pattern passphrase suggestion (diceware-style), e.g. "esel-sitzen-rose-sonne-fliegen-nacht". A
// convenience for the editor — the photographer can always type their own. Uses the CSPRNG
// (`crypto.getRandomValues`) with rejection sampling so the word choice is unbiased (a plain `% n` would
// skew toward low indices). Pure + isomorphic → node-tested.
import { WORDLIST_DE } from './wordlist.de'

export interface PassphraseOptions {
  /** How many words (default 10). The gallery ciphertext is permanently public and offline-attackable, so
   *  the default targets ~82 bits (10 × log2(296)) — above the ~78-bit EFF-diceware norm. */
  words?: number
  /** Joiner between words (default "-"). Must not occur inside the word list. */
  separator?: string
  /** Word list to draw from (default the bundled German list). */
  wordlist?: readonly string[]
}

/** Unbiased random integer in [0, n) via rejection sampling over a uint32 (no modulo bias). */
export function randomIndex(n: number): number {
  if (n <= 0) throw new Error('wordlist is empty')
  // Largest multiple of n that fits in a uint32; values at/above it are rejected to keep the draw uniform.
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint32Array(1)
  let x: number
  do { crypto.getRandomValues(buf); x = buf[0]! } while (x >= limit)
  return x % n
}

/** Generate a passphrase by drawing `words` words uniformly (with replacement) from `wordlist`. */
export function generatePassphrase(options: PassphraseOptions = {}): string {
  const { words = 10, separator = '-', wordlist = WORDLIST_DE } = options
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(wordlist[randomIndex(wordlist.length)]!)
  return out.join(separator)
}

/** Shannon entropy (bits) of such a passphrase: `words × log2(listSize)`. */
export function passphraseEntropyBits(words: number, listSize: number): number {
  return words * Math.log2(listSize)
}

/** A rough LOWER-BOUND entropy estimate (bits) for a user-typed password: effective length × log2(charset
 *  size), where the charset grows with the character classes present. Deliberately simple + dependency-free
 *  (not a dictionary model like zxcvbn) — it under-credits passphrases but flags short/single-class inputs
 *  AND low-variety/repeated ones (raw length alone lets e.g. 15×'a' or 'passwordpassword' clear a length-only
 *  floor). "Effective length" caps raw length at twice the count of DISTINCT characters, so repetition can't
 *  buy entropy past what the character variety actually supports. */
export function estimatePasswordBits(password: string): number {
  if (!password) return 0
  let charset = 0
  if (/[a-z]/.test(password)) charset += 26
  if (/[A-Z]/.test(password)) charset += 26
  if (/[0-9]/.test(password)) charset += 10
  if (/[^a-z0-9]/i.test(password)) charset += 33 // any other (symbol/space/unicode), approx printable-ASCII symbols
  if (!charset) return 0
  const distinct = new Set(password).size
  const effectiveLength = Math.min(password.length, distinct * 2)
  return effectiveLength * Math.log2(charset)
}

/** Minimum estimated entropy (bits) for a user-chosen gallery password. The gallery ciphertext (index + blobs)
 *  is intentionally world-readable AND permanently downloadable, so an attacker brute-forces OFFLINE with no
 *  rate limit — passphrase entropy, not the KDF, is the only real defense. The floor is therefore set high
 *  enough that even the weakest ACCEPTED hand-typed password is expensive to crack; the generated passphrase
 *  (~82 bits) clears it with wide margin. Note `estimatePasswordBits` is a naive charset model that OVER-credits
 *  dictionary phrases, so this is a floor, not a guarantee — steer users to the generated suggestion. */
export const MIN_PASSWORD_BITS = 70
