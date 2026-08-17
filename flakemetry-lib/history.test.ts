import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HISTORY_SCHEMA_VERSION,
  HistoryUnreadableError,
  emptyHistory,
  type History,
  type TestResult,
  type TestRun,
} from '@sentra/contracts'
import { DEFAULT_RUN_CAP, mergeRun, readHistory, tempPathFor, writeHistory } from './history.js'

/**
 * Against a real directory, not a mocked filesystem.
 *
 * The behaviour under test *is* filesystem behaviour — that a rename replaces a
 * file in one step, that a missing path reports `ENOENT`, that a directory is
 * created on the way. A mock would assert that the mock was called, which is a
 * claim about this test file rather than about the disk any of this runs on.
 * The same lesson `app/server/api.test.ts` learned when `:memory:` turned out to
 * ignore `journal_mode = WAL` and every concurrency assertion in it had been
 * running against a database with no write-ahead log at all.
 */

let workspace = ''
let file = ''

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'flakemetry-history-'))
  file = join(workspace, '.flakemetry', 'history.json')
})

const result = (over: Partial<TestResult> = {}): TestResult => ({
  testId: 'tests/e2e/board.spec.ts›shows a row',
  title: 'shows a row',
  file: 'tests/e2e/board.spec.ts',
  status: 'passed',
  attempts: 1,
  flakyWithinRun: false,
  durationMs: 12,
  annotations: [],
  ...over,
})

const run = (over: Partial<TestRun> = {}): TestRun => ({
  runId: 'run-1',
  commitSha: 'abc1234',
  branch: 'main',
  startedAt: '2026-08-01T00:00:00.000Z',
  durationMs: 100,
  source: 'playwright',
  results: [result()],
  ...over,
})

/**
 * Run `n`, a day after run `n - 1`.
 *
 * Built by adding to a fixed instant rather than by formatting the number into a
 * date string, which stops working at the thirty-second run — a cap of fifty
 * needs more days than August has, and `2026-08-53` parses as `NaN` and sorts
 * silently wrong.
 */
const day = (n: number): string =>
  new Date(Date.UTC(2026, 7, 1) + (n - 1) * 86_400_000).toISOString()

const statuses = (history: History, testId = 'tests/e2e/board.spec.ts›shows a row'): string =>
  (history.tests[testId]?.entries ?? []).map((e) => e.status.charAt(0).toUpperCase()).join('')

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('reading a history that is not there', () => {
  /** A cache miss after seven idle days, and a first run on a new branch. Both ordinary. */
  it('is an empty history rather than an error', () => {
    expect(readHistory(file)).toEqual(emptyHistory())
  })

  it('does not need the directory to exist either', () => {
    expect(readHistory(join(workspace, 'nowhere', 'at', 'all.json'))).toEqual(emptyHistory())
  })

  /** Creating it on read would make a read-only PR job write into the workspace. */
  it('creates nothing on the way', () => {
    readHistory(file)
    expect(readdirSync(workspace)).toEqual([])
  })
})

describe('reading a history that cannot be understood', () => {
  const unreadable = (contents: string): HistoryUnreadableError => {
    mkdirSync(join(workspace, '.flakemetry'), { recursive: true })
    writeFileSync(file, contents)
    try {
      readHistory(file)
    } catch (error) {
      return error as HistoryUnreadableError
    }
    return expect.unreachable(`${contents.slice(0, 20)} must not read as a history`)
  }

  it('names the file and offers the command that recovers', () => {
    const error = unreadable('{"schemaVersion": 1, "tests"')
    expect(error).toBeInstanceOf(HistoryUnreadableError)
    expect(error.message).toContain(file)
    expect(error.message).toContain(`rm ${file}`)
  })

  it('reports broken JSON as unparsable', () => {
    expect(unreadable('{"schemaVersion": 1, "tests"').reason).toBe('unparsable')
  })

  /**
   * Zero bytes is the signature of the interrupted write this module renames to
   * avoid. Reading it as "nothing yet" would erase the only evidence that
   * something is writing this file the naive way.
   */
  it('refuses an empty file instead of treating it as a fresh start', () => {
    const error = unreadable('')
    expect(error.reason).toBe('unparsable')
    expect(error.message).toContain('interrupted')
  })

  it('reports a valid JSON document of the wrong shape as invalid', () => {
    expect(unreadable('{"schemaVersion": 1, "tests": []}').reason).toBe('invalid')
  })

  it('reports a version it does not read as a version problem', () => {
    expect(unreadable('{"schemaVersion": 99, "tests": {}}').reason).toBe('version')
  })

  /** Anything that is not "this file is wrong" belongs to the caller, unwrapped. */
  it('lets a permission error through as itself', () => {
    expect(() => readHistory(workspace)).toThrow(/EISDIR|EPERM|EACCES/)
  })
})

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

