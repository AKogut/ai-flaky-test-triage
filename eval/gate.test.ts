import { readFileSync } from 'node:fs'
import type { ModelRequest, ModelResponse, Transport } from '@sentra/agents'
import { describe, expect, it } from 'vitest'
import {
  MetricsSnapshotSchema,
  readReferenceSnapshot,
  renderGateReport,
  runGate,
  snapshot,
  THRESHOLDS,
  type MetricsSnapshot,
} from './gate.js'
import { quadrantBreakdown } from './confusion.js'
import { DEFAULTS, evaluate, gatedCost, METRICS_PATHS, type Evaluation } from './run-eval.js'

const at = (lower: number, over: Partial<MetricsSnapshot> = {}): MetricsSnapshot => ({
  version: 1,
  classifier: 'baseline',
  promptVersion: null,
  slice: 'dev',
  datasetRevision: 'abcd',
  n: 22,
  joint: { point: lower + 0.1, lower, upper: lower + 0.3 },
  owner: { point: 0.5, lower: 0.3, upper: 0.7, macroF1: 0.4 },
  determinism: { point: 0.8, lower: 0.6, upper: 0.9, macroF1: 0.8 },
  hardQuadrant: { point: 0.33, lower: 0.1, upper: 0.7, support: 6, correct: 2 },
  selfConsistency: null,
  costPerFixtureUsd: null,
  ...over,
})

const check = (report: ReturnType<typeof runGate>, id: string) =>
  report.checks.find((c) => c.id === id)

const evaluation = await evaluate(DEFAULTS)

describe('joint accuracy regression', () => {
  it('passes an unchanged classifier', () => {
    const report = runGate({ current: at(0.2), reference: at(0.2) })
    expect(check(report, 'joint-accuracy-regression')?.status).toBe('pass')
    expect(report.failed).toBe(false)
  })

  it('passes an improvement', () => {
    expect(
      check(runGate({ current: at(0.4), reference: at(0.2) }), 'joint-accuracy-regression')?.status,
    ).toBe('pass')
  })

  it('tolerates a drop inside the allowance', () => {
    // Deliberately wide. At n=22 the interval is ±19pp, so a tighter bound would
    // fire on fixtures being added rather than on the classifier changing.
    const justInside = 0.3 - THRESHOLDS.jointAccuracyRegressionPp
    expect(
      check(runGate({ current: at(justInside), reference: at(0.3) }), 'joint-accuracy-regression')
        ?.status,
    ).toBe('pass')
  })

  it('fails a drop past the allowance', () => {
    const report = runGate({
      current: at(0.3 - THRESHOLDS.jointAccuracyRegressionPp - 0.001),
      reference: at(0.3),
    })
    expect(check(report, 'joint-accuracy-regression')?.status).toBe('fail')
    expect(report.failed).toBe(true)
  })

  it('compares lower bounds, not point estimates', () => {
    // A classifier whose point estimate rose while its lower bound collapsed has
    // got noisier, not better, and that is exactly what this gate is for.
    const current = at(0.1, { joint: { point: 0.9, lower: 0.1, upper: 0.99 } })
    const reference = at(0.3, { joint: { point: 0.4, lower: 0.3, upper: 0.5 } })
    expect(check(runGate({ current, reference }), 'joint-accuracy-regression')?.status).toBe('fail')
  })

  it('names both values and the threshold', () => {
    // A failure that does not say what it compared sends the reader to run the
    // evaluation again by hand to find out.
    const detail = check(
      runGate({ current: at(0.1), reference: at(0.3) }),
      'joint-accuracy-regression',
    )?.detail
    expect(detail).toContain('10.0pp now')
    expect(detail).toContain('30.0pp on main')
    expect(detail).toContain('allowed down to 25.0pp')
  })

  it('skips when main has no recorded metrics', () => {
    // The first run, and any branch older than this feature.
    expect(
      check(runGate({ current: at(0.2), reference: null }), 'joint-accuracy-regression')?.status,
    ).toBe('skipped')
  })

  it('skips rather than comparing across slices', () => {
    // A dev number against a held-out one would fire on the slice changing.
    const report = runGate({ current: at(0.2), reference: at(0.9, { slice: 'holdout' }) })
    expect(check(report, 'joint-accuracy-regression')?.status).toBe('skipped')
    expect(report.failed).toBe(false)
  })
})

