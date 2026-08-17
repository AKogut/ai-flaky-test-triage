import { SEED } from '@sentra/taskflow-server'
import { add, emptyState, items, open, titles, writeError } from './board.js'
import { expect, stored, test } from './fixtures.js'

/**
 * Creating a task. Part of the control group.
 *
 * ## What "control group" means here, and why it is worth the care
 *
 * The classifier this repository evaluates is measured against a dataset built
 * from these runs. If the ordinary specs are a bit flaky, the dataset says
 * everything is a bit flaky, every number in `eval/report.md` gets harder to
 * read, and the one deliberately flaky spec stops being distinguishable from the
 * noise around it. So the standard here is not "passes on my machine" — it is
 * that a reader comparing this file with the deliberately flaky reorder spec
 * (#52, not yet written) should be able to say *why* one of them is at fault and
 * the other is not.
 *
 * Concretely, in this file and its four siblings:
 *
 * - **Web-first assertions only.** `expect(locator).toHaveCount()` retries until
 *   the condition holds or the timeout expires. `expect(await locator.count())`
 *   samples once and races the application.
 * - **No `waitForTimeout`.** Not one, anywhere. A sleep is a guess about how
 *   fast a machine is, and CI is not that machine.
 * - **No dependence on another test.** Every test opens the board itself and
 *   every test starts from the seeded database, so running one alone and running
 *   it last produce the same result.
 * - **The server is asked too.** The UI can paint a change the server never
 *   accepted — that is exactly what the optimistic path in `useTasks` does — so
 *   where a test is about a write having landed, it checks the row as well as
 *   the pixels.
 */

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('adds a task to the end of the list', async ({ page, db }) => {
  await add(page, 'Write the postmortem')

  await expect(items(page)).toHaveCount(SEED.length + 1)
  await expect(titles(page).last()).toHaveText('Write the postmortem')

  // The server, not only the screen. A create that painted and never landed
  // would satisfy every assertion above.
  expect(stored(db).at(-1)?.title).toBe('Write the postmortem')
})

test('clears the field, so the next task can just be typed', async ({ page }) => {
  await add(page, 'First')

  await expect(page.getByPlaceholder('What needs doing?')).toHaveValue('')
  await expect(items(page)).toHaveCount(SEED.length + 1)
})

test('keeps the task after a reload, because it was written and not just drawn', async ({
  page,
}) => {
  await add(page, 'Survives a refresh')
  await expect(items(page)).toHaveCount(SEED.length + 1)

  await open(page)
  await expect(titles(page).last()).toHaveText('Survives a refresh')
})

test('will not submit an empty title', async ({ page, db }) => {
  const submit = page.getByRole('button', { name: 'Add task' })
  await expect(submit).toBeDisabled()

  // Whitespace is not content. The button stays disabled, which also blocks the
  // implicit submission a return key would perform.
  await page.getByPlaceholder('What needs doing?').fill('   ')
  await expect(submit).toBeDisabled()

  await expect(items(page)).toHaveCount(SEED.length)
  expect(stored(db)).toHaveLength(SEED.length)
})

test('enables the button as soon as there is something to add', async ({ page }) => {
  const submit = page.getByRole('button', { name: 'Add task' })

  await page.getByPlaceholder('What needs doing?').fill('Something')
  await expect(submit).toBeEnabled()
})

test('stores the title without the whitespace around it', async ({ page, db }) => {
  await add(page, '   Padded on both sides   ')

  await expect(titles(page).last()).toHaveText('Padded on both sides')
  expect(stored(db).at(-1)?.title).toBe('Padded on both sides')
})

test('adds a second task below the first', async ({ page }) => {
  await add(page, 'Earlier')
  await expect(items(page)).toHaveCount(SEED.length + 1)

  await add(page, 'Later')
  await expect(items(page)).toHaveCount(SEED.length + 2)

  await expect(titles(page).nth(SEED.length)).toHaveText('Earlier')
  await expect(titles(page).nth(SEED.length + 1)).toHaveText('Later')
})

/**
 * The empty state is the create flow's other end: a board with nothing on it has
 * to say so, or a reader cannot tell it apart from a board that failed to load.
 */
test('offers the empty state when there is nothing left to show', async ({ page, db }) => {
  db.exec('DELETE FROM tasks')
  await open(page)

  await expect(emptyState(page)).toHaveText('Nothing to do. Add a task to get started.')
  await expect(items(page)).toHaveCount(0)

  await add(page, 'The only one')
  await expect(emptyState(page)).toBeHidden()
  await expect(items(page)).toHaveCount(1)
})

/**
 * A rejected write, forced rather than waited for.
 *
 * The failure is injected at the network boundary with `page.route`, which makes
 * it deterministic: the request never reaches the server, so there is nothing to
 * race. Injecting it in the *application* would produce something intermittent,
 * and the one intermittent thing in this suite is meant to be #52.
 */
test('says so when the server refuses the write, and keeps the list', async ({ page, db }) => {
  await page.route('**/api/tasks', async (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal', message: 'something went wrong' } }),
        })
      : route.fallback(),
  )

  await add(page, 'Never lands')

  await expect(writeError(page)).toBeVisible()
  await expect(writeError(page)).toContainText('something went wrong')

  // The list is still there — a failed write must not take the page down with it.
  await expect(items(page)).toHaveCount(SEED.length)
  expect(stored(db)).toHaveLength(SEED.length)

  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(writeError(page)).toBeHidden()
})
