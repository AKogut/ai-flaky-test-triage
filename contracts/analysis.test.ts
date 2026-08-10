import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_SCHEMA_VERSION,
  AnalysisSchema,
  FlakySignalSchema,
  parseAnalysis,
  selectForTriage,
  StatusHistorySchema,
} from './analysis.js'

const signal = {
  testId: 'a.spec.ts›t',
  flakinessScore: 0.4,
  consecutiveFailures: 0,
  totalRuns: 12,
  firstSeenAt: '2026-07-01T00:00:00.000Z',
  lastPassedAt: '2026-08-01T00:00:00.000Z',
  statusHistory: 'PPFPFPP',
  isNew: false,
}

const result = {
  testId: 'a.spec.ts›t',
  title: 't',
  file: 'a.spec.ts',
  status: 'passed' as const,
  attempts: 1,
  flakyWithinRun: false,
  durationMs: 10,
  annotations: [],
}

const analysis = {
  schemaVersion: ANALYSIS_SCHEMA_VERSION,
  runId: 'run-1',
  commitSha: 'abc1234',
  branch: 'main',
  analysedAt: '2026-08-10T00:00:00.000Z',
  historyAvailable: true,
  historyDepth: 12,
  tests: [{ result, signal }],
}

describe('StatusHistorySchema', () => {
  it.each(['', 'P', 'PPPFPFPPF', 'TTSS'])('accepts %s', (h) => {
    expect(StatusHistorySchema.parse(h)).toBe(h)
  })

  it.each(['PPX', 'p', 'P F'])('rejects %s', (h) => {
    expect(() => StatusHistorySchema.parse(h)).toThrow()
  })
})

describe('FlakySignalSchema', () => {
  it('round-trips through JSON unchanged', () => {
    const once = FlakySignalSchema.parse(signal)
    expect(FlakySignalSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })

  it('keeps the score inside 0..1', () => {
    expect(() => FlakySignalSchema.parse({ ...signal, flakinessScore: 1.2 })).toThrow()
    expect(() => FlakySignalSchema.parse({ ...signal, flakinessScore: -0.1 })).toThrow()
  })

  it('allows a test that has never passed', () => {
    expect(FlakySignalSchema.parse({ ...signal, lastPassedAt: null }).lastPassedAt).toBeNull()
  })

  it('rejects an unknown field rather than dropping it', () => {
    expect(() => FlakySignalSchema.parse({ ...signal, score: 0.5 })).toThrow()
  })
})

describe('AnalysisSchema', () => {
  it('round-trips through JSON unchanged', () => {
    const once = AnalysisSchema.parse(analysis)
    expect(AnalysisSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })

  it('requires the history flags, so a cache miss cannot look like a fresh suite', () => {
    const { historyAvailable: _a, ...withoutFlag } = analysis
    expect(() => AnalysisSchema.parse(withoutFlag)).toThrow()
  })
})

describe('parseAnalysis', () => {
  it('accepts the current version', () => {
    expect(parseAnalysis(analysis, 'analysis.json').tests).toHaveLength(1)
  })

  it('refuses a future version instead of reading it best-effort', () => {
    // Best-effort would hand the consumer `undefined` where a field used to be
    // and let it carry on producing confident, wrong output.
    expect(() => parseAnalysis({ ...analysis, schemaVersion: 99 }, 'analysis.json')).toThrow(
      /schemaVersion 99[\s\S]*flakemetry:analyze/,
    )
  })

  it('names the source and the failing path on malformed input', () => {
    expect(() => parseAnalysis({ ...analysis, commitSha: 'x' }, 'fixture.json')).toThrow(
      /fixture\.json is not a valid analysis document:[\s\S]*commitSha/,
    )
  })
})

describe('selectForTriage', () => {
  const withTest = (r: Record<string, unknown>, s: Record<string, unknown> = {}) =>
    selectForTriage(
      AnalysisSchema.parse({
        ...analysis,
        tests: [{ result: { ...result, ...r }, signal: { ...signal, ...s } }],
      }),
    )

  it('selects failures', () => {
    expect(withTest({ status: 'failed' })).toHaveLength(1)
  })

  it('selects timeouts', () => {
    expect(withTest({ status: 'timedOut' })).toHaveLength(1)
  })

  it('selects a test that failed and then passed within the run', () => {
    // It passed, so a status filter alone would drop it — and a within-run flake
    // is the strongest intermittency evidence the run contains.
    expect(withTest({ status: 'passed', flakyWithinRun: true })).toHaveLength(1)
  })

  it('ignores a test that simply passed', () => {
    expect(withTest({ status: 'passed' }, { flakinessScore: 0 })).toHaveLength(0)
  })

  it('ignores a historically flaky test that is currently green', () => {
    // Its history is interesting; this run is not. Triaging it would spend
    // budget on a test that did not fail.
    expect(
      withTest({ status: 'passed' }, { flakinessScore: 0.9, consecutiveFailures: 0 }),
    ).toHaveLength(0)
  })

  it('ignores skipped tests', () => {
    expect(withTest({ status: 'skipped' }, { flakinessScore: 0 })).toHaveLength(0)
  })
})
