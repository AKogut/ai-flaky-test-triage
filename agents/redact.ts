/**
 * Best-effort secret redaction, in one place.
 *
 * Two callers with the same requirement and different reasons:
 *
 * - **Cassettes** are written from a live response and then committed forever,
 *   so this is the last point at which a leaked credential can be caught before
 *   it is in public git history.
 * - **Prompts** carry source and diff hunks to a third-party API. A key that
 *   reaches a prompt has left the repository whether or not anyone notices.
 *
 * One list rather than two, because two lists diverge and the weaker one is
 * always the one guarding the path that matters.
 *
 * Deliberately broad. A false positive costs an unreadable cassette or a slice
 * of evidence the classifier could have used; a false negative costs a live
 * credential in public history. The trade is not close, and the evidence cost
 * is real enough to state: redacting a hard-coded token can remove the very
 * string a test was asserting on.
 *
 * "Best-effort" is meant literally. This catches known-shaped credentials, not
 * arbitrary high-entropy strings, and it is a backstop rather than a control —
 * the control is not putting secrets in the repository.
 */

export const REDACTED = '[redacted]'

/**
 * Each pattern matches **only the secret**, never the surrounding context, so a
 * redaction leaves the shape of the line intact and a reviewer can still see
 * that a token was there.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,

  /**
   * A quoted value assigned to a suspiciously named key.
   *
   * The lookbehind keeps the key name visible, which matters: `apiKey:
   * "[redacted]"` still tells a reader what the line was, where redacting the
   * whole line would leave them guessing whether evidence was removed.
   */
  /(?<=(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'])[^"'\n]{8,}(?=["'])/gi,
]

export interface Redaction {
  text: string
  /** How many replacements were made — surfaced in prompts and reports. */
  count: number
}

export function redactSecrets(text: string): Redaction {
  let count = 0
  const redacted = SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, () => {
        count += 1
        return REDACTED
      }),
    text,
  )
  return { text: redacted, count }
}

/**
 * Redact every string in a value, recursively.
 *
 * Keys are left alone: a key name is not a secret, and rewriting one would
 * change the shape of a document that something downstream parses.
 */
export function scrub<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value).text as T
  if (Array.isArray(value)) return (value as unknown[]).map((item) => scrub(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v)]),
    ) as T
  }
  return value
}
