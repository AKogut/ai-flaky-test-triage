import type { AnalysedTest, Analysis, ClassificationInput } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { TokenBudget } from './model-client.js'
import { runPipeline, type PipelineDeps } from './pipeline.js'
import type { ModelRequest, ModelResponse, Transport } from './transport.js'

/**
 * The wiring, which is where the interesting bugs live.
 *
 * Each agent is covered by its own file. What is only visible here is what
 * happens between them: whether one test's API error takes the run down, whether
 * the budget stops dispatch before it spends rather than after, and whether the
 * downstream agents run when nobody has calibrated the classifier.
 */

const CLASSIFICATION = {
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.9,
  reasoning: 'the diff changes the reducer the failing assertion reads',
  evidence: ['expected 3 to equal 4'],
}
const ROOT_CAUSE = {
  hypothesis: 'Whichever response arrives last wins.',
  implicatedFiles: ['app/board.ts'],
  implicatedSymbols: ['reconcile'],
  mechanism: 'race',
  confidence: 0.8,
}
const FIX = {
  summary: 'Discard responses that are not the newest.',
  approach: 'Tag each fetch with an increasing id and ignore stale replies.',
  risks: ['Callers relying on every response being applied will see some discarded'],
}

/** Replies by schema name — the only agent marker the request carries. */
function stub(
  over: { fail?: (n: number) => Error | undefined } = {},
): Transport & { sent: ModelRequest[] } {
  const sent: ModelRequest[] = []
  return {
    sent,
    countInputTokens: () => Promise.resolve(100),
    send: (request): Promise<ModelResponse> => {
      sent.push(request)
      const failure = over.fail?.(sent.length)
      if (failure !== undefined) return Promise.reject(failure)
      const raw =
        request.schemaName === 'root_cause'
          ? ROOT_CAUSE
          : request.schemaName === 'fix_suggestion'
            ? FIX
            : CLASSIFICATION
      return Promise.resolve({
        raw,
        stopReason: 'end_turn',
        model: 'claude-opus-5',
        usage: { inputTokens: 100, outputTokens: 30 },
      })
    },
  }
}

const test = (testId: string, flaky = 0.5): AnalysedTest => ({
  result: {
    testId,
    title: testId,
    file: `tests/e2e/${testId}.spec.ts`,
    status: 'failed',
    attempts: 1,
    flakyWithinRun: false,
    durationMs: 1,
    annotations: [],
    error: { message: 'expected 3 to equal 4' },
  },
  signal: {
    testId,
    flakinessScore: flaky,
    consecutiveFailures: 1,
    totalRuns: 20,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastPassedAt: null,
    statusHistory: 'PF',
    isNew: false,
  },
})

const analysis = (tests: AnalysedTest[]): Analysis => ({
  schemaVersion: 1,
  runId: 'r',
  commitSha: 'abc1234',
  branch: 'main',
  analysedAt: '2026-08-18T00:00:00.000Z',
  historyAvailable: true,
  historyDepth: 20,
  tests,
})

type DepsOverride = { [K in keyof PipelineDeps]?: PipelineDeps[K] | undefined }

const deps = (transport: Transport, over: DepsOverride = {}): PipelineDeps =>
  ({
    triage: { transport, system: 'triage', promptVersion: 'triage.v1' },
    rootCause: {
      transport,
      system: 'root cause',
      promptVersion: 'root-cause.v1',
      exists: () => true,
    },
    fixSuggestion: { transport, system: 'fix', promptVersion: 'fix-suggestion.v1' },
    threshold: 0.7,
    budget: new TokenBudget(1_000_000),
    inputFor: (t): ClassificationInput => ({ historyAvailable: true, subject: t }),
    concurrency: 2,
    ...over,
  }) as PipelineDeps

