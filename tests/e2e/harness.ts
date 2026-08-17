import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Where the end-to-end run's moving parts live, in one file.
 *
 * `playwright.config.ts`, the server launcher and the test fixtures all need the
 * same three facts — how many workers, which ports, which database belongs to
 * which worker — and they run in three different processes. A constant copied
 * into three files drifts, and the symptom of that drift is a worker talking to
 * another worker's database: every spec in the suite goes intermittently red at
 * once, for a reason none of them mention.
 */

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The Vite bundle. `npm run build` writes it; `scripts/e2e.ts` rebuilds it when it is stale. */
export const BUNDLE = join(REPO_ROOT, 'app/client/dist-bundle')

/**
 * Two, on every machine, on purpose.
 *
 * The obvious setting is one worker per core, which on a 28-core laptop and a
 * 2-core CI runner means the suite runs in two materially different shapes — and
 * the difference is exactly the variable this milestone is trying to hold still.
 * #54's cross-test leak needs more than one worker to be intermittent rather than
 * certain; nothing here needs fourteen.
 *
 * `SENTRA_E2E_WORKERS` raises it for an investigation. The launcher reads the
 * same value, so a run with more workers gets more servers rather than several
 * workers quietly sharing one.
 */
export const WORKERS = positive(process.env.SENTRA_E2E_WORKERS, 2)

/**
 * Worker *n* gets `BASE_PORT + n`.
 *
 * Deliberately not port 0. The launcher and the Playwright workers are separate
 * processes, so a port the operating system picked would have to be published
 * somewhere for the workers to find it — a file, a handshake, one more thing to
 * go wrong. A fixed base is one line and `SENTRA_E2E_PORT` moves it when
 * something else is already listening.
 */
export const BASE_PORT = positive(process.env.SENTRA_E2E_PORT, 4310)

export const portFor = (worker: number): number => BASE_PORT + worker

export const originFor = (worker: number): string => `http://127.0.0.1:${String(portFor(worker))}`

/**
 * One SQLite file per worker, under a gitignored directory.
 *
 * The path is derived rather than communicated, because the process that resets
 * a database between tests is not the process that opened it. The Playwright
 * worker writes the file directly and the server sees the new rows through WAL,
 * which is why `open()` sets that journal mode and why the unit suite now
 * asserts it does.
 */
export const databaseFor = (worker: number): string =>
  join(REPO_ROOT, '.playwright', 'db', `worker-${String(worker)}.db`)

/** A malformed override is a typo, and a typo that silently becomes 0 workers is worse. */
function positive(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Expected a positive whole number, got ${JSON.stringify(raw)}`)
  }
  return value
}
