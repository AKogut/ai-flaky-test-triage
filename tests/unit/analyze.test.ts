import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyHistory, type AnalysedTest, type Analysis, type History } from '@sentra/contracts'
import { mergeRun } from '@sentra/flakemetry'
import {
  duplicateIds,
  localRunId,
  main,
  metadata,
  newlyFlaky,
  parseArgs,
  reporterOf,
  summarise,
} from '../../scripts/analyze.js'

/**
 * `npm run flakemetry:analyze`, the command that turns reports into a document.
 *
 * The behaviour worth pinning is mostly about what it refuses to do: write
 * history it was not asked to write, fail the build because tests failed, or
 * count one set of reports as two runs. All three are the kind of thing that
 * looks fine until it has been running in CI for a fortnight.
 */

const root = new URL('../..', import.meta.url).pathname
const playwrightReport = readFileSync(
  join(root, 'tests/fixtures/reporters/playwright-1.62.1.json'),
  'utf8',
)
const vitestReport = readFileSync(join(root, 'tests/fixtures/reporters/vitest-4.1.10.json'), 'utf8')

interface Run {
  code: number
  written: Record<string, string>
  histories: { history: History; path: string }[]
  output: string
}

const run = (
  argv: string[],
  over: {
    files?: Record<string, string>
    history?: History
    loadHistory?: (path: string) => History
    env?: NodeJS.ProcessEnv
  } = {},
): Run => {
  const files = over.files ?? {
    'results.json': playwrightReport,
    'results-unit.json': vitestReport,
  }
  const written: Record<string, string> = {}
  const histories: { history: History; path: string }[] = []
  const lines: string[] = []

  const code = main(argv, {
    env: over.env ?? { GITHUB_RUN_ID: 'run-1', GITHUB_SHA: 'abc1234', GITHUB_REF_NAME: 'main' },
    root,
    read: (path) => files[path] ?? '',
    exists: (path) => path in files,
    write: (path, contents) => {
      written[path] = contents
    },
    loadHistory: over.loadHistory ?? (() => over.history ?? emptyHistory()),
    saveHistory: (history, path) => histories.push({ history, path }),
    now: () => '2026-08-18T00:00:00.000Z',
    log: (message) => lines.push(message),
  })

  return { code, written, histories, output: lines.join('\n') }
}

const analysisFrom = (result: Run): Analysis =>
  JSON.parse(result.written['analysis.json'] ?? '{}') as Analysis

describe('the arguments', () => {
  it('defaults to both reports, the ADR-0004 history path, and analysis.json', () => {
    expect(parseArgs([])).toMatchObject({
      reports: ['results.json', 'results-unit.json'],
      explicitReports: false,
      history: '.flakemetry/history.json',
      out: 'analysis.json',
      writeHistory: false,
    })
  })

  it('reads every flag it documents', () => {
    expect(
      parseArgs([
        '--report',
        'a.json',
        '--report',
        'b.json',
        '--history',
        'h.json',
        '--out',
        'o.json',
        '--write-history',
        '--cap',
        '20',
        '--half-life',
        '5',
      ]),
    ).toMatchObject({
      reports: ['a.json', 'b.json'],
      explicitReports: true,
      history: 'h.json',
      out: 'o.json',
      writeHistory: true,
      cap: 20,
      halfLife: 5,
    })
  })

  /** `--out --write-history` would otherwise write to a file of that name and skip the update. */
  it('ignores a flag with nothing after it rather than swallowing the next one', () => {
    expect(parseArgs(['--out'])).toMatchObject({ out: 'analysis.json', writeHistory: false })
  })

  it('does not treat --write-history as a flag that takes a value', () => {
    expect(parseArgs(['--write-history', '--out', 'o.json'])).toMatchObject({
      writeHistory: true,
      out: 'o.json',
    })
  })
})

describe('recognising a report', () => {
  it('knows both formats by shape rather than by filename', () => {
    expect(reporterOf(JSON.parse(playwrightReport))).toBe('playwright')
    expect(reporterOf(JSON.parse(vitestReport))).toBe('vitest')
  })

  it('recognises neither in something that is not a report', () => {
    expect(reporterOf({ hello: 'world' })).toBeNull()
    expect(reporterOf(null)).toBeNull()
    expect(reporterOf([])).toBeNull()
    expect(reporterOf('a string')).toBeNull()
  })
})

