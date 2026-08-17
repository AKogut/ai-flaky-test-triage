import { SEED } from '@sentra/taskflow-server'
import { action, items, open, row, titles } from './board.js'
import { expect, stored, test } from './fixtures.js'

/**
 * Completing and reopening a task.
 *
 * This is the flow with the optimistic write behind it — `toggle` in
 * `useTasks.ts` paints first and rolls the field back if the server disagrees —
 * which makes it the one place in the control group where "the screen says so"
 * and "the server agrees" are genuinely different claims. Both are asserted, and
 * separately.
 *
 * Optimism is not flakiness. The paint is synchronous and the reconciliation
 * replaces one field of one row, so there is no interleaving to lose: two
 * completions in flight touch different rows, and a completion racing its own
 * response converges on the server's answer. The race this project is about
 * lives in `move`, not here, and #52 is the spec that catches it.
 */

const ACTIVE = 'Draft the release notes'
const DONE = 'Renew the staging certificate'

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('marks a task done', async ({ page, db }) => {
  await action(page, ACTIVE, 'Complete').click()

  await expect(row(page, ACTIVE).getByTestId('task-status')).toHaveText('Done')
  expect(stored(db).find((task) => task.title === ACTIVE)?.status).toBe('completed')
})

test('offers to reopen what it just completed', async ({ page }) => {
  await action(page, ACTIVE, 'Complete').click()

  // The control renames itself, which is the affordance a user reads. Asserting
  // on the name rather than on a class means a rewording is a visible failure —
  // deliberately, since that is the fragility `button-lookup-uses-superseded-label`
  // in the golden dataset is about.
  await expect(action(page, ACTIVE, 'Reopen')).toBeVisible()
  await expect(action(page, ACTIVE, 'Complete')).toHaveCount(0)
})

test('reopens a completed task', async ({ page, db }) => {
  await action(page, DONE, 'Reopen').click()

  await expect(row(page, DONE).getByTestId('task-status')).toHaveText('To do')
  await expect(action(page, DONE, 'Complete')).toBeVisible()
  expect(stored(db).find((task) => task.title === DONE)?.status).toBe('active')
})

test('keeps the change after a reload', async ({ page }) => {
  await action(page, ACTIVE, 'Complete').click()
  await expect(row(page, ACTIVE).getByTestId('task-status')).toHaveText('Done')

  await open(page)
  await expect(row(page, ACTIVE).getByTestId('task-status')).toHaveText('Done')
})

/**
 * The list is ordered by position, and completing a task changes its status, not
 * its position. A UI that quietly moved completed rows to the bottom would break
 * every drag-and-drop assertion in the suite for a reason none of them mention.
 */
test('leaves the order alone', async ({ page }) => {
  const before = await titles(page).allTextContents()

  await action(page, ACTIVE, 'Complete').click()
  await expect(row(page, ACTIVE).getByTestId('task-status')).toHaveText('Done')

  await expect(titles(page)).toHaveText(before)
})

test('completes one task without touching its neighbours', async ({ page, db }) => {
  const untouched = stored(db).filter((task) => task.title !== ACTIVE)

  await action(page, ACTIVE, 'Complete').click()
  await expect(row(page, ACTIVE).getByTestId('task-status')).toHaveText('Done')

  const after = stored(db).filter((task) => task.title !== ACTIVE)
  expect(after.map((task) => [task.title, task.status])).toEqual(
    untouched.map((task) => [task.title, task.status]),
  )
})

test('completes every task, one after another', async ({ page }) => {
  for (const task of SEED.filter((row) => row.completed !== true)) {
    await action(page, task.title, 'Complete').click()
    await expect(row(page, task.title).getByTestId('task-status')).toHaveText('Done')
  }

  await expect(page.getByTestId('task-status').filter({ hasText: 'To do' })).toHaveCount(0)
  await expect(items(page)).toHaveCount(SEED.length)
})

/**
 * The rollback path. Forced at the network boundary so it is deterministic:
 * the request never reaches the server, so there is no timing to get wrong.
 *
 * What it demonstrates is the interesting half of an optimistic write — the row
 * flips, the server refuses, and the row flips back. A UI that painted and then
 * left the wrong state on screen would be lying to the user, and no reload would
 * be there to correct it.
 */
test('puts the row back when the server refuses', async ({ page, db }) => {
  await page.route('**/api/tasks/*/complete', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', message: 'something went wrong' } }),
    }),
  )

  await action(page, ACTIVE, 'Complete').click()

  await expect(page.getByTestId('write-error')).toBeVisible()
  await expect(row(page, ACTIVE).getByTestId('task-status')).toHaveText('To do')
  expect(stored(db).find((task) => task.title === ACTIVE)?.status).toBe('active')
})