describe('driving the three agents', () => {
  it('classifies every failure and keeps the work order', async () => {
    const result = await runPipeline(analysis([test('b', 0.1), test('a', 0.9)]), deps(stub()))
    expect(result.triaged.map((r) => r.test.result.testId)).toEqual(['a', 'b'])
    expect(result.triaged.every((r) => r.classification !== undefined)).toBe(true)
  })

  it('runs root cause and fix suggestion above the threshold', async () => {
    const result = await runPipeline(analysis([test('a')]), deps(stub()))
    expect(result.triaged[0]?.rootCause?.mechanism).toBe('race')
    expect(result.triaged[0]?.fixSuggestion?.risks).toHaveLength(1)
  })

  /**
   * The refusal `root-cause.ts` is built around, seen from the pipeline: with no
   * calibration published there is no threshold, so no hypothesis is produced at
   * all — however confident the classifier sounded.
   */
  it('produces no hypothesis when nobody has calibrated the classifier', async () => {
    const result = await runPipeline(analysis([test('a')]), deps(stub(), { threshold: null }))
    expect(result.triaged[0]?.classification).toBeDefined()
    expect(result.triaged[0]?.rootCause).toBeUndefined()
    expect(result.triaged[0]?.fixSuggestion).toBeUndefined()
  })

  it('stops after triage when the downstream agents are not configured', async () => {
    const result = await runPipeline(
      analysis([test('a')]),
      deps(stub(), { rootCause: undefined, fixSuggestion: undefined }),
    )
    expect(result.triaged[0]?.classification).toBeDefined()
    expect(result.triaged[0]?.rootCause).toBeUndefined()
  })

  it('reports a run where everything worked as not degraded', async () => {
    expect((await runPipeline(analysis([test('a')]), deps(stub()))).degraded).toBe(false)
  })

  it('does nothing at all for a run with nothing to triage', async () => {
    const transport = stub()
    const result = await runPipeline(analysis([]), deps(transport))
    expect(transport.sent).toEqual([])
    expect(result.triaged).toEqual([])
  })
})

describe('when one call fails', () => {
  /**
   * The pipeline analyses CI failures. Being unavailable exactly when CI is
   * unhealthy would be a poor joke, so one test's error is one row.
   */
  it('the rest of the run still finishes', async () => {
    const result = await runPipeline(
      analysis([test('a', 0.9), test('b', 0.5), test('c', 0.1)]),
      deps(stub({ fail: (n) => (n === 1 ? new Error('429 rate limited') : undefined) }), {
        concurrency: 1,
        rootCause: undefined,
        fixSuggestion: undefined,
      }),
    )
    expect(result.triaged.filter((r) => r.classification !== undefined)).toHaveLength(2)
    expect(result.triaged.filter((r) => r.unclassified !== undefined)).toHaveLength(1)
  })

  /** A missing row reads as "nothing was wrong with this test", the opposite of the truth. */
  it('the failure is a row with a reason, not a gap', async () => {
    const result = await runPipeline(
      analysis([test('a')]),
      deps(stub({ fail: () => new Error('429 rate limited') })),
    )
    expect(result.triaged).toHaveLength(1)
    expect(result.triaged[0]?.unclassified).toMatchObject({ reason: 'error' })
    expect(result.triaged[0]?.unclassified?.detail).toContain('429')
    expect(result.degraded).toBe(true)
  })
})

describe('the token budget', () => {
  /**
   * Distinguished from an API error on purpose: one means the run was too big
   * for its allowance, the other means something broke, and they need different
   * things done about them.
   */
  it('reports exhaustion as its own reason', async () => {
    const result = await runPipeline(
      analysis([test('a'), test('b')]),
      deps(stub(), {
        budget: new TokenBudget(150),
        concurrency: 1,
        rootCause: undefined,
        fixSuggestion: undefined,
      }),
    )
    const reasons = result.triaged.map((r) => r.unclassified?.reason)
    expect(reasons).toContain('budget')
    expect(result.degraded).toBe(true)
  })

  /**
   * Checked before dispatch, so the run stops starting calls rather than
   * discovering the limit through one that already spent money.
   */
  it('stops dispatching once it is gone, and says which tests were never reached', async () => {
    const transport = stub()
    const result = await runPipeline(
      analysis([test('a'), test('b'), test('c'), test('d')]),
      deps(transport, {
        budget: new TokenBudget(260),
        concurrency: 1,
        rootCause: undefined,
        fixSuggestion: undefined,
      }),
    )
    expect(transport.sent.length).toBeLessThan(4)
    expect(result.triaged.map((r) => r.unclassified?.reason)).toContain('not-dispatched')
    expect(result.triaged).toHaveLength(4)
  })
})