describe('the identity of a run CI did not number', () => {
  /**
   * `mergeRun` keys idempotency on `runId`. A pid in there meant a second local
   * invocation appended a second entry for every test, doubling the history —
   * exactly the double-counting the run id exists to prevent.
   */
  it('is the same for the same reports', () => {
    expect(localRunId(['a', 'b'])).toBe(localRunId(['a', 'b']))
  })

  it('differs when the reports do', () => {
    expect(localRunId(['a'])).not.toBe(localRunId(['b']))
    expect(localRunId(['a', 'b'])).not.toBe(localRunId(['b', 'a']))
  })

  it('says it is local, so a run id in a report is never mistaken for a CI one', () => {
    expect(localRunId(['a'])).toMatch(/^local-[0-9a-f]{12}$/)
  })

  it('yields to the number CI supplies', () => {
    expect(metadata({ GITHUB_RUN_ID: '12345' }, root, 'local-x').runId).toBe('12345')
    expect(metadata({}, root, 'local-x').runId).toBe('local-x')
  })

  it('falls back to git for the commit and branch, and says unknown rather than guessing', () => {
    const meta = metadata({}, root, 'local-x')
    expect(meta.commitSha).toMatch(/^[0-9a-f]{7,40}$|^unknown$/)
    expect(meta.branch).not.toBe('')
  })
})

describe('test identities used twice', () => {
  const testRun = (ids: string[]) =>
    ({
      runId: 'r',
      commitSha: 'abc1234',
      branch: 'main',
      startedAt: '2026-08-01T00:00:00.000Z',
      durationMs: 1,
      source: 'playwright' as const,
      results: ids.map((testId) => ({
        testId,
        title: testId,
        file: 'f.spec.ts',
        status: 'passed' as const,
        attempts: 1,
        flakyWithinRun: false,
        durationMs: 1,
        annotations: [],
      })),
    }) as const

  /**
   * `deriveTestId` is file plus full title, so two cases with the same name in
   * the same file are one test to everything downstream — they share a row of
   * history and the last one merged decides what it says.
   */
  it('finds them, counted and worst first', () => {
    expect(duplicateIds([testRun(['a', 'b', 'a', 'c', 'a', 'b'])])).toEqual([
      { testId: 'a', count: 3 },
      { testId: 'b', count: 2 },
    ])
  })

  it('counts across reports, because both feed one history', () => {
    expect(duplicateIds([testRun(['a']), testRun(['a'])])).toEqual([{ testId: 'a', count: 2 }])
  })

  it('finds none in a run where every test is itself', () => {
    expect(duplicateIds([testRun(['a', 'b', 'c'])])).toEqual([])
  })
})

describe('what counts as newly flaky', () => {
  const test = (
    statusHistory: string,
    over: Partial<AnalysedTest['result']> = {},
  ): AnalysedTest => ({
    result: {
      testId: 't',
      title: 't',
      file: 'f.spec.ts',
      status: 'failed',
      attempts: 1,
      flakyWithinRun: false,
      durationMs: 1,
      annotations: [],
      ...over,
    },
    signal: {
      testId: 't',
      flakinessScore: 0,
      consecutiveFailures: 0,
      totalRuns: statusHistory.length,
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      lastPassedAt: null,
      statusHistory,
      isNew: false,
    },
  })

  /** Scores are recomputed from the history here, so the fixture cannot disagree with itself. */
  const scored = (
    statusHistory: string,
    over: Partial<AnalysedTest['result']> = {},
  ): AnalysedTest => {
    const entry = test(statusHistory, over)
    return {
      ...entry,
      signal: { ...entry.signal, flakinessScore: statusHistory.includes('F') ? 1 : 0 },
    }
  }

  it('names a test whose history had never alternated before this run', () => {
    expect(newlyFlaky([scored('PPPPF')])).toHaveLength(1)
  })

  /**
   * Not "everything with a non-zero score", which after a fortnight is most of a
   * real suite and tells a reader nothing they can act on.
   */
  it('does not name one that was already alternating', () => {
    expect(newlyFlaky([scored('PFPFP')])).toEqual([])
  })

  it('does not name a test that has only ever failed', () => {
    expect(newlyFlaky([test('FFFF')])).toEqual([])
  })

  /** The alternation happened inside the run, where the sequence cannot show it. */
  it('names a test that passed only on a retry', () => {
    expect(
      newlyFlaky([test('PPPP', { status: 'passed', attempts: 2, flakyWithinRun: true })]),
    ).toHaveLength(1)
  })
})

