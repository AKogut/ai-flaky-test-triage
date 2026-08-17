import { describe, expect, it, vi } from 'vitest'
import {
  latestFailures,
  ordered,
  parseArgs,
  reportRoot,
  signalFrom,
  suggestName,
  withoutComments,
  main,
} from '../../scripts/capture.js'
import type { TestResult, TestRun } from '@sentra/contracts'

/**
 * The capture command, which turns real reports into dataset payloads.
 *
 * The thing it must never do is guess a label, and the thing it must always do
 * is leave the evidence alone apart from the two normalisations the dataset
 * requires. Both are checked here; the tool's real proving ground was pointing
 * it at nine downloaded CI reports, which is what found the two defects the
 * comments in it now describe.
 */

const result = (over: Partial<TestResult> = {}): TestResult => ({
  testId: 'tests/e2e/board.spec.ts›shows a row',
  title: 'shows a row',
  file: 'tests/e2e/board.spec.ts',
  status: 'failed',
  attempts: 1,
  flakyWithinRun: false,
  durationMs: 12,
  annotations: [],
  ...over,
})

const run = (results: TestResult[], startedAt = '2026-08-01T00:00:00.000Z'): TestRun => ({
  runId: 'r',
  commitSha: 'abc1234',
  branch: 'main',
  startedAt,
  durationMs: 1,
  source: 'playwright',
  results,
})

describe('the arguments', () => {
  it('reads every flag it documents', () => {
    expect(parseArgs(['--report', 'r.json', '--test', 'a title', '--dir', 'out', '--all'])).toEqual(
      { report: 'r.json', test: 'a title', dir: 'out', all: true },
    )
  })

  it('ignores a flag with nothing after it rather than swallowing the next one', () => {
    expect(parseArgs(['--report'])).toEqual({})
  })
})

describe('choosing what to capture', () => {
  /**
   * The first version took the newest report's failures, which is too narrow: a
   * suite with five specs that can fail produces a different two or three per
   * run, so the rest needed hand-truncated directories to reach.
   */
  it('takes each test’s most recent failure, not only the newest run’s', () => {
    const runs = [
      run([result({ testId: 'a', status: 'failed' }), result({ testId: 'b', status: 'passed' })]),
      run([result({ testId: 'a', status: 'passed' }), result({ testId: 'b', status: 'failed' })]),
    ]
    expect(
      latestFailures(runs)
        .map((c) => c.result.testId)
        .sort(),
    ).toEqual(['a', 'b'])
  })

  /** A history that ran past the failure would describe a future the classifier could not see. */
  it('stops the history at the run being captured', () => {
    const runs = [
      run([result({ testId: 'a', status: 'passed' })]),
      run([result({ testId: 'a', status: 'failed' })]),
      run([result({ testId: 'a', status: 'passed' })]),
    ]
    expect(latestFailures(runs)[0]?.history).toBe('PF')
  })

  it('skips runs the test does not appear in, because a spec has a first day', () => {
    const runs = [run([]), run([result({ status: 'failed' })])]
    expect(latestFailures(runs)[0]?.history).toBe('F')
  })

  it('takes the timestamps from the runs rather than from the clock', () => {
    const runs = [
      run([result({ testId: 'a', status: 'passed' })], '2026-08-01T00:00:00.000Z'),
      run([result({ testId: 'a', status: 'failed' })], '2026-08-02T00:00:00.000Z'),
    ]
    expect(latestFailures(runs)[0]).toMatchObject({
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      lastPassedAt: '2026-08-01T00:00:00.000Z',
    })
  })

  it('reports no last pass when there has never been one', () => {
    expect(latestFailures([run([result({ status: 'failed' })])])[0]?.lastPassedAt).toBeNull()
  })

  it('finds nothing when nothing failed', () => {
    expect(latestFailures([run([result({ status: 'passed' })])])).toEqual([])
  })
})