describe('thresholds that are agent targets', () => {
  it.each(['joint-accuracy-floor', 'hard-quadrant-floor'])(
    '%s is skipped for the baseline, with the distance still shown',
    (id) => {
      // Enabling these today would make main permanently red on a fact everybody
      // knows, and a permanently red gate is one people learn to merge past.
      const result = check(runGate({ current: at(0.2), reference: null }), id)
      expect(result?.status).toBe('skipped')
      expect(result?.detail).toContain('target for the agent')
      expect(result?.detail).toContain('Enforced whenever')
    },
  )

  it('enforces the joint floor once the agent is the classifier', () => {
    const below = at(0.2, { classifier: 'agent' })
    const above = at(THRESHOLDS.jointAccuracyFloor, { classifier: 'agent' })
    expect(
      check(runGate({ current: below, reference: null }), 'joint-accuracy-floor')?.status,
    ).toBe('fail')
    expect(
      check(runGate({ current: above, reference: null }), 'joint-accuracy-floor')?.status,
    ).toBe('pass')
  })

  it('enforces the hard-quadrant floor once the agent is the classifier', () => {
    const current = at(0.9, {
      classifier: 'agent',
      hardQuadrant: { point: 0.6, lower: 0.55, upper: 0.9, support: 6, correct: 4 },
    })
    expect(check(runGate({ current, reference: null }), 'hard-quadrant-floor')?.status).toBe('pass')
  })

  it('skips the hard quadrant when the slice contains none of it', () => {
    const current = at(0.9, {
      classifier: 'agent',
      hardQuadrant: { point: 0, lower: 0, upper: 1, support: 0, correct: 0 },
    })
    expect(check(runGate({ current, reference: null }), 'hard-quadrant-floor')?.status).toBe(
      'skipped',
    )
  })
})

describe('beating the baseline', () => {
  it('is not asked of the baseline itself', () => {
    expect(check(runGate({ current: at(0.2), reference: null }), 'beats-baseline')?.status).toBe(
      'skipped',
    )
  })

  it('fails an agent that scores below the control', () => {
    // Any regression against the control blocks: the delta is the result this
    // project reports, so an agent that loses to sixty lines of heuristic has
    // nothing to publish.
    const report = runGate({
      current: at(0.2, { classifier: 'agent' }),
      reference: null,
      baseline: at(0.3),
    })
    expect(check(report, 'beats-baseline')?.status).toBe('fail')
  })

  it('passes an agent that matches the control exactly', () => {
    const report = runGate({
      current: at(0.3, { classifier: 'agent' }),
      reference: null,
      baseline: at(0.3),
    })
    expect(check(report, 'beats-baseline')?.status).toBe('pass')
  })
})

