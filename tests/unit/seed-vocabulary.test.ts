import { describe, expect, it } from 'vitest'
import { SEED } from '@sentra/taskflow-server'
import { LEAK_TERMS } from '@sentra/eval'

/**
 * TaskFlow's seed data is an input to the golden dataset, so it obeys the
 * dataset's rules.
 *
 * That connection is not obvious and it cost a re-capture to find. A captured
 * fixture quotes the board: an assertion that compares what is rendered against
 * the seed prints **every** title into its failure message, and that message is
 * a string value in the payload, which is where the leakage lint looks. One of
 * the seeded rows was called "Triage the flaky board spec" — good flavour, and
 * it made every fixture that printed the list unusable, with an error naming a
 * word the fixture author never wrote.
 *
 * The rule is therefore: **no seeded title or description may contain a word
 * from the label vocabulary.** It is checked here rather than remembered,
 * against the same list `eval/hygiene.ts` uses, so the two cannot drift.
 */

const fields = SEED.flatMap((task) => [
  { task: task.title, field: 'title', text: task.title },
  { task: task.title, field: 'description', text: task.description },
])

describe('the seeded board', () => {
  it('has rows to check, so the assertion below means something', () => {
    expect(fields.length).toBeGreaterThan(0)
  })

  it.each(fields)('$task ($field) carries no word from the label vocabulary', ({ text }) => {
    for (const term of LEAK_TERMS) {
      expect(text, `matches ${String(term)}`).not.toMatch(term)
    }
  })

  /**
   * The check is only worth having if it would fire, and the string that made it
   * necessary is the obvious thing to try it on.
   */
  it('would have caught the title that made this necessary', () => {
    const caught = LEAK_TERMS.some((term) => term.test('Triage the flaky board spec'))
    expect(caught).toBe(true)
  })
})
