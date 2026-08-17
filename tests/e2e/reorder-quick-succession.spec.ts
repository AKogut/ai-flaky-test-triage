import type { Page } from '@playwright/test'
import { open, row, titles } from './board.js'
import { expect, stored, test } from './fixtures.js'

/**
 * # The flaky one. `app_code` + `intermittent` — the hard quadrant.
 *
 * This spec fails about a third of the time, and **the test is not at fault.**
 * That claim is the whole point of the file, so here is the evidence for it.
 *
 * ## What the test does
 *
 * Clicks "Move up" on a task, waits for the list to show the move, clicks it
 * again, waits again, then waits for both writes to have answered and asserts
 * the list shows what the server holds. Two quick moves is an ordinary thing for
 * a person to do — it is one drag followed by another before the first has
 * finished — and both are supposed to stick.
 *
 * Every rule the control-group specs follow, this one follows too, and
 * `tests/unit/e2e-standards.test.ts` holds it to them: web-first assertions,
 * no `waitForTimeout`, no element handles, no dependence on another test. The
 * final assertion runs only after both responses have arrived, so there is
 * nothing left in flight for it to race.
 *
 * ## Why it fails anyway
 *
 * `move` in `app/client/useTasks.ts` applies whatever a response says, in the
 * order responses **arrive**, with nothing checking that an arriving response is
 * the newest one:
 *
 * ```ts
 * const tasks = await api.reorderTask(id, index)
 * setState((current) => ({ ...current, tasks }))   // ← no sequence check
 * ```
 *
 * So when the first request's response is slower than the second's:
 *
 * 1. Move 1 is sent. The list paints the new order optimistically.
 * 2. Move 2 is sent before move 1 has answered. The list paints again.
 * 3. The server applies both, in the order they were sent, and is correct.
 * 4. **Move 1's response arrives last**, carrying the order as of move 1. The
 *    last `setState` wins, and the second move is visibly undone.
 *
 * The database is right and the screen is wrong. A refresh fixes it, which is
 * the tell — and the reason this test also asserts on the stored rows, so a
 * reader of the failure can see that the write landed and the display did not.
 *
 * ## Why it is intermittent rather than certain
 *
 * The two responses are only out of order when the first is slower than the
 * second by more than the gap between the clicks. On an idle machine both come
 * back in microseconds, in order, and nothing happens — which is exactly why
 * this class of bug reaches production. `SENTRA_E2E_CHAOS` (see
 * `tests/e2e/harness.ts`) delays responses from a seeded generator, so the
 * inversion occurs on some runs and not others.
 *
 * That is a deliberate line: the latency is injected into the **server**, not
 * into this file. A spec with a sleep in it is a spec that says what it expects
 * to happen. This one says nothing about timing, and the race happens anyway.
 *
 * ## What each test does, since the bodies carry no commentary
 *
 * The lines around an assertion end up in the captured fixture's `snippet`, and
 * a comment there is the author's argument about a failure the author already
 * understood. So the bodies are plain and the explanation is here.
 *
 * Both tests move a row, wait for the list to show the move, move again, then
 * wait for **both** writes to have answered before asserting. `expect.poll` on
 * the stored rows shows the server kept both moves in the order they were sent;
 * the assertion after it is the same claim about the screen. When it fails, the
 * row is one place off — the order as of the first move, restored by that move's
 * own late response.
 *
 * The second test moves two rows far enough apart that neither move changes
 * where the other lands, so the expected order is the same whichever request the
 * server happens to see first.
 *
 * ## Why this file is not called `reorder-race.spec.ts`
 *
 * It was, until the fixture it produces was run through the dataset's own
 * leakage check. A file path is part of what a classifier sees, and a file named
 * after its defect hands over the answer: any model reading `-race` will say
 * `app_code` and `intermittent` and be right for a reason that generalises to
 * nothing. The rows it moves were changed for the same reason — one of the
 * seeded titles contains a word from the label vocabulary, and an error message
 * quoting it would have leaked through the payload.
 *
 * Naming a spec after the behaviour under test rather than after the bug is
 * ordinary good practice. Here it is also a measurement precaution.
 *
 * ## Do not fix this by editing this file
 *
 * Every instinct will be to nudge it — tighten a timeout, drop the wait between
 * the clicks, click faster. That would move the failure to `test_code` and
 * destroy the fixture it exists to produce. The one-line fix is in the
 * application: a request sequence number, ignoring any response older than the
 * newest sent. Applying it means deleting the golden-dataset fixtures that
 * depend on this behaviour.
 */

test.use({ chaos: true })

const TASK = 'Draft the release notes'
const OTHER = 'Review the migration plan'

/** Counts answered reorder writes, so the last assertion runs with nothing in flight. */
function reorderResponses(page: Page): () => number {
  let answered = 0
  page.on('response', (response) => {
    if (response.url().endsWith('/api/tasks/reorder')) answered += 1
  })
  return () => answered
}

const moveUp = (page: Page, title: string): Promise<void> =>
  row(page, title).getByRole('button', { name: 'Move up' }).click()

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('keeps both moves when a task is moved twice in quick succession', async ({ page, db }) => {
  const answered = reorderResponses(page)

  // The task starts at index 4. Two moves up put it at index 2.
  await moveUp(page, TASK)
  await expect(titles(page).nth(3)).toHaveText(TASK)

  await moveUp(page, TASK)
  await expect(titles(page).nth(2)).toHaveText(TASK)

  await expect.poll(answered).toBe(2)
  await expect.poll(() => stored(db)[2]?.title).toBe(TASK)

  await expect(titles(page).nth(2)).toHaveText(TASK)
})

/**
 * The same shape with two different tasks, which is what a person doing two
 * quick drags actually produces. Kept separate because the single-task version
 * above has a tidier failure to read, and this one proves the race is about the
 * responses rather than about moving one row twice.
 */
test('keeps both moves when two different tasks are moved', async ({ page, db }) => {
  const answered = reorderResponses(page)

  await moveUp(page, TASK)
  await expect(titles(page).nth(3)).toHaveText(TASK)

  await moveUp(page, OTHER)
  await expect(titles(page).first()).toHaveText(OTHER)

  await expect.poll(answered).toBe(2)
  await expect.poll(() => stored(db)[0]?.title).toBe(OTHER)

  await expect(titles(page).first()).toHaveText(OTHER)
  await expect(titles(page).nth(3)).toHaveText(TASK)
})
