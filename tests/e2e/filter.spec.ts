import { SEED } from '@sentra/taskflow-server'
import { action, emptyState, items, open, row, titles } from './board.js'
import { expect, test } from './fixtures.js'

/**
 * Filtering the list, and the query parameter that records the choice.
 *
 * The filter is applied in the client, so switching it issues no request. That
 * is what makes these assertions safe to write without waiting on anything: the
 * list changes in the same tick as the click. It is also why this file is the
 * right neighbour for #53 — under a filter, the same locator can match one row
 * or two, and a spec written against one view fails under another for reasons
 * that have nothing to do with timing.
 *
 * The seed leaves two tasks completed and three active. Every count here is
 * derived from `SEED` rather than written as a number, so adding a fixture row
 * cannot leave this file quietly asserting the wrong thing.
 */

const COMPLETED = SEED.filter((task) => task.completed === true)
const ACTIVE = SEED.filter((task) => task.completed !== true)

test('shows everything by default', async ({ page }) => {
  await open(page)

  await expect(items(page)).toHaveCount(SEED.length)
  await expect(page.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
})

test('shows only the active tasks', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Active' }).click()

  await expect(items(page)).toHaveCount(ACTIVE.length)
  await expect(titles(page)).toHaveText(ACTIVE.map((task) => task.title))
})

test('shows only the completed tasks', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Completed' }).click()

  await expect(items(page)).toHaveCount(COMPLETED.length)
  await expect(titles(page)).toHaveText(COMPLETED.map((task) => task.title))
})

/**
 * `aria-pressed`, not a class. It is what a screen reader announces and what a
 * spec can assert on without knowing anything about the stylesheet — the control
 * is found the way a user finds it, by role and name.
 */
test('says which filter is selected', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Active' }).click()

  await expect(page.getByRole('button', { name: 'Active', pressed: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'All', pressed: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Completed', pressed: false })).toBeVisible()
})

test('records the choice in the address bar', async ({ page }) => {
  await open(page)

  await page.getByRole('button', { name: 'Active' }).click()
  await expect(page).toHaveURL(/\?filter=active$/)

  await page.getByRole('button', { name: 'Completed' }).click()
  await expect(page).toHaveURL(/\?filter=completed$/)

  // `all` is the default, so it leaves no parameter behind. A URL that carries
  // its defaults is one nobody can read at a glance.
  await page.getByRole('button', { name: 'All' }).click()
  await expect(page).toHaveURL((url) => url.search === '')
})

test('opens straight into the filter a link asked for', async ({ page }) => {
  await open(page, '?filter=completed')

  await expect(items(page)).toHaveCount(COMPLETED.length)
  await expect(page.getByRole('button', { name: 'Completed', pressed: true })).toBeVisible()
})

/**
 * A typo in a shared link should still show tasks. The alternative — an empty
 * board, or an error — makes a link that was almost right look like an outage.
 */
test('falls back to everything when the parameter makes no sense', async ({ page }) => {
  await open(page, '?filter=nearly')

  await expect(items(page)).toHaveCount(SEED.length)
  await expect(page.getByRole('button', { name: 'All', pressed: true })).toBeVisible()
})

test('keeps the filter across a reload', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Active' }).click()
  await expect(items(page)).toHaveCount(ACTIVE.length)

  await page.reload()
  await expect(page.getByRole('button', { name: 'Active', pressed: true })).toBeVisible()
  await expect(items(page)).toHaveCount(ACTIVE.length)
})

test('moves a task between the two filtered views when it is completed', async ({ page }) => {
  const task = ACTIVE[0]?.title ?? ''

  await open(page)
  await action(page, task, 'Complete').click()
  await expect(row(page, task).getByTestId('task-status')).toHaveText('Done')

  await page.getByRole('button', { name: 'Active' }).click()
  await expect(page.getByText(task)).toHaveCount(0)

  await page.getByRole('button', { name: 'Completed' }).click()
  await expect(page.getByText(task)).toBeVisible()
  await expect(items(page)).toHaveCount(COMPLETED.length + 1)
})

test('adds to the unfiltered list even while a filter is set', async ({ page }) => {
  await open(page, '?filter=completed')
  await expect(items(page)).toHaveCount(COMPLETED.length)

  await page.getByPlaceholder('What needs doing?').fill('Created under a filter')
  await page.getByRole('button', { name: 'Add task' }).click()

  // A new task is active, so it does not belong in this view — and the view is
  // not silently switched, because a filter the user set is a filter they meant.
  await expect(items(page)).toHaveCount(COMPLETED.length)
  await page.getByRole('button', { name: 'All' }).click()
  await expect(page.getByText('Created under a filter')).toBeVisible()
})

/**
 * "Nothing here" and "nothing matches" are different facts, and the application
 * says so in different words. One message for both would leave a reader unable
 * to tell an empty database from a filter they forgot they set.
 */
test.describe('the empty states', () => {
  test('says everything is done when nothing is active', async ({ page, db }) => {
    db.exec("UPDATE tasks SET status = 'completed'")
    await open(page, '?filter=active')

    await expect(emptyState(page)).toHaveText('No active tasks. Everything here is done.')
  })

  test('says nothing is completed when nothing is', async ({ page, db }) => {
    db.exec("UPDATE tasks SET status = 'active'")
    await open(page, '?filter=completed')

    await expect(emptyState(page)).toHaveText('Nothing completed yet.')
  })

  test('says the board is empty when it is', async ({ page, db }) => {
    db.exec('DELETE FROM tasks')
    await open(page, '?filter=active')

    await expect(emptyState(page)).toHaveText('No active tasks. Everything here is done.')
  })
})
