import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chaosFrom, serve } from '@sentra/taskflow-server'
import {
  BUNDLE,
  chaosDatabaseFor,
  chaosPortFor,
  CHAOS_SEED,
  databaseFor,
  portFor,
  WORKERS,
} from './harness.js'

/**
 * One TaskFlow per Playwright worker, started by `webServer` before the run.
 *
 * ## Why one per worker rather than one for everyone
 *
 * Because the alternative is a suite that cannot be isolated. TaskFlow's state is
 * a list, its specs assert on the order of that list, and a single instance
 * shared by parallel workers means every spec is at the mercy of every other one.
 * The obvious fix — `workers: 1` — buys isolation by deleting the parallelism,
 * and #54 needs a run where two spec files can land in the same worker or not:
 * that is where its intermittency comes from.
 *
 * ## Why one process holding all of them
 *
 * `webServer` starts commands, not fleets, and Playwright's per-worker fixtures
 * run after it. Starting the servers here means Playwright still owns their
 * lifecycle — one health check before the run, one kill after it, and
 * `reuseExistingServer` locally — while each worker still gets its own database.
 * Each instance is an `express` app and a SQLite handle; N of them in one process
 * costs a few megabytes and no supervision code.
 *
 * ## Why they serve the client too
 *
 * Same origin, so there is no proxy and no CORS. In development Vite serves the
 * page and forwards `/api`; here the bundle is static and the API is already
 * listening, so the second process would exist only to forward requests. One
 * fewer hop is one fewer thing to rule out when a spec goes intermittently red.
 */

if (!existsSync(join(BUNDLE, 'index.html'))) {
  console.error(
    [
      '',
      `  No client bundle at ${BUNDLE}.`,
      '',
      '  The end-to-end suite serves the built client, not the dev server. Build it:',
      '',
      '      npm run build',
      '',
      '  `npm run test:e2e` does this for you; this message means the servers were',
      '  started some other way.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

/**
 * Deleted, not reused.
 *
 * A database left over from an earlier run would be reseeded before the first
 * test anyway — but not before the *first page load*, and a run that begins by
 * rendering yesterday's tasks is a confusing way to start debugging.
 */
const directory = join(databaseFor(0), '..')
rmSync(directory, { recursive: true, force: true })
mkdirSync(directory, { recursive: true })

/**
 * One seed for this run, drawn here and printed.
 *
 * The launcher is the only process allowed to invent it: the config and the test
 * workers import the same module, and a random default would give each of them a
 * different answer to the same question. Printed because a flaky failure nobody
 * can reproduce is a flaky failure nobody can debug — this line is what turns
 * one into the other.
 */
const seed = CHAOS_SEED ?? String(randomInt(0, 2 ** 31))
console.log(`  chaos seed ${seed} — reproduce this run with SENTRA_E2E_CHAOS=${seed}`)

const start = (worker: number, chaotic: boolean): ReturnType<typeof serve> =>
  serve({
    port: chaotic ? chaosPortFor(worker) : portFor(worker),
    database: chaotic ? chaosDatabaseFor(worker) : databaseFor(worker),
    reseed: true,
    client: BUNDLE,
    ...(chaotic && { chaos: chaosFrom({ SENTRA_CHAOS: seed }) }),
    log: (message) => {
      console.log(`  [worker ${String(worker)}${chaotic ? ' chaos' : ''}] ${message.trim()}`)
    },
  })

/**
 * Two per worker: one calm, one with seeded latency injection.
 *
 * Only `reorder-quick-succession.spec.ts` uses the chaotic one. Running the whole suite
 * under injected latency would make every spec slower and every failure
 * ambiguous — and a control group that is also being perturbed is not a control
 * group.
 */
const running = Array.from({ length: WORKERS }, (_unused, worker) => [
  start(worker, false),
  start(worker, true),
]).flat()

console.log(`  ${String(running.length)} TaskFlow instances ready.`)

/**
 * Playwright sends SIGTERM to the whole group when the run ends. Closing
 * explicitly flushes each WAL file, which matters because the next run reads
 * these paths before deleting them.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void Promise.all(running.map((instance) => instance.close())).then(() => {
      process.exit(0)
    })
  })
}