describe('the command', () => {
  it('writes a schema-valid analysis carrying the version', () => {
    const result = run([])
    expect(result.code).toBe(0)
    const analysis = analysisFrom(result)
    expect(analysis.schemaVersion).toBe(1)
    expect(analysis).toMatchObject({
      runId: 'run-1',
      commitSha: 'abc1234',
      branch: 'main',
      analysedAt: '2026-08-18T00:00:00.000Z',
    })
    expect(analysis.tests.length).toBeGreaterThan(0)
  })

  it('analyses both reports into one document', () => {
    const files = analysisFrom(run([])).tests.map((t) => t.result.file)
    expect(files.some((f) => f.endsWith('.spec.ts'))).toBe(true)
    expect(new Set(files).size).toBeGreaterThan(1)
  })

  it('names which reporter wrote each report it read', () => {
    const { output } = run([])
    expect(output).toContain('results.json (playwright)')
    expect(output).toContain('results-unit.json (vitest)')
  })

  /**
   * ADR-0004 confines writes to `main`, so read-only is the direction for this
   * flag to be forgotten in. A default that persisted would have every
   * pull-request job contribute its own branch's failures to the history that
   * judges the next one.
   */
  it('does not touch the history unless asked', () => {
    const result = run([])
    expect(result.histories).toEqual([])
    expect(result.output).toContain('--write-history')
  })

  it('writes the history when asked, to the path it was given', () => {
    const result = run(['--write-history', '--history', 'h.json'])
    expect(result.histories).toHaveLength(1)
    expect(result.histories[0]?.path).toBe('h.json')
    expect(Object.keys(result.histories[0]?.history.tests ?? {}).length).toBeGreaterThan(0)
  })

  it('reports how much history it wrote, so approaching the cap is noticeable', () => {
    expect(run(['--write-history']).output).toMatch(/wrote .* — \d+ tests, \d+ runs/)
  })

  /**
   * The command describes a run; a run full of failures is the case it exists
   * for. A non-zero exit would stop the pipeline exactly where it should be
   * producing its most useful output.
   */
  it('exits 0 when the suite it is describing failed', () => {
    const result = run([])
    expect(result.code).toBe(0)
    const failed = analysisFrom(result).tests.filter((t) => t.result.status === 'failed')
    expect(failed.length).toBeGreaterThan(0)
  })

  it('prints a summary of what it found', () => {
    expect(run([]).output).toMatch(/\d+ tests, \d+ failing, \d+ newly flaky, \d+ to triage/)
  })

  it('says so when there was no history to read', () => {
    expect(run([]).output).toContain('no history')
  })

  it('reports the depth when there was', () => {
    const history = mergeRun(emptyHistory(), {
      runId: 'older',
      commitSha: 'abc1234',
      branch: 'main',
      startedAt: '2026-07-01T00:00:00.000Z',
      durationMs: 1,
      source: 'playwright',
      results: [
        {
          testId: 'x',
          title: 'x',
          file: 'f.spec.ts',
          status: 'passed',
          attempts: 1,
          flakyWithinRun: false,
          durationMs: 1,
          annotations: [],
        },
      ],
    })
    expect(run([], { history }).output).toContain('1 runs of history')
  })

  it('warns when two tests share one identity, and names them', () => {
    // The Vitest fixture read twice: every identity in it appears exactly twice.
    const { output } = run(['--report', 'a.json', '--report', 'b.json'], {
      files: { 'a.json': vitestReport, 'b.json': vitestReport },
    })
    expect(output).toContain('share one row of history')
    expect(output).toMatch(/x2 {2}\S/)
  })

  /**
   * The end-to-end version of the run-id property. Two invocations over the same
   * reports with no CI number are one run, so the second must leave the history
   * exactly where the first did — which is what `mergeRun`'s idempotency
   * guarantees, and only if the id does not move between them.
   */
  it('counts the same reports as one run however many times it is invoked locally', () => {
    const local = { env: {} }
    const first = run(['--write-history'], local)
    const second = run(['--write-history'], {
      ...local,
      history: first.histories[0]?.history ?? emptyHistory(),
    })

    expect(first.histories[0]?.history).toEqual(second.histories[0]?.history)
    const record = Object.values(second.histories[0]?.history.tests ?? {})[0]
    expect(record?.totalRuns).toBe(1)
    expect(record?.entries).toHaveLength(1)
  })

  it('passes the scoring options through', () => {
    const result = run(['--half-life', '1', '--cap', '3', '--write-history'])
    expect(result.code).toBe(0)
    for (const record of Object.values(result.histories[0]?.history.tests ?? {})) {
      expect(record.entries.length).toBeLessThanOrEqual(3)
    }
  })
})