describe('merging a run', () => {
  it('records a test that has never been seen before', () => {
    const merged = mergeRun(emptyHistory(), run())
    expect(statuses(merged)).toBe('P')
    expect(merged.tests['tests/e2e/board.spec.ts›shows a row']?.firstSeenAt).toBe(day(1))
    expect(merged.schemaVersion).toBe(HISTORY_SCHEMA_VERSION)
  })

  it('appends to a test that has', () => {
    const first = mergeRun(emptyHistory(), run())
    const second = mergeRun(
      first,
      run({ runId: 'run-2', startedAt: day(2), results: [result({ status: 'failed' })] }),
    )
    expect(statuses(second)).toBe('PF')
  })

  /**
   * Absence has too many innocent causes — a shard, a `--grep`, a suite that
   * failed to start — and every one of them would inject an invented
   * alternation into the signal this file exists to carry.
   */
  it('leaves a test the run did not mention completely alone', () => {
    const first = mergeRun(emptyHistory(), run())
    const second = mergeRun(
      first,
      run({ runId: 'run-2', startedAt: day(2), results: [result({ testId: 'other' })] }),
    )
    expect(statuses(second)).toBe('P')
    expect(second.tests['tests/e2e/board.spec.ts›shows a row']?.entries).toHaveLength(1)
    expect(statuses(second, 'other')).toBe('P')
  })

  /**
   * GitHub keeps `run_id` stable across "re-run all jobs" — only the attempt
   * number changes. Appending would write the same outcome twice and double a
   * test's apparent stability every time somebody retried a build.
   */
  it('replaces the entry for a run it has already merged rather than adding a second', () => {
    const once = mergeRun(emptyHistory(), run())
    const again = mergeRun(once, run({ results: [result({ status: 'failed' })] }))
    expect(statuses(again)).toBe('F')
  })

  it('is unchanged by merging the same run twice', () => {
    const once = mergeRun(emptyHistory(), run())
    expect(mergeRun(once, run())).toEqual(once)
  })

  it('counts a run once however many times it is merged', () => {
    let history = mergeRun(emptyHistory(), run())
    expect(history.tests['tests/e2e/board.spec.ts›shows a row']?.totalRuns).toBe(1)
    history = mergeRun(history, run({ results: [result({ status: 'failed' })] }))
    expect(history.tests['tests/e2e/board.spec.ts›shows a row']?.totalRuns).toBe(1)
    history = mergeRun(history, run({ runId: 'run-2', startedAt: day(2) }))
    expect(history.tests['tests/e2e/board.spec.ts›shows a row']?.totalRuns).toBe(2)
  })

  it('counts per test, not per run, so a test the run skipped does not advance', () => {
    let history = mergeRun(
      emptyHistory(),
      run({ results: [result({ testId: 'a' }), result({ testId: 'b' })] }),
    )
    history = mergeRun(
      history,
      run({ runId: 'run-2', startedAt: day(2), results: [result({ testId: 'a' })] }),
    )
    expect(history.tests.a?.totalRuns).toBe(2)
    expect(history.tests.b?.totalRuns).toBe(1)
  })

  it('does not modify the history it was given', () => {
    const before = mergeRun(emptyHistory(), run())
    const snapshot = structuredClone(before)
    mergeRun(before, run({ runId: 'run-2', startedAt: day(2) }))
    expect(before).toEqual(snapshot)
  })

  /**
   * A job for an older commit can finish after a newer one. Appending in arrival
   * order would put a stale result last, and `consecutiveFailures` reads the
   * tail — a fixed test would report an unbroken failing streak.
   */
  it('orders by when the run started, not by when it was merged', () => {
    const newest = mergeRun(
      emptyHistory(),
      run({ runId: 'run-9', startedAt: day(9), results: [result({ status: 'failed' })] }),
    )
    const late = mergeRun(newest, run({ runId: 'run-2', startedAt: day(2) }))
    expect(statuses(late)).toBe('PF')
  })

  it('orders two runs that started at the same instant the same way twice', () => {
    const a = mergeRun(emptyHistory(), run({ runId: 'b', results: [result({ status: 'failed' })] }))
    const both = mergeRun(a, run({ runId: 'a' }))
    expect(statuses(both)).toBe('PF')
  })

  it('only ever moves firstSeenAt earlier', () => {
    const first = mergeRun(emptyHistory(), run({ runId: 'run-5', startedAt: day(5) }))
    const backfilled = mergeRun(first, run({ runId: 'run-2', startedAt: day(2) }))
    expect(backfilled.tests['tests/e2e/board.spec.ts›shows a row']?.firstSeenAt).toBe(day(2))

    const forward = mergeRun(backfilled, run({ runId: 'run-8', startedAt: day(8) }))
    expect(forward.tests['tests/e2e/board.spec.ts›shows a row']?.firstSeenAt).toBe(day(2))
  })

  /**
   * A test that fails on attempt 1 and passes on attempt 2 is recorded green.
   * Drop this flag and a test that does it every single run reads back as
   * `PPPPPP` — the most reliably flaky test in the suite, scored as the most
   * stable one.
   */
  it('keeps the within-run retry evidence that the status cannot express', () => {
    const merged = mergeRun(
      emptyHistory(),
      run({ results: [result({ attempts: 2, flakyWithinRun: true })] }),
    )
    expect(merged.tests['tests/e2e/board.spec.ts›shows a row']?.entries[0]).toMatchObject({
      status: 'passed',
      flakyWithinRun: true,
    })
  })
})

