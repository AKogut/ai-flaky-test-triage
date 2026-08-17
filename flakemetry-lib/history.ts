import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  HISTORY_SCHEMA_VERSION,
  HistoryUnreadableError,
  emptyHistory,
  parseHistory,
  type History,
  type HistoryEntry,
  type TestHistory,
  type TestRun,
} from '@sentra/contracts'

/**
 * Read, merge and write `.flakemetry/history.json`.
 *
 * Three behaviours, and each of them is here because of a specific way the naive
 * version fails in CI rather than because it seemed tidy.
 *
 * **The write is atomic.** The job that writes this file can be cancelled at any
 * moment — a pushed commit supersedes a running build, and the runner is killed
 * mid-syscall. A plain `writeFileSync` interrupted there leaves a truncated JSON
 * file, and the *next* run crashes on parse. A cancelled build would take the
 * pipeline down with it, one run later, with nothing in either log connecting
 * the two. Write to a temp file in the same directory, then rename: the swap is
 * one directory operation, so a reader sees either the whole old file or the
 * whole new one.
 *
 * **The merge is per-test and additive.** A test absent from a run is left
 * alone, never recorded as anything. Absence has too many innocent causes —
 * sharding, a `--grep` filter, a suite that failed to start — and recording it
 * as a status would inject invented alternations into precisely the signal this
 * file exists to carry.
 *
 * **The retained window is capped.** Without one the file grows linearly forever
 * and eventually exceeds the cache size limit, at which point history stops
 * persisting and nothing says so: the pipeline keeps running, every test starts
 * reading as new, and the `determinism` axis quietly loses its evidence.
 */

/** Where the history lives, relative to the repository root. Set by ADR-0004, not by preference. */
export const HISTORY_FILE = '.flakemetry/history.json'

/**
 * Runs retained per test.
 *
 * Fifty is roughly a month of history for a repository that runs CI on every
 * merge, and it is bounded on both sides for a reason. It has to be several
 * times the scoring half-life, or the cap — not the decay — is what ends up
 * shaping the score. And it has to stay small enough that the file is not the
 * thing that breaks the cache: five hundred tests at fifty entries is about two
 * megabytes of JSON, which is inside the budget with room to spare and parses in
 * milliseconds.
 *
 * Configurable per call, because a suite that runs on every push accumulates a
 * month of runs in a week.
 */
export const DEFAULT_RUN_CAP = 50

export interface MergeOptions {
  /** Entries retained per test, oldest evicted first. Defaults to {@link DEFAULT_RUN_CAP}. */
  cap?: number
}

/**
 * The temp file a write goes through before it is renamed into place.
 *
 * The pid is in the name so two writers cannot land on the same temp file. They
 * are not supposed to exist — ADR-0004 confines writes to `main` — but the
 * failure if they ever do is the one the atomic write was introduced to
 * prevent: two processes interleaving into one temp file and renaming a
 * scrambled result over a good one.
 *
 * Exported so a test can look for one rather than hard-coding the convention in
 * two places.
 */
export function tempPathFor(file: string): string {
  return `${file}.${String(process.pid)}.tmp`
}

/**
 * Read the history at `file`.
 *
 * A missing file is an empty history, not an error: a first run on a new branch
 * and a seven-day cache eviction both produce one, and both are ordinary.
 *
 * A file that exists and cannot be understood is an error, and the difference
 * matters. Quietly treating a corrupt file as empty would hide the one symptom
 * that says something is writing the file wrongly, and would do it in the exact
 * situation where the output still looks completely normal.
 */
export function readHistory(file: string = HISTORY_FILE): History {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyHistory()
    throw error
  }

  /**
   * A zero-byte file is not an empty history — it is the signature of the
   * truncated write this module writes atomically to avoid. Reading it as
   * "nothing yet" would erase the only evidence that something is bypassing
   * that.
   */
  if (text.trim() === '') {
    throw new HistoryUnreadableError(
      file,
      'unparsable',
      'the file is empty, which usually means a write was interrupted',
    )
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new HistoryUnreadableError(file, 'unparsable', (error as Error).message)
  }

  return parseHistory(value, file)
}

/**
 * Merge a run into a history. Pure — no clock, no filesystem.
 *
 * The rule, in full:
 *
 * 1. Every result in the run becomes one entry against its `testId`.
 * 2. An entry already carrying this `runId` is **replaced**, not duplicated, so
 *    re-analysing the same report twice leaves the same history.
 * 3. Tests in the history and not in the run are untouched.
 * 4. `firstSeenAt` only ever moves earlier.
 * 5. Entries are ordered by run start time, not by arrival, so a job for an
 *    older commit finishing late cannot make its result the most recent one.
 *    `consecutiveFailures` reads the tail of that order; getting it wrong would
 *    turn a fixed test into a failing streak.
 * 6. The oldest entries beyond `cap` are dropped.
 */
export function mergeRun(history: History, run: TestRun, options: MergeOptions = {}): History {
  const cap = options.cap ?? DEFAULT_RUN_CAP
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(
      `run cap must be a positive integer, received ${String(cap)}. A cap of zero would ` +
        'discard every entry on write and report a working pipeline with no history at all.',
    )
  }

  const tests: Record<string, TestHistory> = { ...history.tests }

  for (const result of run.results) {
    const previous = tests[result.testId]
    const entry: HistoryEntry = {
      runId: run.runId,
      at: run.startedAt,
      status: result.status,
      flakyWithinRun: result.flakyWithinRun,
    }
    const kept = (previous?.entries ?? []).filter((e) => e.runId !== run.runId)

    tests[result.testId] = {
      firstSeenAt: earlier(previous?.firstSeenAt, run.startedAt),
      entries: ordered([...kept, entry]).slice(-cap),
    }
  }

  return { schemaVersion: HISTORY_SCHEMA_VERSION, tests }
}

/**
 * Write a history to `file`, atomically, creating the directory if needed.
 *
 * A failed write removes its own temp file before rethrowing. The leftover would
 * otherwise be picked up by `actions/cache`, which archives the directory rather
 * than the file, and restored on the next run — where it accumulates, one per
 * distinct pid, until somebody notices the cache growing.
 */
export function writeHistory(history: History, file: string = HISTORY_FILE): void {
  mkdirSync(dirname(file), { recursive: true })

  const temp = tempPathFor(file)
  try {
    writeFileSync(temp, `${JSON.stringify(history, null, 2)}\n`)
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best-effort. The write has already failed; reporting a problem tidying
      // up instead of the reason it failed would hide the diagnosis behind the
      // cleanup, which is how a legible error becomes a confusing one.
    }
    throw error
  }
}

/** Oldest first. `runId` breaks ties so two runs with one start time still order the same way twice. */
function ordered(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.runId.localeCompare(b.runId),
  )
}

/**
 * Compared as instants rather than as strings.
 *
 * The schema pins these to UTC, so lexicographic order is *nearly* right — and
 * wrong exactly when two writers disagree about trailing milliseconds, which is
 * the kind of difference nobody looks for.
 */
function earlier(previous: string | undefined, next: string): string {
  if (previous === undefined) return next
  return Date.parse(previous) <= Date.parse(next) ? previous : next
}