describe('the signal', () => {
  it('scores a fully alternating history at 1 and an unbroken one at 0', () => {
    expect(signalFrom('FPFPF').flakinessScore).toBe(1)
    expect(signalFrom('FFFFF').flakinessScore).toBe(0)
  })

  /** "How much it alternates", not "how often it fails" — a test that always fails is broken. */
  it('does not confuse a broken test with an unstable one', () => {
    expect(signalFrom('FFFFFFFF').flakinessScore).toBeLessThan(
      signalFrom('PFPFPPFF').flakinessScore,
    )
  })

  it('counts the failures at the end, which is what the streak rule reads', () => {
    expect(signalFrom('PPFF').consecutiveFailures).toBe(2)
    expect(signalFrom('FFPP').consecutiveFailures).toBe(0)
  })

  it('scores a single run at zero rather than dividing by nothing', () => {
    expect(signalFrom('F')).toMatchObject({ flakinessScore: 0, totalRuns: 1 })
  })
})

describe('the checkout the report came from', () => {
  /**
   * Not the checkout this command runs in. The two are the same locally and are
   * not the same for a report downloaded from CI, which is the case that matters
   * and the one that broke this the first time it was used for real.
   */
  it('is read from the report', () => {
    expect(reportRoot({ config: { rootDir: '/home/runner/work/x/x' } })).toBe(
      '/home/runner/work/x/x',
    )
  })

  it('is empty rather than guessed when the report does not say', () => {
    expect(reportRoot({})).toBe('')
    expect(reportRoot({ config: { rootDir: 7 } })).toBe('')
  })
})

describe('the payload it writes', () => {
  it('strips comments from the captured source', () => {
    const source = ['/** why this fails */', 'const a = 1 // and here', '// a whole line', 'b()']
    expect(withoutComments(source.join('\n'))).toBe('const a = 1 // and here\nb()')
  })

  it('suggests a name from the file and the title, in kebab case', () => {
    expect(suggestName(result({ file: 'tests/e2e/board.spec.ts', title: 'Shows a Row!' }))).toBe(
      'board-shows-a-row',
    )
  })

  it('orders reports by the number in the filename, not by string order', () => {
    expect(ordered(['run-10.json', 'run-2.json', 'notes.txt'])).toEqual([
      'run-2.json',
      'run-10.json',
    ])
  })
})

