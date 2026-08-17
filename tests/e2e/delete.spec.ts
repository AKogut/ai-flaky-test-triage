import { SEED } from '@sentra/taskflow-server'
import { action, emptyState, items, open, row, titles } from './board.js'
import { expect, stored, test } from './fixtures.js'

/**
 * Deleting a task, which TaskFlow asks about first.
 *
 * The confirmation is two buttons in the page rather than `window.confirm`, and
 * that is a deliberate choice made in `App.tsx` for the sake of this file: a
 * native dialog blocks the event loop and has to be intercepted by name in
 * Playwright, which is a genuine and well-known source of intermittent failures.
 * This application's intermittency is meant to come from exactly one place, so
 * the dialog is in the DOM where a spec can see it.
 */

const TASK = 'Draft the release notes'

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('asks before deleting anything', async ({ page, db }) => {
  await action(page, TASK, 'Delete').click()

  await expect(row(page, TASK).getByTestId('delete-confirm')).toBeVisible()
  await expect(items(page)).toHaveCount(SEED.length)
  expect(stored(db)).toHaveLength(SEED.length)
})

test('keeps the task when the confirmation is dismissed', async ({ page, db }) => {
  await action(page, TASK, 'Delete').click()
  await action(page, TASK, 'Cancel').click()

  await expect(page.getByTestId('delete-confirm')).toHaveCount(0)
  await expect(page.getByText(TASK)).toBeVisible()
  expect(stored(db).map((task) => task.title)).toContain(TASK)
})

test('removes the task when the deletion is confirmed', async ({ page, db }) => {
  await action(page, TASK, 'Delete').click()
  await action(page, TASK, 'Confirm delete').click()

  await expect(page.getByText(TASK)).toHaveCount(0)
  await expect(items(page)).toHaveCount(SEED.length - 1)
  expect(stored(db).map((task) => task.title)).not.toContain(TASK)
})

test('leaves the other rows in the order they were in', async ({ page }) => {
  const before = await titles(page).allTextContents()

  await action(page, TASK, 'Delete').click()
  await action(page, TASK, 'Confirm delete').click()
  await expect(items(page)).toHaveCount(SEED.length - 1)

  await expect(titles(page)).toHaveText(before.filter((title) => title !== TASK))
})

test('keeps the deletion after a reload', async ({ page }) => {
  await action(page, TASK, 'Delete').click()
  await action(page, TASK, 'Confirm delete').click()
  await expect(items(page)).toHaveCount(SEED.length - 1)

  await open(page)
  await expect(page.getByText(TASK)).toHaveCount(0)
})

test('deletes more than one, one confirmation at a time', async ({ page }) => {
  for (const title of [TASK, 'Investigate the board spec']) {
    await action(page, title, 'Delete').click()
    await action(page, title, 'Confirm delete').click()
    await expect(page.getByText(title)).toHaveCount(0)
  }

  await expect(items(page)).toHaveCount(SEED.length - 2)
})

test('shows the empty state once the last task is gone', async ({ page, db }) => {
  db.exec("DELETE FROM tasks WHERE title != 'Draft the release notes'")
  await open(page)
  await expect(items(page)).toHaveCount(1)

  await action(page, TASK, 'Delete').click()
  await action(page, TASK, 'Confirm delete').click()

  await expect(emptyState(page)).toHaveText('Nothing to do. Add a task to get started.')
  await expect(items(page)).toHaveCount(0)
})

/**
 * A delete the server refuses. Forced at the network boundary, so the failure is
 * the one the test is about rather than one it happened to catch.
 *
 * Deleting is not optimistic — the row is removed only once the server has
 * agreed — so the interesting assertion is that a refusal leaves the list intact
 * rather than that it is restored.
 */
test('keeps the row when the server refuses the delete', async ({ page, db }) => {
  await page.route('**/api/tasks/*', async (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal', message: 'something went wrong' } }),
        })
      : route.fallback(),
  )

  await action(page, TASK, 'Delete').click()
  await action(page, TASK, 'Confirm delete').click()

  await expect(page.getByTestId('write-error')).toBeVisible()
  await expect(page.getByText(TASK)).toBeVisible()
  await expect(items(page)).toHaveCount(SEED.length)
  expect(stored(db).map((task) => task.title)).toContain(TASK)
})
