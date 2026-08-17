import { SEED } from '@sentra/taskflow-server'
import { items, open, titles } from './board.js'
import { expect, test } from './fixtures.js'

/**
 * # The symptom. Its cause is in `quarterly-pack.spec.ts`.
 *
 * This spec fails some of the time, and when it does, **everything in its trace
 * is a red herring**. The assertion is here, the stack is here, the snippet is
 * here, the diff is whatever the commit changed — and none of it has anything to
 * do with why the board had a row on it that nobody in this file created.
 *
 * That is what makes cross-test leakage worth a fixture of its own. A developer
 * reading this failure starts from the file the stack names, and the file the
 * stack names is not the problem.
 *
 * ## The mechanism
 *
 * `quarterly-pack.spec.ts` adds a task and never removes it. Both files opt out
 * of the per-test reset — one line each, deliberately — so on a run where that
 * file happens to be scheduled into this worker immediately before this one, its
 * row is still on the board when these assertions run.
 *
 * Each Playwright worker has its own TaskFlow and its own database, and files
 * are handed to workers as they free up. Two other spec files sit between these
 * two in the queue, so the row only survives to this file when both of those
 * were taken by the *other* worker — which depends on how long every file before
 * them happened to take.
 *
 * Measured over twelve full runs: **four failures**. And the correlation is the
 * mechanism, plainly visible: on eight of those runs the deliberately racy
 * reorder spec failed, which keeps a worker busy for its ten-second timeout and
 * changes who picks up what. Same suite, same code, different scheduling — which
 * is what "intermittent" means here, and it is nothing to do with time inside
 * any one test.
 *
 * ## Why the fault is in the tests and not the product
 *
 * The application did exactly what it was asked. A row was created, a row was
 * shown. The suite is what is wrong: one file mutates state it does not restore,
 * and another reads that state and expects it to be untouched. Neither is
 * defensible on its own, which is why the correct fix is in either file and the
 * honest label is `test_code`.
 *
 * ## What a classifier can see, and what it cannot
 *
 * Nothing in the context bundle describes the rest of the run — not what else
 * ran, not in what order, not in which worker. So a classifier given this
 * failure cannot distinguish "this spec is wrong about the data" from "a
 * different spec changed the data", because the second hypothesis has no
 * evidence in its input at all. That is a gap in the assembler rather than in
 * the prompt, and it is filed as #168 rather than papered over with wording.
 */

test.use({ resetDatabase: false })

const SEEDED = SEED.map((task) => task.title)

test.beforeEach(async ({ page }) => {
  await open(page)
})

/**
 * Deliberately tolerant of a board with fewer rows than the seed: several
 * control specs legitimately end having deleted things, and a count assertion
 * here would fail on those for a reason that has nothing to do with this file.
 * What it does not tolerate is a row nobody in the seed defines.
 *
 * The failure message names the row and says nothing about where it came from,
 * which is both what an author who did not know would write and what keeps the
 * captured fixture honest. An earlier version said "nothing here put it there" —
 * true, writable without knowing the cause, and most of the answer.
 */
test('shows only tasks the board was seeded with', async ({ page }) => {
  const rendered = await titles(page).allTextContents()

  for (const title of rendered) {
    expect(SEEDED, `unexpected task on the board: "${title}"`).toContain(title)
  }
})

test('renders every task it shows as a row with a status', async ({ page }) => {
  const rows = await items(page).count()

  await expect(page.getByTestId('task-status')).toHaveCount(rows)
  await expect(titles(page)).toHaveCount(rows)
})
