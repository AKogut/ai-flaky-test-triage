import { describe, expect, it, vi } from 'vitest'
import { ShallowCheckoutError, type GitReader } from './git.js'
import { DEGRADATIONS } from './report.js'
import { credentialState, main, parseArgs } from './run.js'
import type { ModelRequest, ModelResponse, Transport } from './transport.js'

/**
 * The one module in `agents/` that reads and writes, and it writes exactly one
 * file.
 *
 * The behaviour worth pinning is the exit code. A run where every model call
 * rate-limited still produced a correct report — one saying so — and failing the
 * build there would fail it over the weather. A non-zero exit from this program
 * means this program is broken, and nothing else.
 */

const CLASSIFICATION = {
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.9,
  reasoning: 'the diff changes the reducer the failing assertion reads',
  evidence: ['expected 3 to equal 4'],
}

const analysis = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    runId: 'r',
    commitSha: 'abc1234',
    branch: 'main',
    analysedAt: '2026-08-18T00:00:00.000Z',
    historyAvailable: true,
    historyDepth: 20,
    tests: [
      {
        result: {
          testId: 'tests/e2e/board.spec.ts›reorders',
          title: 'board › reorders',
          file: 'tests/e2e/board.spec.ts',
          status: 'failed',
          attempts: 1,
          flakyWithinRun: false,
          durationMs: 12,
          annotations: [],
          error: { message: 'expected 3 to equal 4' },
        },
        signal: {
          testId: 'tests/e2e/board.spec.ts›reorders',
          flakinessScore: 0.5,
          consecutiveFailures: 1,
          totalRuns: 20,
          firstSeenAt: '2026-08-01T00:00:00.000Z',
          lastPassedAt: null,
          statusHistory: 'PF',
          isNew: false,
        },
      },
    ],
    ...over,
  })

/** `seen` collects every request, so a test can read the prompt the model was given. */
function stub(fail?: Error, seen: ModelRequest[] = []): Transport {
  return {
    countInputTokens: () => Promise.resolve(100),
    send: (request: ModelRequest): Promise<ModelResponse> => {
      seen.push(request)
      return fail === undefined
        ? Promise.resolve({
            raw: CLASSIFICATION,
            stopReason: 'end_turn',
            model: 'claude-opus-5',
            usage: { inputTokens: 100, outputTokens: 30 },
          })
        : Promise.reject(fail)
    },
  }
}

/**
 * A git facade with no repository behind it. `diff` answers with whatever it is
 * given — text, or a failure — and records the range it was asked for.
 */
