import { SEED } from '@sentra/taskflow-server'
import { add, open } from './board.js'
import { expect, test } from './fixtures.js'

/**
 * # The other flaky one. `test_code` + `intermittent`.
 *
 * The counterweight to `reorder-quick-succession.spec.ts`. Same symptom — a spec
 * that fails some of the time — and the opposite owner, which is the pair that
 * makes the two-axis taxonomy earn its keep: a flat "flaky" label puts these in
 * one bucket while they need completely different responses. One is a bug to
 * fix in the product. This one is a bug to fix in the test, and the product is
 * behaving perfectly.
 *
 * ## The mechanism
 *
 * `getByText('Review the')` is a substring match. The seeded board already
 * contains "Review the migration plan" and "Review the release checklist", so
 * the locator is ambiguous under `?filter=all` and unambiguous under
 * `?filter=active`, where only one of them is showing.
 *
 * This spec opens the active list — one match, fine — and adds a task whose
 * title happens to begin the same way. Once that row arrives there are two
 * matches, Playwright's strict mode refuses to guess which one was meant, and
 * the assertion fails with **"resolved to 2 elements"**.
 *
 * Creating is not optimistic: `useTasks.create` waits for the server and then
 * appends what it returns. So whether the second row is on screen when the
 * assertion first resolves depends on how quickly that write answers — and
 * against the chaotic instance, that varies.
 *
 * ## Why this is not a timing failure, even though the timing varies
 *
 * Because waiting does not help. A timing failure is one where the application
 * is on its way to the state the spec expects and the spec looked too early;
 * waiting longer fixes it. Here the opposite is true: the longer the spec waits,
 * the more certainly there are two matching rows.
 *
 * Measured. As written, this test fails on about half of its runs. Adding the
 * correct synchronisation in front of the assertion —
 *
 * ```ts
 * await expect(page.getByTestId('task-item')).toHaveCount(ACTIVE + 1)
 * ```
 *
 * — took it to **eight failures out of eight**. The wait that would fix a timing
 * bug makes this one certain, which is as clear a demonstration as the
 * distinction admits.
 *
 * The evidence a classifier sees says so too. A timing failure reports a value
 * that never arrived; this one reports
 *
 * ```
 * strict mode violation: getByText('Review the') resolved to 2 elements
 * ```
 *
 * and names both of them. Nothing in that message is about time.
 *
 * ## The correct fix, which is deliberately not applied
 *
 * ```ts
 * await expect(page.getByText('Review the incident timeline', { exact: true })).toBeVisible()
 * ```
 *
 * Or scope the search to the row: `row(page, title)`. Either makes the locator
 * name one thing, which is what a locator is for. Applying it here would delete
 * the fixture this file exists to produce — see the dataset entry it feeds.
 *
 * ## What it must not become
 *
 * A test that waits for two rows and then asserts on an ambiguous locator would
 * fail every run, which is a *stale test* — `test_code` + `deterministic`, a
 * different quadrant with a different response. The intermittency is the point,
 * and it comes from the row sometimes not having arrived yet.
 */

test.use({ chaos: true })

/** The substring the seeded board already contains twice, in two different states. */
const PREFIX = 'Review the'
const NEW_TASK = 'Review the incident timeline'

const ACTIVE = SEED.filter((task) => task.completed !== true).length

test.beforeEach(async ({ page }) => {
  await open(page, '?filter=active')
})

test('finds a newly added task in the active list', async ({ page }) => {
  await expect(page.getByText(PREFIX)).toBeVisible()

  await add(page, NEW_TASK)

  await page.getByRole('button', { name: 'Completed' }).click()
  await expect(page.getByText(NEW_TASK)).toHaveCount(0)
  await expect(page.getByText('Review the release checklist')).toBeVisible()

  await page.getByRole('button', { name: 'Active' }).click()
  await expect(page.getByRole('button', { name: 'Active', pressed: true })).toBeVisible()
  await expect(page.getByText('Write the incident postmortem')).toBeVisible()

  await expect(page.getByText(PREFIX)).toBeVisible()
})

/**
 * The same locator against a list that never changes, to show it is not the
 * locator style that is wrong.
 *
 * Under `?filter=completed` exactly one seeded row begins "Review the", so the
 * substring match names one element and this passes on every run. The selector
 * is not broken in general; it is broken against a list state the application
 * legitimately reaches, which is the thing that makes this class of failure hard
 * to spot in review.
 */
test('finds the completed one without ambiguity, because only one is showing', async ({ page }) => {
  await open(page, '?filter=completed')

  await expect(page.getByText(PREFIX)).toBeVisible()
  await expect(page.getByText(PREFIX)).toHaveText('Review the release checklist')
})

/**
 * And the count the ambiguity comes from, stated as data rather than inferred
 * from a failure. Two rows begin with the prefix; the filter decides how many of
 * them are on screen.
 */
test('shows how many rows the prefix matches in each list', async ({ page }) => {
  await expect(page.getByText(PREFIX)).toHaveCount(1)
  await expect(page.getByTestId('task-item')).toHaveCount(ACTIVE)

  await page.getByRole('button', { name: 'All' }).click()
  await expect(page.getByText(PREFIX)).toHaveCount(2)

  await page.getByRole('button', { name: 'Completed' }).click()
  await expect(page.getByText(PREFIX)).toHaveCount(1)
})
