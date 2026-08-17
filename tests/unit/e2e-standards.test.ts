import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The standard the end-to-end specs are held to, enforced rather than described.
 *
 * These specs are the control group. Every number in `eval/report.md` is measured
 * against a dataset built from their runs, so a spec that is a little bit flaky
 * does not merely fail sometimes — it teaches the classifier that everything is a
 * little bit flaky, and it makes the one deliberately flaky spec indistinguishable
 * from the noise around it.
 *
 * A standard in a CONTRIBUTING file is a standard until somebody is in a hurry.
 * These are the four habits that produce most intermittent failures in Playwright
 * suites, and each is checked here against the files git actually tracks.
 *
 * The flaky specs of #52–#55 are held to the same rules on purpose. Their
 * flakiness has to come from the application or from a *deliberate, documented*
 * selector choice — never from a sleep somebody left in, which would make the
 * ground-truth label a guess about the author's intent.
 */

/**
 * Comments removed before anything is checked.
 *
 * These specs explain themselves, and the explanations name the very things the
 * rules forbid — the header of `create.spec.ts` says "no `waitForTimeout`" in so
 * many words. A guard that fired on the sentence describing it would push
 * authors towards writing less about why, which is the opposite of what this
 * repository wants from a spec.
 *
 * Line comments are dropped only when they start the line, so a `//` inside a
 * URL survives and no assertion loses its subject.
 */
const code = (source: string): string =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

const specs = execSync('git ls-files "tests/e2e/*.spec.ts"', { encoding: 'utf8' })
  .split('\n')
  .filter((path) => path !== '')
  .map((path) => {
    const raw = readFileSync(path, 'utf8')
    return { path, raw, source: code(raw) }
  })

describe('the end-to-end specs', () => {
  it('exist, so the rules below are checking something', () => {
    expect(specs.length).toBeGreaterThan(0)
  })

  /**
   * A sleep is a guess about how fast a machine is, and CI is not that machine.
   * It is also the single most common cause of a suite that passes locally and
   * fails at 20% in CI — which is #55, a spec this repository writes on purpose
   * and exactly once.
   */
  it.each(specs)('$path waits for conditions, never for the clock', ({ source }) => {
    expect(source).not.toContain('waitForTimeout')
    expect(source).not.toMatch(/setTimeout\s*\(/)
  })

  /**
   * `expect(await locator.count()).toBe(3)` samples once and races the
   * application. `expect(locator).toHaveCount(3)` retries until the condition
   * holds or the timeout expires. The two look almost identical in a diff and
   * behave completely differently under load.
   *
   * Reading a value to compare against later is a different thing and is allowed
   * — `const before = await titles(page).allTextContents()` is a capture, not an
   * assertion.
   */
  it.each(specs)('$path asserts on the page with web-first assertions', ({ source }) => {
    // Matched across the rest of the line rather than to the closing bracket:
    // `expect(await items(page).count())` nests parentheses, and a pattern that
    // stopped at the first `)` walked straight past it — which is how this rule
    // came to be checked by feeding it the violation rather than by reading it.
    const sampled =
      /expect\(\s*await\s[^\n]*(?:page\.|\.count\(|\.textContent\(|\.innerText\(|\.isVisible\(|\.allTextContents\()/
    expect(source).not.toMatch(sampled)
  })

  /**
   * The pre-locator API returns an element handle taken at one moment. Every
   * assertion built on one is a race against the next render.
   */
  it.each(specs)('$path uses locators rather than element handles', ({ source }) => {
    expect(source).not.toContain('waitForSelector')
    expect(source).not.toMatch(/page\.\$\$?\(/)
  })

  /** A `test.only` that reaches main silently shrinks the suite to one test. */
  it.each(specs)('$path runs all of its tests', ({ source }) => {
    expect(source).not.toMatch(/\btest\.only\b/)
    expect(source).not.toMatch(/\bdescribe\.only\b/)
  })

  /**
   * Every spec file opens with a comment explaining what it covers and why it is
   * written the way it is. For #52–#55 that comment is the ground truth a reader
   * checks the dataset label against, so the habit is worth having everywhere
   * rather than being remembered in the four files where it carries weight.
   */
  it.each(specs)('$path says what it is for', ({ raw }) => {
    expect(raw.slice(0, 2000)).toContain('/**')
  })
})