const fakeGit = (
  answer: string | Error = '',
): { open: () => GitReader; ranges: string[]; opened: () => number } => {
  const ranges: string[] = []
  let opened = 0
  const reader: GitReader = {
    diff: (options) => {
      ranges.push(options?.range ?? '')
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
    log: () => Promise.resolve([]),
    show: () => Promise.resolve(''),
    fileAtRef: () => Promise.resolve(null),
  }
  return {
    open: () => {
      opened += 1
      return reader
    },
    ranges,
    opened: () => opened,
  }
}

const run = async (
  argv: string[] = [],
  over: {
    files?: Record<string, string>
    env?: NodeJS.ProcessEnv
    transport?: Transport
    git?: () => GitReader
  } = {},
): Promise<{ code: number; written: Record<string, string>; output: string }> => {
  const files = over.files ?? { 'analysis.json': analysis() }
  const written: Record<string, string> = {}
  const lines: string[] = []

  const code = await main(argv, {
    env: over.env ?? { ANTHROPIC_API_KEY: 'test' },
    read: (p) => files[p] ?? '',
    exists: (p) => p in files,
    write: (p, contents) => {
      written[p] = contents
    },
    log: (m) => lines.push(m),
    cassetteCount: () => 0,
    git: over.git ?? fakeGit().open,
    ...(over.transport === undefined ? {} : { transport: over.transport }),
  })

  return { code, written, output: lines.join('\n') }
}

describe('the arguments', () => {
  it('defaults to the documented paths', () => {
    expect(parseArgs([])).toMatchObject({ analysis: 'analysis.json', out: 'report.md' })
  })

  it('reads every flag it documents', () => {
    expect(
      parseArgs(['--analysis', 'a.json', '--out', 'r.md', '--budget', '500', '--concurrency', '2']),
    ).toMatchObject({ analysis: 'a.json', out: 'r.md', budget: 500, concurrency: 2 })
  })
})

describe('whether a classifier is available', () => {
  /**
   * Checked once, before any work. Without credentials every test would fail
   * identically, and forty rows saying "no cassette for triage.v1" tell a reader
   * nothing they could not have been told once, at the top.
   */
  it('is no when replay is in force and nothing is recorded', () => {
    const state = credentialState({ SENTRA_REPLAY: '1' }, 0)
    expect(state.canRun).toBe(false)
    expect(state.notice).toContain('no cassettes are recorded')
  })

  it('is yes when replay has cassettes to serve', () => {
    expect(credentialState({ SENTRA_REPLAY: '1' }, 12).canRun).toBe(true)
  })

  /**
   * With nothing configured the repository defaults to replay, so the honest
   * notice is about cassettes rather than about a key. Asserted because the
   * tempting expectation is the other one.
   */
  it('falls back to replay, and says so, when nothing is configured at all', () => {
    const state = credentialState({}, 0)
    expect(state.canRun).toBe(false)
    expect(state.notice).toContain('no cassettes are recorded')
  })

  it('names the missing key when a live run was asked for', () => {
    const state = credentialState({ SENTRA_LIVE: '1' }, 0)
    expect(state.canRun).toBe(false)
    expect(state.notice).toContain('no ANTHROPIC_API_KEY')
  })

  it('is yes with either credential the SDK accepts', () => {
    expect(credentialState({ ANTHROPIC_API_KEY: 'k' }, 0).canRun).toBe(true)
    expect(credentialState({ ANTHROPIC_AUTH_TOKEN: 't' }, 0).canRun).toBe(true)
  })
})

describe('a run with nothing to triage', () => {
  /** A comment saying nothing went wrong, on every green PR, trains people to skip the one that matters. */
  it('writes no file at all', async () => {
    const green = JSON.parse(analysis()) as {
      tests: {
        result: { status: string }
        signal: { flakinessScore: number; consecutiveFailures: number }
      }[]
    }
    green.tests[0]!.result.status = 'passed'
    green.tests[0]!.signal.flakinessScore = 0
    green.tests[0]!.signal.consecutiveFailures = 0
    const result = await run([], { files: { 'analysis.json': JSON.stringify(green) } })
    expect(result.code).toBe(0)
    expect(result.written).toEqual({})
    expect(result.output).toContain('nothing to triage')
  })
})

describe('a run with no model', () => {
  it('still writes a report, and still exits 0', async () => {
    const result = await run([], { env: {} })
    expect(result.code).toBe(0)
    expect(Object.keys(result.written)).toEqual(['report.md'])
  })

  /**
   * ADR-0007 chose degrading over escalating, and this is where that stops being
   * a slogan: a fork pull request gets rows with real verdicts on them rather
   * than a page of "unclassified".
   */
  it('classifies with the baseline heuristic instead of giving up', async () => {
    const report = (await run([], { env: { SENTRA_LIVE: '1' } })).written['report.md'] ?? ''
    expect(report).toContain('baseline heuristic')
    expect(report).toContain('no ANTHROPIC_API_KEY')
    expect(report).not.toContain('unclassified')
  })

  /** Named for what a fork PR reader needs to know, not for the missing variable. */
  it('says why the model was skipped, in terms of forks', async () => {
    const report = (await run([], { env: { SENTRA_LIVE: '1' } })).written['report.md'] ?? ''
    expect(report).toContain('from a fork')
    expect(report).toContain('pull_request_target')
  })

  /** The control has to be readable, or it is not a fair comparison either. */
  it('produces verdicts a reader could act on, not a stub', async () => {
    const report = (await run([], { env: { SENTRA_LIVE: '1' } })).written['report.md'] ?? ''
    expect(report).toMatch(/app_code|test_code|environment/)
    expect(report).toContain('no rule matched')
  })
})

describe('a run that works', () => {
  it('writes exactly one file', async () => {
    const result = await run([], { transport: stub() })
    expect(Object.keys(result.written)).toEqual(['report.md'])
    expect(result.code).toBe(0)
  })

  it('classifies and reports', async () => {
    const report = (await run([], { transport: stub() })).written['report.md'] ?? ''
    expect(report).toContain('app_code+intermittent')
    expect(report).toContain('board › reorders')
  })

  /**
   * The exit code that matters. A run where every call rate-limited still
   * produced a correct report, and failing the build there fails it over the
   * weather.
   */
  it('exits 0 even when every model call failed', async () => {
    const result = await run([], { transport: stub(new Error('429 rate limited')) })
    expect(result.code).toBe(0)
    expect(result.written['report.md']).toContain('429 rate limited')
  })

  it('carries the missing-history notice into the report', async () => {
    const result = await run([], {
      files: { 'analysis.json': analysis({ historyAvailable: false, historyDepth: 0 }) },
      transport: stub(),
    })
    expect(result.written['report.md']).toContain('no history')
  })
})

describe('when it cannot do its job', () => {
  const quiet = async <T>(body: () => Promise<T>): Promise<{ value: T; errors: string }> => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    try {
      return { value: await body(), errors: errors.join('\n') }
    } finally {
      spy.mockRestore()
    }
  }

  it('fails when there is no analysis to read', async () => {
    const { value, errors } = await quiet(() => run([], { files: {} }))
    expect(value.code).toBe(1)
    expect(errors).toContain('flakemetry:analyze')
  })

  it('fails when the analysis is not one', async () => {
    const { value, errors } = await quiet(() =>
      run([], { files: { 'analysis.json': '{"schemaVersion":1}' } }),
    )
    expect(value.code).toBe(1)
    expect(errors).toContain('not a valid analysis')
  })
})