describe('when it cannot do its job', () => {
  const quiet = <T>(body: () => T): { value: T; errors: string } => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    try {
      return { value: body(), errors: errors.join('\n') }
    } finally {
      spy.mockRestore()
    }
  }

  /** A default that is absent is a suite that did not run in this job. */
  it('skips a default report that is not there', () => {
    const result = run([], { files: { 'results-unit.json': vitestReport } })
    expect(result.code).toBe(0)
    expect(result.output).not.toContain('results.json (playwright)')
  })

  /** A path somebody typed is a mistake worth stopping for. */
  it('fails on a named report that is not there', () => {
    const { value, errors } = quiet(() => run(['--report', 'nope.json']))
    expect(value.code).toBe(1)
    expect(errors).toContain('nope.json does not exist')
  })

  it('fails, and says what it looked for, when no report exists at all', () => {
    const { value, errors } = quiet(() => run([], { files: {} }))
    expect(value.code).toBe(1)
    expect(errors).toContain('results.json')
    expect(errors).toContain('--report')
  })

  it('fails on a report that is not JSON', () => {
    const { value, errors } = quiet(() =>
      run(['--report', 'x.json'], { files: { 'x.json': '{oh no' } }),
    )
    expect(value.code).toBe(1)
    expect(errors).toContain('not valid JSON')
  })

  it('fails on JSON that is not a report either reporter wrote', () => {
    const { value, errors } = quiet(() =>
      run(['--report', 'x.json'], { files: { 'x.json': '{"hello":"world"}' } }),
    )
    expect(value.code).toBe(1)
    expect(errors).toContain('neither a Playwright nor a Vitest')
  })

  /**
   * Reported rather than swallowed. A history that cannot be read is either a
   * cache-shaped problem or a bug, and #61 is where that distinction turns into
   * a policy — this only has to not hide it.
   */
  it('fails on a history it cannot read, with the library’s own message', () => {
    const { value, errors } = quiet(() =>
      run([], {
        loadHistory: () => {
          throw new Error('h.json cannot be read as run history: the file is empty')
        },
      }),
    )
    expect(value.code).toBe(1)
    expect(errors).toContain('cannot be read as run history')
  })
})

describe('the summary line', () => {
  const analysis = (tests: AnalysedTest[], over: Partial<Analysis> = {}): Analysis => ({
    schemaVersion: 1,
    runId: 'r',
    commitSha: 'abc1234',
    branch: 'main',
    analysedAt: '2026-08-18T00:00:00.000Z',
    historyAvailable: true,
    historyDepth: 4,
    tests,
    ...over,
  })

  it('says there is no history rather than printing a depth of zero', () => {
    const line = summarise(analysis([], { historyAvailable: false, historyDepth: 0 }))
    expect(line).toContain('no history')
    expect(line).toContain('every test reads as new')
  })

  it('states the depth when there is one', () => {
    expect(summarise(analysis([]))).toContain('4 runs of history')
  })
})