describe('the retained window', () => {
  /** Merges `count` single-result runs, one per day, so the oldest is day 1. */
  const overRuns = (count: number, cap?: number): History => {
    let history = emptyHistory()
    for (let i = 1; i <= count; i += 1) {
      history = mergeRun(
        history,
        run({
          runId: `run-${String(i)}`,
          startedAt: day(i),
          results: [result({ status: i === 1 ? 'failed' : 'passed' })],
        }),
        cap === undefined ? {} : { cap },
      )
    }
    return history
  }

  it('keeps everything while the history is under the cap', () => {
    expect(statuses(overRuns(4, 5))).toBe('FPPP')
  })

  it('keeps everything at exactly the cap', () => {
    expect(statuses(overRuns(5, 5))).toBe('FPPPP')
  })

  it('evicts oldest first once over it', () => {
    expect(statuses(overRuns(7, 5))).toBe('PPPPP')
  })

  it('never retains more than the cap however many runs arrive', () => {
    expect(statuses(overRuns(30, 5))).toHaveLength(5)
  })

  /**
   * The reason `firstSeenAt` is stored rather than read off `entries[0]`. Once
   * the cap starts evicting, the oldest retained entry is not the first one, and
   * a test first seen in March would begin reporting itself as new.
   */
  it('remembers when the test was first seen after its first run has been evicted', () => {
    const history = overRuns(20, 5)
    const record = history.tests['tests/e2e/board.spec.ts›shows a row']
    expect(record?.firstSeenAt).toBe(day(1))
    expect(record?.entries[0]?.at).not.toBe(day(1))
  })

  /**
   * The same eviction problem as `firstSeenAt`, one step further out. Count the
   * entries instead and every test that has run more than the cap reports the
   * cap, for ever — a year of history and a fortnight of it become the same
   * number to anyone weighing how much is behind a score.
   */
  it('keeps counting runs after it has stopped keeping them', () => {
    const history = overRuns(20, 5)
    const record = history.tests['tests/e2e/board.spec.ts›shows a row']
    expect(record?.totalRuns).toBe(20)
    expect(record?.entries).toHaveLength(5)
  })

  it('defaults to a documented cap rather than to unbounded growth', () => {
    expect(DEFAULT_RUN_CAP).toBe(50)
    expect(statuses(overRuns(DEFAULT_RUN_CAP + 3))).toHaveLength(DEFAULT_RUN_CAP)
  })

  /** A cap of zero would report a working pipeline that stores nothing at all. */
  it('refuses a cap that could not retain anything', () => {
    for (const cap of [0, -1, 1.5, Number.NaN]) {
      expect(() => mergeRun(emptyHistory(), run(), { cap }), String(cap)).toThrow(RangeError)
    }
  })

  it('allows a cap of one, which is a choice rather than a mistake', () => {
    expect(statuses(overRuns(4, 1))).toBe('P')
  })
})

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