describe('the diff', () => {
  /** A product file and its spec, the way `git diff` prints them. */
  const DIFF = [
    'diff --git a/app/client/useTasks.ts b/app/client/useTasks.ts',
    '--- a/app/client/useTasks.ts',
    '+++ b/app/client/useTasks.ts',
    '@@ -1 +1 @@',
    '-export const order = (rows) => rows',
    '+export const order = (rows) => [...rows].reverse()',
    '',
  ].join('\n')

  const PR = { ANTHROPIC_API_KEY: 'test', GITHUB_BASE_REF: 'main' }

  /** On a pull request the change is everything since the merge base with the target. */
  it('reads the pull request against its base, and hands it to the model', async () => {
    const git = fakeGit(DIFF)
    const seen: ModelRequest[] = []
    const result = await run([], { env: PR, git: git.open, transport: stub(undefined, seen) })

    expect(git.ranges).toEqual(['origin/main...HEAD'])
    expect(seen[0]?.prompt).toContain('app/client/useTasks.ts')
    expect(seen[0]?.prompt).toContain('[...rows].reverse()')
    expect(seen[0]?.prompt).toContain('diff touches the code under test')
    expect(result.written['report.md']).not.toContain(DEGRADATIONS.noDiff.slice(0, 40))
  })

  /** A push to main, or a run on a laptop: the commit against its parent. */
  it('reads the commit against its parent when there is no base', async () => {
    const git = fakeGit(DIFF)
    await run([], { env: { ANTHROPIC_API_KEY: 'test', GITHUB_BASE_REF: '' }, git: git.open })
    expect(git.ranges).toEqual(['HEAD~1..HEAD'])
  })

  /**
   * The rule that could never fire in CI: no key means the baseline, and the
   * baseline's product-change rule reads the same diff the model would have.
   */
  it('reaches the baseline too', async () => {
    const report =
      (
        await run([], {
          env: { SENTRA_LIVE: '1', GITHUB_BASE_REF: 'main' },
          git: fakeGit(DIFF).open,
        })
      ).written['report.md'] ?? ''
    expect(report).toContain('the commit changes product source')
    expect(report).not.toContain('no rule matched')
  })

  it('is read once per run, not once per test', async () => {
    const one = JSON.parse(analysis()) as { tests: { result: Record<string, unknown> }[] }
    const second = structuredClone(one.tests[0]!)
    second.result.testId = 'tests/e2e/board.spec.ts›renames'
    const git = fakeGit(DIFF)
    const seen: ModelRequest[] = []
    await run([], {
      files: { 'analysis.json': analysis({ tests: [one.tests[0], second] }) },
      env: PR,
      git: git.open,
      transport: stub(undefined, seen),
    })
    expect(git.opened()).toBe(1)
    expect(git.ranges).toHaveLength(1)
    expect(seen).toHaveLength(2)
    expect(seen.every((r) => r.prompt.includes('[...rows].reverse()'))).toBe(true)
  })

  /** A run with nothing to triage writes nothing, and has no reason to ask git anything. */
  it('is not read when there is nothing to triage', async () => {
    const green = JSON.parse(analysis()) as {
      tests: { result: { status: string }; signal: Record<string, number> }[]
    }
    green.tests[0]!.result.status = 'passed'
    green.tests[0]!.signal.flakinessScore = 0
    green.tests[0]!.signal.consecutiveFailures = 0
    const git = fakeGit(DIFF)
    await run([], { files: { 'analysis.json': JSON.stringify(green) }, git: git.open })
    expect(git.opened()).toBe(0)
  })

  /** An empty change is a fact about the change, not a failure to read it. */
  it('says nothing when the change is empty', async () => {
    const result = await run([], { git: fakeGit('').open, transport: stub() })
    expect(result.written['report.md']).not.toContain('could not be read from git')
    expect(result.output).not.toContain('no diff')
  })

  describe('when git cannot answer', () => {
    /**
     * Every one of these degrades to "no diff": the run still classifies, still
     * writes its one file, still exits 0, and says what it went without.
     */
    const failures: [string, () => GitReader][] = [
      [
        'the base is unreachable',
        fakeGit(new Error("fatal: bad revision 'origin/main...HEAD'")).open,
      ],
      [
        'the checkout is not a repository',
        fakeGit(new Error('fatal: not a git repository (or any of the parent directories): .git'))
          .open,
      ],
      [
        'the checkout is shallow',
        fakeGit(new ShallowCheckoutError('git diff HEAD~1..HEAD', new Error('bad object HEAD~1')))
          .open,
      ],
      [
        'the client cannot even be opened',
        () => {
          throw new Error('Cannot use simple-git on a directory that does not exist')
        },
      ],
    ]

    it.each(failures)('degrades when %s', async (_name, git) => {
      const seen: ModelRequest[] = []
      const result = await run([], { env: PR, git, transport: stub(undefined, seen) })

      expect(result.code).toBe(0)
      expect(Object.keys(result.written)).toEqual(['report.md'])
      expect(result.written['report.md']).toContain('could not be read from git')
      expect(result.written['report.md']).toContain('app_code+intermittent')
      expect(seen).toHaveLength(1)
      expect(seen[0]?.prompt).not.toContain('diff touches')
    })

    it.each(failures)('says why in the log when %s', async (_name, git) => {
      const result = await run([], { env: PR, git, transport: stub() })
      expect(result.output).toMatch(/no diff for origin\/main\.\.\.HEAD: \S/)
    })

    /** The baseline degrades the same way, and its other rules still run. */
    it('leaves the baseline classifying without the product-change rule', async () => {
      const report =
        (
          await run([], {
            env: { SENTRA_LIVE: '1', GITHUB_BASE_REF: 'main' },
            git: fakeGit(new Error("fatal: bad revision 'origin/main...HEAD'")).open,
          })
        ).written['report.md'] ?? ''
      expect(report).toContain('could not be read from git')
      expect(report).toContain('no rule matched')
    })

    /** The shallow diagnosis names the fix; the log is where somebody reads it. */
    it('carries the fetch-depth fix into the log on a shallow checkout', async () => {
      const result = await run([], {
        env: PR,
        git: fakeGit(new ShallowCheckoutError('git diff', new Error('bad object'))).open,
        transport: stub(),
      })
      expect(result.output).toContain('fetch-depth: 0')
    })
  })
})
