import { readFileSync } from 'node:fs'
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
import { DEFAULTS, evaluate, METRICS_PATHS } from './run-eval.js'

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
      expect(result?.detail).toContain('Enforced from M3')
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
    expect(result?.detail).toContain('#36')
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
