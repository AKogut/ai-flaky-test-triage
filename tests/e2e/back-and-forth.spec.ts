import type { Page } from '@playwright/test'
import { open, row, titles } from './board.js'
import { expect, stored, test } from './fixtures.js'

/**
 * # The one that runs out of room. `app_code` + `deterministic`.
 *
 * Two tasks trade places, again and again, and on the fifty-fifth move the
 * server answers with an order nobody asked for. Every move is sent after the
 * previous one has answered, nothing is in flight, and the database itself is
 * wrong. It fails on every run, at the same move.
 *
 * ## The mechanism
 *
 * `reorder` in `app/server/db.ts` gives a moved row the midpoint of its new
 * neighbours' positions:
 *
 * ```ts
 * (before.position + after.position) / 2
 * ```
 *
 * Positions are SQLite `REAL`s — doubles — and nothing ever renumbers them. Each
 * move into the same gap halves it. Between the first row's position, 1, and the
 * next one along, a double has 52 bits of fraction to give, so the halving runs
 * out:
 *
 * | move | what the server stores                                                |
 * | ---: | --------------------------------------------------------------------- |
 * |   52 | the gap is one unit in the last place                                 |
 * |   53 | the midpoint rounds onto 1, the first row's position — a tie          |
 * |   54 | a three-way tie, which `ORDER BY position, id` happens to get right   |
 * |   55 | the moved row ties again and sorts by id, behind the row it passed    |
 *
 * From the first tie on, the order is decided by insertion id rather than by
 * anything the user did, and on move 55 that puts the row back where it was. The
 * request succeeded, the response is a 200, and the stored order is not the one
 * requested. The screen shows what the server returned, faithfully.
 *
 * That is the difference from `reorder-quick-succession.spec.ts`, which looks
 * similar from a distance. There the database is right and the client applies an
 * old response over a new one. Here the client is right to believe the server,
 * and the server has stored a tie.
 *
 * ## Why `app_code`, and why not `test_code`
 *
 * The tempting reading is that a test making sixty moves is doing something no
 * user does, and that the timeout in the failure means the test looked too
 * early. Neither holds. The test waits for each write to answer before it looks,
 * then polls the stored order, then checks the screen; there is no fixed wait and
 * nothing it depends on from another test. And the state it reaches is one the
 * product reaches on its own: a board in use for weeks accumulates midpoint
 * insertions in the same few gaps, and this spec compresses that into one run
 * rather than inventing a state the application cannot get into.
 *
 * Rule 2 does not fire, so rule 3 decides: the failure reproduces against an
 * unchanged product, and the product is what is wrong. The fix is in
 * `reorder` — renumber when a midpoint collides with a neighbour, or store
 * integer ranks.
 *
 * ## Why `deterministic`
 *
 * Arithmetic. No clock, no scheduler and no injected latency reaches it: the calm
 * instance, a freshly seeded database, and the same sequence of midpoints on
 * every run. Measured: **20 failures in 20 runs**, every one of them at move 55.
 *
 * ## Why the file is called what it is
 *
 * It was `move-back-and-forth.spec.ts` first, which sorts immediately before
 * `quarterly-pack.spec.ts`. Its first test holds a worker for about thirteen
 * seconds, so the other worker then ran `quarterly-pack`, `reorder` and
 * `visible-tasks` back to back, `reorder` reseeded the database in between, and
 * the cross-file leak those two files demonstrate stopped happening: no failure
 * in nine runs, against four in twelve before. Renamed so it sorts near the
 * start, where it delays both workers' first files rather than the one ordering
 * the leak depends on. A spec's position in the queue is part of what the suite
 * measures.
 *
 * ## Do not fix this by making fewer moves
 *
 * Fifty-four would pass. It would also stop the spec from detecting the defect
 * it exists to detect. The fix is in the application, and applying it means
 * deleting the golden-dataset fixture this file feeds.
 */

/** The two rows that trade places, below the first row and above the rest. */
const PAIR = ['Renew the staging certificate', 'Review the migration plan'] as const
const MOVES = 60

const moveUp = (page: Page, title: string): Promise<void> =>
  row(page, title).getByRole('button', { name: 'Move up' }).click()

const answered = (page: Page): Promise<unknown> =>
  page.waitForResponse((response) => response.url().endsWith('/api/tasks/reorder'))

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('keeps every move when two tasks trade places sixty times', async ({ page, db }) => {
  for (let move = 0; move < MOVES; move++) {
    const title = PAIR[move % PAIR.length] ?? ''

    await Promise.all([answered(page), moveUp(page, title)])
    await expect
      .poll(() => stored(db)[1]?.title, `second stored row after move ${String(move + 1)}`)
      .toBe(title)

    await expect(titles(page).nth(1)).toHaveText(title)
  }
})

/**
 * The same move a handful of times, so the file shows the behaviour is right
 * until the gap runs out. Passes on every run.
 */
test('keeps every move when two tasks trade places a few times', async ({ page, db }) => {
  for (let move = 0; move < 4; move++) {
    const title = PAIR[move % PAIR.length] ?? ''

    await Promise.all([answered(page), moveUp(page, title)])
    await expect.poll(() => stored(db)[1]?.title).toBe(title)

    await expect(titles(page).nth(1)).toHaveText(title)
  }
})
