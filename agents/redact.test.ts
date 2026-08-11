import { describe, expect, it } from 'vitest'
import { REDACTED, SECRET_PATTERNS, redactSecrets, scrub } from './redact.js'

describe('secret patterns', () => {
  it.each([
    ['an Anthropic key', 'key sk-ant-api03-AbCdEfGh12345678 here', /sk-ant-api03-A/],
    ['a bearer token', 'Authorization: Bearer abcdefghijklmnop123', /abcdefghijklmnop123/],
    ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123', /ghp_abcdef/],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0abcdefghijklmn', /github_pat_11A/],
    ['an AWS access key', 'AKIAIOSFODNN7EXAMPLE', /AKIAIOSF/],
    ['a Slack token', 'xoxb-123456789012-abcdefghijkl', /xoxb-123/],
    [
      'a private key block',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      /MIIEow/,
    ],
    ['a quoted assignment', 'const apiKey = "s3cr3t-value-here"', /s3cr3t-value-here/],
  ])('removes %s', (_case, text, leak) => {
    const { text: redacted, count } = redactSecrets(text)
    expect(redacted).toContain(REDACTED)
    expect(redacted).not.toMatch(leak)
    expect(count).toBe(1)
  })

  it('keeps the key name when it redacts an assignment, so the line stays readable', () => {
    expect(redactSecrets(`token: "abcdefghijkl"`).text).toBe(`token: "${REDACTED}"`)
  })

  it('leaves ordinary text alone', () => {
    const text = 'expected 3 to equal 4 at board.spec.ts:42'
    expect(redactSecrets(text)).toEqual({ text, count: 0 })
  })

  it('counts every replacement, because the count is what a report shows', () => {
    const { count } = redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAIOSFODNN7EXAMPLE')
    expect(count).toBe(2)
  })

  /**
   * A global regex carries `lastIndex` between calls. Sharing one array of
   * compiled patterns across every prompt and every cassette makes that a real
   * hazard: the second call would start searching part-way through the string
   * and miss a key that the first call caught.
   */
  it('redacts the same text identically however many times it runs', () => {
    const text = 'key sk-ant-api03-AbCdEfGh12345678 and again sk-ant-api03-ZzZzZzZz98765432'
    const first = redactSecrets(text)
    expect(redactSecrets(text)).toEqual(first)
    expect(redactSecrets(text)).toEqual(first)
    expect(first.count).toBe(2)
  })

  /**
   * Pinned because it surprised a test the first time it ran, and because the
   * behaviour is the one worth having. A credential is normally bounded by a
   * quote, a space, or a URL separator, none of which are key characters — so
   * the greedy match stops where the key does. When it does not, the text
   * running straight into the key is indistinguishable from more key, and taking
   * it is the safe reading.
   */
  it('takes neighbouring key characters with it rather than guessing where a key ends', () => {
    expect(redactSecrets('sk-ant-api03-AbCdEfGh12345678thentext').text).toBe(REDACTED)
    expect(redactSecrets('"sk-ant-api03-AbCdEfGh12345678" then text').text).toBe(
      `"${REDACTED}" then text`,
    )
  })

  it('has no pattern that can match an empty string', () => {
    // One that could would replace at every position and produce a file of markers.
    for (const pattern of SECRET_PATTERNS) {
      expect(''.replace(new RegExp(pattern.source, pattern.flags), REDACTED)).toBe('')
    }
  })
})

describe('scrub', () => {
  it('reaches into nested structures, where a leak would actually hide', () => {
    const scrubbed = scrub({ a: [{ b: 'sk-ant-api03-SECRETVALUE123' }] })
    expect(JSON.stringify(scrubbed)).toContain(REDACTED)
    expect(JSON.stringify(scrubbed)).not.toContain('SECRETVALUE')
  })

  it('does not touch keys, since a key name is not a secret', () => {
    expect(scrub({ ANTHROPIC_API_KEY: 'ordinary' })).toEqual({ ANTHROPIC_API_KEY: 'ordinary' })
  })

  it('passes non-strings through unchanged', () => {
    expect(scrub({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null })
  })
})
