import { clear, create, update, type Db, type Task } from './db.js'

/**
 * A deterministic starting state.
 *
 * Deterministic in every respect that a test could assert on: the same ids, the
 * same order, the same timestamps. A seed that used the wall clock would make
 * every snapshot and every "most recent" assertion depend on when the suite ran,
 * and the resulting failures would look exactly like the flakiness this project
 * exists to classify — with the difference that they would be the fixture's
 * fault, which is the one kind of noise the dataset must not contain.
 *
 * Small on purpose. Five rows is enough for ordering, filtering and drag targets,
 * and few enough to read in a failure message.
 *
 * Two details are load-bearing rather than decorative, and both exist so that
 * #53 has a realistically fragile locator to be flaky about:
 *
 * - **Two rows are completed.** Every row renders the same status label, so a
 *   text locator matches three "To do" and two "Done" under no filter, and two
 *   "Done" and nothing else under `?filter=completed`. A Playwright locator that
 *   resolves to more than one element fails in strict mode, so a spec written
 *   against one filter fails under another for reasons that have nothing to do
 *   with timing.
 * - **Two titles begin "Review the".** A locator built from a partial title
 *   matches two rows under one filter and one under another, which is the same
 *   failure arriving through the more common mistake.
 */

/**
 * One rule the titles must follow, learned the hard way.
 *
 * **No title may contain a word from the label vocabulary.** A captured fixture
 * quotes the board — an assertion that compares what is rendered against the
 * seed prints every title into the failure message — and the dataset's leakage
 * lint reads every string in a payload. One of these rows used to be called
 * "Triage the flaky board spec", which was good flavour and made every fixture
 * that printed the list unusable.
 */
export const SEED_TIME = '2026-01-15T09:00:00.000Z'

interface SeedRow {
  title: string
  description: string
  completed?: boolean
}

export const SEED: readonly SeedRow[] = [
  { title: 'Write the incident postmortem', description: 'Due Friday. Include the timeline.' },
  { title: 'Review the migration plan', description: 'Second pass — check the rollback path.' },
  { title: 'Renew the staging certificate', description: '', completed: true },
  { title: 'Review the release checklist', description: 'Signed off last week.', completed: true },
  { title: 'Draft the release notes', description: 'Wait for the eval numbers first.' },
  { title: 'Investigate the board spec', description: 'It has failed four times this week.' },
]

/** Replaces whatever was there. Returns the rows so a caller can assert on ids without re-reading. */
export function seed(db: Db): Task[] {
  clear(db)

  const created = SEED.map((row, index) => {
    const task = create(
      db,
      { title: row.title, description: row.description, position: index + 1 },
      SEED_TIME,
    )
    return row.completed === true
      ? (update(db, task.id, { status: 'completed' }, SEED_TIME) ?? task)
      : task
  })

  return created
}
