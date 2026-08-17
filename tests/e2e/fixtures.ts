import { test as base, expect } from '@playwright/test'
import { list, open, seed, type Db } from '@sentra/taskflow-server'
import { databaseFor, originFor } from './harness.js'

/**
 * The fixtures every spec builds on: a TaskFlow of its own, and a clean list.
 *
 * ## Isolation, and the one way out of it
 *
 * Each Playwright worker talks to its own server and its own SQLite file, and
 * every test starts from the deterministic seed. That is what stops ordering
 * from leaking *by accident* — a spec that leaves a task behind cannot reach the
 * next spec, so a failure is about the test that failed.
 *
 * #54 needs the opposite, deliberately, and gets it by asking:
 *
 * ```ts
 * test.use({ resetDatabase: false })
 * ```
 *
 * Opting out is one visible line at the top of the file. The distinction the
 * milestone rests on is between a suite where cross-test leakage is impossible
 * unless requested and a suite where it is merely unlikely; the second kind
 * produces intermittent failures that are nobody's fault and teach the
 * classifier nothing.
 *
 * ## Why the reset writes to the database rather than calling the API
 *
 * Deleting through HTTP would take one request per task and would race anything
 * the previous test left in flight. Writing the file directly is one statement,
 * and the server sees it because both processes share the file through WAL —
 * which is the journal mode `open()` sets and the unit suite now asserts.
 */

export interface TaskFlow {
  /** `parallelIndex`, not `workerIndex`: stable across a worker restart, so the port is too. */
  worker: number
  origin: string
  database: string
}

interface Options {
  /** False leaves whatever the previous test left. Deliberate, and only for #54. */
  resetDatabase: boolean
}

interface Fixtures {
  /** Runs before every test. Nothing depends on it by name; `auto` is what makes it run. */
  seeded: void
}

interface WorkerFixtures {
  taskflow: TaskFlow
  /** One handle per worker. Opening one per test would be ~200 opens for no gain. */
  db: Db
}

export const test = base.extend<Options & Fixtures, WorkerFixtures>({
  resetDatabase: [true, { option: true }],

  taskflow: [
    // Playwright reads the destructured names to work out which fixtures this
    // one depends on, so the parameter has to be an object pattern even when it
    // is empty. A named parameter throws at collection time.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const worker = workerInfo.parallelIndex
      await use({ worker, origin: originFor(worker), database: databaseFor(worker) })
    },
    { scope: 'worker' },
  ],

  db: [
    async ({ taskflow }, use) => {
      const db = open(taskflow.database)
      await use(db)
      db.close()
    },
    { scope: 'worker' },
  ],

  /**
   * `baseURL` is a built-in option, overridden here so `page.goto('/')` reaches
   * this worker's server. Setting it in the config instead would send every
   * worker to the same one, and the isolation above would be decoration.
   */
  baseURL: async ({ taskflow }, use) => {
    await use(taskflow.origin)
  },

  seeded: [
    async ({ db, resetDatabase }, use) => {
      if (resetDatabase) seed(db)
      await use()
    },
    { auto: true },
  ],
})

/**
 * `list` re-exported as `stored`, for the assertions that are about state rather
 * than pixels. Reading the rows through the server's own query rather than a
 * second `SELECT` here keeps one definition of what "the order" means — the
 * position-then-id tie-break is the subject of a golden-dataset fixture, and two
 * implementations of it would eventually disagree.
 */
export { expect, list as stored }
