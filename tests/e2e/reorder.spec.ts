import { items, open, row, titles } from './board.js'
import { expect, stored, test } from './fixtures.js'

/**
 * Reordering the list, one move at a time. Part of the control group.
 *
 * Read this file next to `reorder-quick-succession.spec.ts`. They exercise the same feature
 * through the same buttons against the same application, and one of them fails
 * about a third of the time. The difference is not the quality of the test — the
 * rules are identical and both are held to them by
 * `tests/unit/e2e-standards.test.ts`. The difference is that this file makes one
 * move at a time and waits for it, and the other makes two before the first has
 * answered.
 *
 * That is the whole of the demonstration: a reader who can see why this file is
 * stable can see that the other file's failure is the application's.
 *
 * **The buttons rather than the drag.** "Move up" and "Move down" go through the
 * same `move` in `useTasks.ts` that a drag does. HTML drag-and-drop is
 * notoriously hard to drive from Playwright, and a spec built on synthesised
 * drag events would be fragile for reasons that have nothing to do with the
 * application — which in this repository would be an expensive mistake, because
 * the failure would look exactly like the one #52 is trying to isolate.
 */

test.beforeEach(async ({ page }) => {
  await open(page)
})

const FIRST = 'Write the incident postmortem'
const SECOND = 'Review the migration plan'
const LAST = 'Investigate the board spec'

test('moves a task up one place', async ({ page, db }) => {
  const before = await titles(page).allTextContents()

  await row(page, SECOND).getByRole('button', { name: 'Move up' }).click()

  await expect(titles(page).first()).toHaveText(SECOND)
  await expect(titles(page).nth(1)).toHaveText(FIRST)
  expect(
    stored(db)
      .map((task) => task.title)
      .slice(0, 2),
  ).toEqual([SECOND, FIRST])

  // Nothing else moved: a reorder writes one row, and a reorder that renumbered
  // the list would pass the two assertions above and still be a bug.
  await expect(titles(page)).toHaveText([SECOND, FIRST, ...before.slice(2)])
})

test('moves a task down one place', async ({ page, db }) => {
  await row(page, FIRST).getByRole('button', { name: 'Move down' }).click()

  await expect(titles(page).first()).toHaveText(SECOND)
  await expect(titles(page).nth(1)).toHaveText(FIRST)
  expect(stored(db)[0]?.title).toBe(SECOND)
})

test('cannot move the first task up', async ({ page }) => {
  await expect(row(page, FIRST).getByRole('button', { name: 'Move up' })).toBeDisabled()
})

test('cannot move the last task down', async ({ page }) => {
  await expect(row(page, LAST).getByRole('button', { name: 'Move down' })).toBeDisabled()
})

/**
 * One move, waited for, then the next. This is the sequence the race needs and
 * does not get: by the time the second click happens the first response has
 * landed and been applied, so there is nothing in flight to arrive out of order.
 */
test('walks a task up the list, one waited-for move at a time', async ({ page, db }) => {
  // It starts last, at index 5. Each move waits for the list to show it landed
  // before the next click, which is the difference between this file and
  // `reorder-quick-succession.spec.ts` — there is never more than one write in
  // flight.
  for (const landing of [4, 3, 2]) {
    await row(page, LAST).getByRole('button', { name: 'Move up' }).click()
    await expect(titles(page).nth(landing)).toHaveText(LAST)
  }

  await expect.poll(() => stored(db)[2]?.title).toBe(LAST)
})

test('keeps the new order after a reload', async ({ page }) => {
  await row(page, SECOND).getByRole('button', { name: 'Move up' }).click()
  await expect(titles(page).first()).toHaveText(SECOND)

  await open(page)
  await expect(titles(page).first()).toHaveText(SECOND)
})

test('does not add or lose a task', async ({ page, db }) => {
  const before = stored(db).length

  await row(page, SECOND).getByRole('button', { name: 'Move up' }).click()
  await expect(titles(page).first()).toHaveText(SECOND)

  await expect(items(page)).toHaveCount(before)
  expect(stored(db)).toHaveLength(before)
})

/**
 * The reorder is optimistic, so a refusal has no single field to put back — the
 * local move already renumbered the list. `useTasks.move` re-reads instead, and
 * this asserts that it does: the list returns to the server's order rather than
 * to a guess.
 */
test('re-reads the list when the server refuses the move', async ({ page }) => {
  const before = await titles(page).allTextContents()

  await page.route('**/api/tasks/reorder', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', message: 'something went wrong' } }),
    }),
  )

  await row(page, SECOND).getByRole('button', { name: 'Move up' }).click()

  await expect(page.getByTestId('write-error')).toBeVisible()
  await expect(titles(page)).toHaveText(before)
})
