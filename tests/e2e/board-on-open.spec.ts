import { SEED } from '@sentra/taskflow-server'
import { open, titles } from './board.js'
import { expect, test } from './fixtures.js'

/**
 * # The one that was right once. `test_code` + `deterministic`.
 *
 * A spec whose expectation describes the application as it used to be. It
 * fails on every run, against an application that is doing exactly what it was
 * changed to do.
 *
 * ## The mechanism
 *
 * The first test lists the board it expects to open on, title by title. The
 * list is the seed as #152 shipped it — five rows, the fifth under the name #169
 * later gave it. #158 added a sixth, "Review the release checklist", completed,
 * and did it on purpose: it is the second row whose title begins "Review the",
 * which is the ambiguity `find-by-name.spec.ts` exists to demonstrate, and
 * `app/client/App.tsx` documents the decision.
 *
 * A spec written before #158 would hold exactly this list today. #169's rename
 * would have reached it, because a rename is a search and replace across the
 * suite; a new row is not something a search and replace adds. This file is that
 * spec, written now so its failure can be captured from a real run rather than
 * imagined.
 *
 * So the board renders six titles, the expectation has five, and the assertion
 * reports the difference: one extra row in the middle of an otherwise identical
 * list. Every row it names exists; the row it does not name exists too.
 *
 * ## Why `test_code`, and why not `app_code`
 *
 * The tempting reading is that the application showed a row it should not have
 * — which is exactly how `visible-tasks.spec.ts` fails when another file leaks a
 * row into it. The difference is where the row comes from. Here it is in the
 * seed, the seed is the specification, and the change that put it there is
 * deliberate and documented. Rule 1 does not fire: the page loaded and the
 * assertion ran. Rule 2 does not either: the spec waits properly and depends on
 * nothing another test did. Rule 3 decides it — the failure reproduces against
 * an unchanged product, in an isolated run with a freshly seeded database, and
 * the side that is wrong is the expectation.
 *
 * The second test is the same claim written against `SEED` rather than copied
 * from it, and it passes on every run. That is the fix, deliberately not applied
 * to the first: an expectation derived from the thing it describes cannot drift
 * from it.
 *
 * ## Why `deterministic`
 *
 * Nothing in it varies. The database is reseeded before the test, the calm
 * instance adds no latency, and the board it renders is the same six rows in the
 * same order every time. Measured: **9 failures in 9 runs**, all with the same
 * one-row difference.
 *
 * ## Do not fix this by updating the list
 *
 * Updating it is the correct fix and it would delete the golden-dataset fixture
 * this file feeds. `scripts/e2e-summary.ts` lists the file as failing on every
 * run and fails the job on the day it passes.
 */

test.beforeEach(async ({ page }) => {
  await open(page)
})

test('opens on the seeded tasks, in order', async ({ page }) => {
  await expect(titles(page)).toHaveText([
    'Write the incident postmortem',
    'Review the migration plan',
    'Renew the staging certificate',
    'Draft the release notes',
    'Investigate the board spec',
  ])
})

test('opens on every task the seed defines, in seed order', async ({ page }) => {
  await expect(titles(page)).toHaveText(SEED.map((task) => task.title))
})
