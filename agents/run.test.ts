import { describe, expect, it, vi } from 'vitest'
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

function stub(fail?: Error): Transport {
  return {
    countInputTokens: () => Promise.resolve(100),
    send: (_request: ModelRequest): Promise<ModelResponse> =>
      fail === undefined
        ? Promise.resolve({
            raw: CLASSIFICATION,
            stopReason: 'end_turn',
            model: 'claude-opus-5',
            usage: { inputTokens: 100, outputTokens: 30 },
          })
        : Promise.reject(fail),
  }
}

const run = async (
  argv: string[] = [],
  over: { files?: Record<string, string>; env?: NodeJS.ProcessEnv; transport?: Transport } = {},
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