describe('checks waiting on a model', () => {
  it('skips self-consistency while nothing is sampled', () => {
    const result = check(runGate({ current: at(0.2), reference: null }), 'self-consistency')
    expect(result?.status).toBe('skipped')
    expect(result?.detail).toContain('#38')
  })

  it('fails an unstable classifier once stability is measured', () => {
    const current = at(0.9, { selfConsistency: THRESHOLDS.selfConsistencyFloor - 0.01 })
    expect(check(runGate({ current, reference: null }), 'self-consistency')?.status).toBe('fail')
  })

  it('skips cost while there is none', () => {
    expect(check(runGate({ current: at(0.2), reference: null }), 'cost-per-fixture')?.status).toBe(
      'skipped',
    )
  })

  it('fails a sharp cost rise', () => {
    const current = at(0.9, { costPerFixtureUsd: 0.016 })
    const reference = at(0.9, { costPerFixtureUsd: 0.01 })
    expect(check(runGate({ current, reference }), 'cost-per-fixture')?.status).toBe('fail')
  })

  it('allows a rise inside the allowance', () => {
    const current = at(0.9, { costPerFixtureUsd: 0.01 * (1 + THRESHOLDS.costIncrease) })
    const reference = at(0.9, { costPerFixtureUsd: 0.01 })
    expect(check(runGate({ current, reference }), 'cost-per-fixture')?.status).toBe('pass')
  })

  it('skips the first priced run, which has nothing on main to compare with', () => {
    const result = check(
      runGate({ current: at(0.9, { costPerFixtureUsd: 0.01 }), reference: at(0.9) }),
      'cost-per-fixture',
    )
    expect(result?.status).toBe('skipped')
    expect(result?.detail).toBe('no cost recorded on main to compare with')
  })

  /**
   * A cost with a missing share is a floor. Holding a floor to a ceiling passes
   * for the wrong reason — the cheaper the unpriced model looks, the more it
   * hides — so the check fails and names the fix.
   */
  it('fails a run whose model has no price rather than comparing what is left', () => {
    const result = check(
      runGate({
        current: at(0.9, { costPerFixtureUsd: 0.001 }),
        reference: at(0.9, { costPerFixtureUsd: 0.01 }),
        unpricedModels: ['claude-unreleased-9'],
      }),
      'cost-per-fixture',
    )
    expect(result?.status).toBe('fail')
    expect(result?.detail).toContain('claude-unreleased-9')
    expect(result?.detail).toContain('agents/pricing.ts')
  })

  it('still skips a run that called no model, whatever the price table lacks', () => {
    expect(
      check(
        runGate({ current: at(0.9), reference: null, unpricedModels: ['claude-unreleased-9'] }),
        'cost-per-fixture',
      )?.status,
    ).toBe('skipped')
  })
})

/**
 * The cost threshold, held to a scored agent run end to end — no key, no
 * cassettes, a scripted transport.
 *
 * What makes it enforceable is that the figure is real: it comes from the usage
 * ledger the token budget is charged from, so a prompt that makes the model
 * retry costs what it costs. A success-only tally would price the run below.
 */
describe('the cost check, against an agent run', { timeout: 30_000 }, () => {
  const REPLY = {
    owner: 'app_code',
    determinism: 'intermittent',
    confidence: 0.5,
    reasoning: 'a reason',
    evidence: ['status: failed'],
  }
  const USAGE = { inputTokens: 1_000, outputTokens: 200 }

  /** Answers every request; when `retrying`, rejects each fixture's first answer. */
  const answering = (over: { model?: string; retrying?: boolean } = {}): Transport => ({
    countInputTokens: () => Promise.resolve(USAGE.inputTokens),
    send: (request: ModelRequest): Promise<ModelResponse> =>
      Promise.resolve({
        raw:
          over.retrying === true && !request.prompt.includes('did not match the required schema')
            ? { owner: 'app_code' }
            : REPLY,
        stopReason: 'end_turn',
        model: over.model ?? 'claude-opus-5-5',
        usage: USAGE,
      }),
  })

  const scored = async (transport: Transport): Promise<Evaluation> =>
    evaluate(
      { ...DEFAULTS, classifier: 'agent', samples: 1 },
      {
        env: { SENTRA_REPLAY: '1' },
        transport,
      },
    )

  const snapshotOf = (run: Evaluation): MetricsSnapshot =>
    snapshot(run.metrics, quadrantBreakdown(run.fixtures.map((f) => f.judgement)), {
      classifier: 'agent',
      promptVersion: run.classifier.promptVersion,
      slice: 'dev',
      datasetRevision: run.datasetRevision,
      selfConsistency: null,
      costPerFixtureUsd: gatedCost(run),
    })

  const gate = (run: Evaluation, mainCost: number) =>
    check(
      runGate({
        current: snapshotOf(run),
        reference: at(0.2, { costPerFixtureUsd: mainCost }),
        unpricedModels: run.cost.unpricedModels,
      }),
      'cost-per-fixture',
    )

  it('records what each fixture was billed', async () => {
    // 1,000 in at $4/M and 200 out at $20/M, one sample a fixture.
    expect(gatedCost(await scored(answering()))).toBeCloseTo(0.008, 10)
  })

  it('passes a run that costs what main recorded', async () => {
    expect(gate(await scored(answering()), 0.008)?.status).toBe('pass')
  })

  it('blocks a run that costs more than half as much again as main', async () => {
    const result = gate(await scored(answering()), 0.005)
    expect(result?.status).toBe('fail')
    expect(result?.detail).toContain('$0.0080 now, $0.0050 on main')
  })

  /** Every fixture answered on the second try: twice the bill for the same verdicts. */
  it('counts the answers the schema rejected, so a retrying prompt cannot pass as cheap', async () => {
    const run = await scored(answering({ retrying: true }))
    expect(gatedCost(run)).toBeCloseTo(0.016, 10)
    expect(run.cost.unused.usd).toBeCloseTo(run.cost.usd / 2, 10)
    expect(gate(run, 0.008)?.status).toBe('fail')
  })

  it('fails a run on a model the price table does not know', async () => {
    const run = await scored(answering({ model: 'claude-unreleased-9' }))
    expect(gatedCost(run)).toBe(0)
    expect(gate(run, 0.008)?.status).toBe('fail')
  })
})

