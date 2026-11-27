import { once } from 'node:events'
import { rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { Page } from '@playwright/test'
import { createApp, open as openDatabase, seed, type Db } from '@sentra/taskflow-server'
import { action, add, open, row, titles } from './board.js'
import { expect, test as base } from './fixtures.js'
import { BASE_PORT, BUNDLE, databaseFor, WORKERS } from './harness.js'

/**
 * # The one that cannot get a port. `environment` + `intermittent`.
 *
 * Two tests that each start a TaskFlow of their own, on the same fixed port,
 * in a file that lets them run at the same time. On every run they start
 * together, one of them gets the port, and the other fails before it has
 * asserted anything. Which one fails changes from run to run, so each of them
 * fails some of the time and passes the rest.
 *
 * ## Why these tests start their own server
 *
 * They check that what a user did survives a restart, and the per-worker fleet
 * in `tests/e2e/servers.ts` cannot be restarted from a spec — Playwright's
 * `webServer` starts it once, before the run. So each test starts a TaskFlow of
 * its own, on a database file of its own, and restarts it halfway through.
 *
 * The port is the one after the fleet's:
 *
 * ```ts
 * const PORT = BASE_PORT + 2 * WORKERS
 * ```
 *
 * which is free — the fleet takes `BASE_PORT` up to `BASE_PORT + 2 * WORKERS - 1`
 * — and the same number in every worker. `harness.ts` gets away with fixed
 * ports because each worker's is derived from that worker's index. This one is
 * not.
 *
 * ## The mechanism
 *
 * ```ts
 * test.describe.configure({ mode: 'parallel' })
 * ```
 *
 * `playwright.config.ts` makes files the unit of parallelism, so two tests in
 * one file never overlap. This file opts out, one visible line, because its two
 * tests are independent of each other — and that turns them into two separately
 * scheduled jobs. The file sorts first in `tests/e2e/`, so they are the first
 * two jobs of the run, and the two workers start one each at the same moment.
 * Both servers ask for the same port. The operating system gives it to
 * whichever asked first, and the other gets
 *
 * ```
 * listen EADDRINUSE: address already in use 127.0.0.1:4314
 * ```
 *
 * in its fixture, before the test body runs. Which test asks first is decided
 * by which worker process finished starting up first, and nothing in the suite
 * controls that.
 *
 * ## Why `environment`, and why not `test_code`
 *
 * The tempting alternative is `test_code`, and it has a real argument: the port
 * is chosen in this file, and so is the fix. But rule 1 in `docs/taxonomy.md`
 * comes first, and it fires: the run never reached an assertion, because a port
 * would not bind, and the rule applies "regardless of anything else". The
 * rubric files a port collision under infra noise, and
 * `port-still-held-by-the-previous-job` in the golden dataset makes the same
 * call about the same kind of line. The failure says nothing about whether the
 * test is a good detector, because it never got to detect anything.
 *
 * ## Why `intermittent`
 *
 * Because each test, taken alone, fails on some runs and passes on others, and
 * rerunning is exactly what makes a failing one pass — the quadrant's own
 * advice. The tests are correct, the application is correct, and the loser is
 * whichever lost a race for a resource they share.
 *
 * Measured over nine full runs of the suite: exactly one of the two failed on
 * every run — the first test six times, the second three.
 *
 * ## The correct fix, deliberately not applied
 *
 * Derive the port from the worker, as the fleet does, or listen on port 0 and
 * read back the one the system chose. Either makes the collision impossible and
 * deletes the golden-dataset fixture this file feeds.
 */

const PORT = BASE_PORT + 2 * WORKERS

interface Running {
  server: Server
  db: Db
}

interface OwnTaskFlow {
  origin: string
  restart: () => Promise<void>
}

async function start(database: string): Promise<Running> {
  const db = openDatabase(database)
  const server = createApp({ db, client: BUNDLE }).listen(PORT, '127.0.0.1')
  try {
    await once(server, 'listening')
  } catch (failure) {
    db.close()
    throw failure
  }
  return { server, db }
}

async function stop({ server, db }: Running): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
}

const test = base.extend<{ own: OwnTaskFlow }>({
  // eslint-disable-next-line no-empty-pattern
  own: async ({}, use, testInfo) => {
    const database = databaseFor(testInfo.parallelIndex).replace(/\.db$/, '-restart.db')
    rmSync(database, { force: true })

    let running = await start(database)
    seed(running.db)

    await use({
      origin: `http://127.0.0.1:${String(PORT)}`,
      restart: async () => {
        await stop(running)
        running = await start(database)
      },
    })

    await stop(running)
  },

  baseURL: async ({ own }, use) => {
    await use(own.origin)
  },
})

test.describe.configure({ mode: 'parallel' })

const ADDED = 'Book the retrospective room'
const ACTIVE = 'Draft the release notes'

const completion = (page: Page): Promise<unknown> =>
  page.waitForResponse((response) => response.url().endsWith('/complete'))

test('keeps an added task after the server restarts', async ({ page, own }) => {
  await open(page)
  await add(page, ADDED)
  await expect(titles(page).last()).toHaveText(ADDED)

  await own.restart()

  await open(page)
  await expect(titles(page).last()).toHaveText(ADDED)
})

test('keeps a completed task completed after the server restarts', async ({ page, own }) => {
  await open(page)
  await Promise.all([completion(page), action(page, ACTIVE, 'Complete').click()])
  await expect(row(page, ACTIVE).getByTestId('task-status')).toHaveText('Done')

  await own.restart()

  await open(page)
  await expect(row(page, ACTIVE).getByTestId('task-status')).toHaveText('Done')
})
