import { items, open, row } from './board.js'
import { expect, stored, test } from './fixtures.js'

/**
 * # The cause. Its symptom is in `visible-tasks.spec.ts`.
 *
 * Nothing in this file fails. That is the whole point of it, and it is why this
 * class of failure is disproportionately hard to triage: the spec that breaks
 * and the spec that broke it are different files, and every piece of evidence in
 * the failing test's trace points at the wrong one.
 *
 * ## What it does wrong
 *
 * It adds a task and never removes it. In a suite with no per-test reset that is
 * what a missing `afterEach` looks like, and it is the single most common way a
 * suite acquires order dependence.
 *
 * `tests/e2e/fixtures.ts` reseeds before every test precisely so this cannot
 * happen by accident, so the file has to say
 *
 * ```ts
 * test.use({ resetDatabase: false })
 * ```
 *
 * out loud to opt out. One visible line, and it is the only thing standing
 * between this repository's suite and the ordinary kind of flakiness that is
 * nobody's fault in particular.
 *
 * ## How the leak reaches the other file
 *
 * Each Playwright worker has its own TaskFlow and its own database, and files
 * are handed to workers as they free up. So the row this file leaves is visible
 * to `visible-tasks.spec.ts` **only if that file happens to run next, in this
 * worker**. On a run where the two land in different workers, or where something
 * else is scheduled between them, nothing is wrong at all.
 *
 * That is where the intermittency comes from, and it is worth being precise: it
 * is not timing inside a test, and it is not the product. It is the scheduler.
 * Two other spec files sit between this one and `visible-tasks.spec.ts` in the
 * queue, so the row survives to it only when both of those went to the other
 * worker — which depends on how long every file before them took.
 *
 * Measured over twelve full runs: four failures in the other file. It fails less
 * often on runs where the deliberately racy reorder spec fails, because that
 * spec's ten-second timeout keeps a worker busy and changes who picks up what.
 *
 * ## Do not fix this by adding cleanup here
 *
 * That is the correct fix and it would delete the fixture. It is one line:
 *
 * ```ts
 * test.afterEach(async ({ db }) => { seed(db) })
 * ```
 *
 * — or simply not opting out of the reset in the first place.
 */

test.use({ resetDatabase: false })

/** Distinctive on purpose, so a failure in the other file can be traced back here. */
const TEMPLATE = 'Prepare the quarterly review pack'

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('adds a task from a template and shows it at the end of the list', async ({ page, db }) => {
  await page.getByPlaceholder('What needs doing?').fill(TEMPLATE)
  await page.getByRole('button', { name: 'Add task' }).click()

  await expect(row(page, TEMPLATE)).toBeVisible()
  expect(stored(db).at(-1)?.title).toBe(TEMPLATE)
})

test('offers the same controls on a task added from a template', async ({ page }) => {
  await expect(row(page, TEMPLATE).getByRole('button', { name: 'Complete' })).toBeVisible()
  await expect(row(page, TEMPLATE).getByRole('button', { name: 'Edit' })).toBeVisible()
  await expect(row(page, TEMPLATE).getByRole('button', { name: 'Delete' })).toBeVisible()

  // It is still here, because the test above left it here. Reading that as
  // convenient rather than as a problem is exactly how a suite acquires order
  // dependence: the second test is now relying on the first.
  await expect(items(page)).not.toHaveCount(0)
})
