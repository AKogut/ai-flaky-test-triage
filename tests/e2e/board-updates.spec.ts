import { SEED } from '@sentra/taskflow-server'
import { add, items, open, titles } from './board.js'
import { expect, test } from './fixtures.js'

/**
 * # The one that reads like `environment` and is not. `test_code` + `intermittent`.
 *
 * A spec that assumes an operation finishes inside a fixed budget. It passes on
 * a quiet machine and fails when the machine is not quiet, which is the shape of
 * a very large share of real CI flakiness — and it is the case where a plausible
 * wrong answer does more damage than no answer at all, because it sends somebody
 * to tune CI instead of fixing a test.
 *
 * ## Why the label is `test_code` and not `environment`
 *
 * Everything about the failure points at the runner. The operation really did
 * take longer than usual. The machine really was slower. Nothing in the
 * application changed, and re-running on an idle machine really does make it
 * pass. Every one of those is true, and none of them makes it `environment`.
 *
 * `docs/taxonomy.md` puts `environment` where **the run itself broke** — a port
 * that would not bind, a browser that would not launch, a runner killed for
 * memory. The run here was fine. A page loaded, a button was clicked, a request
 * was answered, an assertion ran. What failed is a claim the spec made: that
 * this would all be done within 120 milliseconds. Nobody promised that, and the
 * fix is in this file, not in the runner.
 *
 * The rule that decides it is the second one — the test source encodes an unsafe
 * assumption — and it fires before anything about the environment is considered.
 *
 * ## The unsafe assumption, exactly
 *
 * ```ts
 * await expect(items(page)).toHaveCount(SEED.length + 1, { timeout: BUDGET })
 * ```
 *
 * Playwright's default here is ten seconds, and that default is not laziness: it
 * is a deadline long enough that only a genuinely stuck application reaches it.
 * Overriding it downwards converts a condition into a stopwatch. The assertion
 * still retries — it is still web-first, still a condition — but the deadline is
 * now a guess about how fast a machine is, and a guess about a machine is the one
 * thing a test cannot know.
 *
 * Creating a task is not optimistic: `useTasks.create` waits for the server and
 * appends what comes back. So the row appears when the write answers, and against
 * the chaotic instance that is anywhere in a documented range. The budget sits
 * inside that range, which is the whole mechanism.
 *
 * ## Why a chaotic server stands in for a slow runner
 *
 * Because they are the same thing from the spec's point of view: the operation
 * takes longer than the number in the file. Injecting the latency makes the
 * distribution known and the failure reproducible, which a genuinely loaded
 * runner would not — and it keeps the demonstration out of the specs, which is
 * the rule the whole suite follows.
 *
 * ## The correct fix, deliberately not applied
 *
 * Delete the `timeout` option. The assertion is already a condition; it does not
 * need a stopwatch attached to it. If a suite genuinely needs a latency budget,
 * that is a performance test with its own name, not an option on an assertion
 * about correctness.
 */

test.use({ chaos: true })

/**
 * The number somebody wrote down. It is not derived from anything: it is what
 * the operation took on the machine where the spec was written, rounded.
 */
const BUDGET = 120

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('shows an added task promptly', async ({ page }) => {
  await add(page, 'Book the retrospective room')

  await expect(items(page)).toHaveCount(SEED.length + 1, { timeout: BUDGET })
  await expect(titles(page).last()).toHaveText('Book the retrospective room')
})

/**
 * The same flow with the deadline left alone, so the file shows both halves of
 * the comparison. This one passes on every run — the application is not slow,
 * and the assertion above is not measuring the application.
 */
test('shows an added task, given the default deadline', async ({ page }) => {
  await add(page, 'Book the retrospective room')

  await expect(items(page)).toHaveCount(SEED.length + 1)
  await expect(titles(page).last()).toHaveText('Book the retrospective room')
})