describe('writing a history', () => {
  const merged = (): History => mergeRun(emptyHistory(), run())

  it('round-trips through the reader', () => {
    writeHistory(merged(), file)
    expect(readHistory(file)).toEqual(merged())
  })

  it('creates the directory it was pointed at', () => {
    writeHistory(merged(), join(workspace, 'a', 'b', 'history.json'))
    expect(readHistory(join(workspace, 'a', 'b', 'history.json'))).toEqual(merged())
  })

  it('leaves nothing behind but the file', () => {
    writeHistory(merged(), file)
    expect(readdirSync(join(workspace, '.flakemetry'))).toEqual(['history.json'])
  })

  /**
   * What "atomic" means, checked rather than asserted in a comment.
   *
   * A rename replaces the directory entry, so the file at that path is a
   * *different* inode afterwards and any reader holding the old one still sees a
   * complete document. Writing in place reuses the inode and passes through a
   * truncated state that a concurrent reader can observe — which is the failure
   * this module exists to prevent, and the one a passing round-trip test would
   * not notice.
   */
  it('replaces the file rather than truncating it in place', () => {
    writeHistory(merged(), file)
    const before = statSync(file).ino
    expect(
      before,
      'this platform reports no inode, so the assertion below proves nothing',
    ).toBeGreaterThan(0)

    writeHistory(mergeRun(merged(), run({ runId: 'run-2', startedAt: day(2) })), file)
    expect(statSync(file).ino).not.toBe(before)
  })

  /** The property the rename buys: a write that cannot finish costs nothing. */
  it('leaves the last good history in place when the write cannot complete', () => {
    writeHistory(merged(), file)

    // A directory where the temp file goes, so the write fails part-way through
    // exactly as it does when the runner is killed mid-job.
    mkdirSync(tempPathFor(file))
    expect(() => writeHistory(emptyHistory(), file)).toThrow()

    expect(readHistory(file)).toEqual(merged())
  })

  /**
   * The cache archives the directory, not the file, so a temp file left behind
   * is restored on the next run and accumulates one per distinct pid until
   * somebody notices the cache growing.
   *
   * Blocking the *target* rather than the temp path is what makes this
   * observable: the temp file gets written, the rename onto a directory fails,
   * and the cleanup has something real to remove.
   */
  it('removes its temp file when the rename fails', () => {
    const blocked = join(workspace, 'blocked.json')
    mkdirSync(blocked)

    expect(() => writeHistory(merged(), blocked)).toThrow()
    expect(readdirSync(workspace)).toEqual(['blocked.json'])
  })

  /** A leftover from a job that died between writing and renaming is not history. */
  it('ignores a temp file that was never renamed', () => {
    writeHistory(merged(), file)
    writeFileSync(tempPathFor(file), '{"schemaVersion": 1, "tests"')
    expect(readHistory(file)).toEqual(merged())
  })

  /** Nobody reviews this file, but somebody eventually reads it to find out why a score is wrong. */
  it('writes it indented, so it can be read when the pipeline is the suspect', () => {
    writeHistory(merged(), file)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('\n  "tests"')
    expect(text.endsWith('\n')).toBe(true)
  })
})