describe('the report', () => {
  it('covers every threshold in the methodology table', () => {
    expect(
      runGate({ current: at(0.2), reference: null })
        .checks.map((c) => c.id)
        .sort(),
    ).toEqual([
      'beats-baseline',
      'cost-per-fixture',
      'hard-quadrant-floor',
      'joint-accuracy-floor',
      'joint-accuracy-regression',
      'self-consistency',
    ])
  })

  it('lists skipped checks rather than hiding them', () => {
    // A gate that silently omits what it did not check reads as a gate that
    // checked everything.
    const rendered = renderGateReport(runGate({ current: at(0.2), reference: null }))
    expect(rendered.match(/skip/g)).toHaveLength(6)
  })

  it('tells a reader what to do when a threshold is crossed', () => {
    const rendered = renderGateReport(runGate({ current: at(0.1), reference: at(0.3) }))
    expect(rendered).toContain('FAIL')
    expect(rendered).toContain('eval/gate.ts')
    expect(rendered).toContain('reviewable')
  })

  it('says nothing extra when everything passes', () => {
    expect(renderGateReport(runGate({ current: at(0.3), reference: at(0.3) }))).not.toContain(
      'FAIL',
    )
  })
})

// ---------------------------------------------------------------------------

describe('the snapshot', () => {
  const current = snapshot(
    evaluation.metrics,
    quadrantBreakdown(evaluation.fixtures.map((f) => f.judgement)),
    {
      classifier: 'baseline',
      promptVersion: null,
      slice: 'dev',
      datasetRevision: evaluation.datasetRevision,
      selfConsistency: null,
      costPerFixtureUsd: null,
    },
  )

  it('validates against its own schema', () => {
    expect(MetricsSnapshotSchema.safeParse(current).success).toBe(true)
  })

  it('carries the hard quadrant separately from the headline', () => {
    expect(current.hardQuadrant.support).toBeGreaterThan(0)
    expect(current.hardQuadrant.point).not.toBe(current.joint.point)
  })

  it('records nulls rather than zeros for what is not measured', () => {
    // Zero self-consistency and zero cost are claims. Absent is the truth, and
    // the gate skips on null while it would fail on zero.
    expect(current.selfConsistency).toBeNull()
    expect(current.costPerFixtureUsd).toBeNull()
  })

  it('matches the file on disk, so the gate reads current numbers', () => {
    // The report has its own freshness check; this is the same guarantee for the
    // half the gate actually parses. A stale snapshot would let a regression
    // compare against itself and pass.
    expect(JSON.parse(readFileSync(METRICS_PATHS.dev, 'utf8'))).toEqual(current)
  })
})

describe('reading a reference', () => {
  it('returns null for a ref that has no snapshot', () => {
    expect(
      readReferenceSnapshot(METRICS_PATHS.dev, 'refs/tags/definitely-not-a-real-ref'),
    ).toBeNull()
  })

  it('returns null for a path that does not exist on the ref', () => {
    expect(readReferenceSnapshot('eval/no-such-file.json', 'HEAD')).toBeNull()
  })
})
