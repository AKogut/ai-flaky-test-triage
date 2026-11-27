import type { Page } from '@playwright/test'
import { action, open, row } from './board.js'
import { expect, stored, test } from './fixtures.js'

/**
 * # The race nobody put there. `app_code` + `intermittent`.
 *
 * A task completed and reopened straight away should end up open. It does, on
 * the server, every time. On the screen it often ends up done. This spec fails
 * intermittently, and the test is not at fault.
 *
 * ## Where it comes from
 *
 * `toggle` in `app/client/useTasks.ts` is the application's one optimistic
 * write besides reordering. Its documentation is about the failure path — put
 * this task's status back if the server disagrees, by field rather than by
 * snapshot — and that path is careful. The success path is one line:
 *
 * ```ts
 * tasks: current.tasks.map((row) => (row.id === task.id ? updated : row))
 * ```
 *
 * It applies whichever response arrives, when it arrives, with nothing checking
 * that it answers the newest request. So:
 *
 * 1. Complete is clicked. The row paints "Done"; `PATCH …/complete` goes out.
 * 2. Reopen is clicked before that answers. The row paints "To do";
 *    `PATCH …/:id` with `status: active` goes out.
 * 3. The server handles them in the order they were sent and stores `active`.
 * 4. **The completion's response arrives last**, carrying `completed`, and
 *    replaces the row. The screen says "Done"; the database says otherwise; a
 *    reload corrects it.
 *
 * It is the same shape as the reorder defect `useTasks.move` documents on
 * purpose, in a different function, and nothing documents it. The hook's own
 * header says there is exactly one deliberate race in the application, and this
 * is not it. Nobody designed it; writing a correct spec for an ordinary
 * interaction found it.
 *
 * ## Why it is intermittent
 *
 * On an idle machine both responses come back in order and nothing happens.
 * The file runs against the chaotic instance (`tests/e2e/harness.ts`), which
 * delays each response by a seeded draw — up to 250 ms for a completion and up
 * to 150 ms for an ordinary update — and the seed changes every run. The
 * completion's answer arrives last only when its delay exceeds the update's by
 * more than the gap between the two clicks. Measured: **6 failures in 9 full runs**.
 *
 * ## Why the label is `app_code` and not `test_code`
 *
 * The failure is a web-first assertion that timed out, which is the signature of
 * a spec that looked too early. This one did not. It waits for each click to
 * paint, then for **both** writes to answer, then polls the stored row and sees
 * `active`, and only then asserts on the screen. Nothing was in flight when that
 * last wait began, and the stored value it had just read is the value the screen
 * never reached. Rule 2 does not fire, so rule 3 decides: the product is what is
 * wrong.
 *
 * ## Do not fix this by editing this file
 *
 * Waiting for the first write to answer before the second click would hide it,
 * because the spec would stop doing what a person clicking twice does. The fix
 * is in `toggle`: ignore a response older than the newest request for
 * that task. Applying it means deleting the golden-dataset fixture this file
 * feeds.
 */

test.use({ chaos: true })

const TASK = 'Draft the release notes'

/** Counts answered status writes, so the last assertion runs with nothing in flight. */
function statusWrites(page: Page): () => number {
  let answered = 0
  page.on('response', (response) => {
    if (response.request().method() === 'PATCH' && /\/api\/tasks\/\d+/.test(response.url())) {
      answered += 1
    }
  })
  return () => answered
}

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('keeps a task open when it is completed and reopened straight away', async ({ page, db }) => {
  const answered = statusWrites(page)

  await action(page, TASK, 'Complete').click()
  await expect(row(page, TASK).getByTestId('task-status')).toHaveText('Done')

  await action(page, TASK, 'Reopen').click()
  await expect(row(page, TASK).getByTestId('task-status')).toHaveText('To do')

  await expect.poll(answered).toBe(2)
  await expect.poll(() => stored(db).find((task) => task.title === TASK)?.status).toBe('active')

  await expect(row(page, TASK).getByTestId('task-status')).toHaveText('To do')
})