describe('the command', () => {
  const report = {
    config: { rootDir: '/ci/checkout' },
    stats: { startTime: '2026-08-01T00:00:00.000Z', duration: 5 },
    suites: [
      {
        title: 'board.spec.ts',
        file: 'tests/e2e/board.spec.ts',
        specs: [
          {
            title: 'shows a row',
            file: 'tests/e2e/board.spec.ts',
            tests: [
              {
                status: 'unexpected',
                annotations: [],
                results: [
                  {
                    status: 'failed',
                    duration: 9,
                    retry: 0,
                    error: { message: 'at /ci/checkout/tests/e2e/board.spec.ts:3:1' },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }

  const capture = (
    argv: string[],
    over: { exists?: (path: string) => boolean } = {},
  ): { code: number; written: Record<string, string>; output: string } => {
    const written: Record<string, string> = {}
    const lines: string[] = []
    const code = main(argv, {
      read: () => JSON.stringify(report),
      list: () => ['run-1.json'],
      write: (path, contents) => {
        written[path] = contents
      },
      exists: over.exists ?? (() => false),
      log: (message) => lines.push(message),
      now: () => '2026-08-01T00:00:00.000Z',
    })
    return { code, written, output: lines.join('\n') }
  }

  it('writes one payload per failure', () => {
    const { code, written } = capture(['--report', 'r.json', '--all', '--dir', 'out'])
    expect(code).toBe(0)
    expect(Object.keys(written)).toEqual(['out/board-shows-a-row.run.json'])
  })

  /** The runner's absolute path reaches a prompt and then a public comment. */
  it('strips the path of the machine that ran the suite', () => {
    const { written } = capture(['--report', 'r.json', '--all', '--dir', 'out'])
    expect(Object.values(written)[0]).not.toContain('/ci/checkout')
    expect(Object.values(written)[0]).toContain('tests/e2e/board.spec.ts:3:1')
  })

  /** A label the tool guessed would make the dataset a record of what the pipeline believes. */
  it('writes no label and says what is left to do by hand', () => {
    const { written, output } = capture(['--report', 'r.json', '--all', '--dir', 'out'])
    expect(Object.values(written)[0]).not.toContain('owner')
    expect(Object.keys(written).some((path) => path.includes('labels'))).toBe(false)
    expect(output).toContain('docs/taxonomy.md')
  })

  /** A payload edited after a good result is invisible in a diff of numbers. */
  it('refuses to overwrite an existing fixture', () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    try {
      expect(capture(['--report', 'r.json', '--all'], { exists: () => true }).code).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join('')).toContain('already exists')
  })

  it('reads a directory of reports and builds the history from all of them', () => {
    const written: Record<string, string> = {}
    const code = main(['--history', 'runs', '--all', '--dir', 'out'], {
      read: () => JSON.stringify(report),
      list: () => ['run-2.json', 'run-1.json', 'notes.txt'],
      write: (path, contents) => {
        written[path] = contents
      },
      exists: () => false,
      log: () => undefined,
      now: () => '2026-08-01T00:00:00.000Z',
    })

    expect(code).toBe(0)
    const payload = JSON.parse(Object.values(written)[0] ?? '{}') as {
      historyAvailable: boolean
      subject: { signal: { statusHistory: string; isNew: boolean } }
    }
    // Two reports, both failing, ordered by the number in the filename.
    expect(payload.subject.signal.statusHistory).toBe('FF')
    expect(payload.historyAvailable).toBe(true)
    expect(payload.subject.signal.isNew).toBe(false)
  })

  /**
   * One report is honest and much less useful: with nothing to compare against,
   * the determinism axis has no evidence at all, and the payload says so rather
   * than implying a history it does not have.
   */
  it('marks a single report as having no history to draw on', () => {
    const written: Record<string, string> = {}
    main(['--report', 'r.json', '--all', '--dir', 'out'], {
      read: () => JSON.stringify(report),
      list: () => [],
      write: (path, contents) => {
        written[path] = contents
      },
      exists: () => false,
      log: () => undefined,
      now: () => '2026-08-01T00:00:00.000Z',
    })

    const payload = JSON.parse(Object.values(written)[0] ?? '{}') as {
      historyAvailable: boolean
      subject: { signal: { isNew: boolean } }
      testSource?: string
    }
    expect(payload.historyAvailable).toBe(false)
    expect(payload.subject.signal.isNew).toBe(true)
    // No source either: nothing on disk answers to that path in this test.
    expect(payload.testSource).toBeUndefined()
  })

  it('selects one test by a fragment of its title', () => {
    const written: Record<string, string> = {}
    const code = main(['--report', 'r.json', '--test', 'shows a row', '--dir', 'out'], {
      read: () => JSON.stringify(report),
      list: () => [],
      write: (path, contents) => {
        written[path] = contents
      },
      exists: () => false,
      log: () => undefined,
      now: () => '2026-08-01T00:00:00.000Z',
    })
    expect(code).toBe(0)
    expect(Object.keys(written)).toHaveLength(1)
  })

  it('says how much it looked at when nothing matched', () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })

    try {
      expect(capture(['--report', 'r.json', '--test', 'no such test']).code).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join('')).toContain('failed and matched')
    expect(errors.join('')).toContain('1 report(s)')
  })

  it('refuses to run without being told what to read', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(capture(['--all']).code).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses to run without being told what to capture', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(capture(['--report', 'r.json']).code).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
