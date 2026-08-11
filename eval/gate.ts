import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import type { Metrics } from './metrics.js'
import type { QuadrantRow } from './confusion.js'

/**
 * The merge gate.
 *
 * It exists to stop a plausible-sounding prompt change from quietly making
 * things worse. It also has to survive contact with reality: a gate that fires
 * on noise gets switched off by whoever is on call at the time, and a gate that
 * is off is worse than one that never existed, because everybody still believes
 * it is there.
 *
 * Three properties follow from that.
 *
 * **Comparisons use interval lower bounds, never point estimates.** At n=22 a
 * point estimate moves several percentage points between two classifiers that
 * are indistinguishable. Gating on the lower bound means the gate fires when the
 * evidence supports a regression, not when the dice do.
 *
 * **Thresholds start permissive.** The methodology says so, and the numbers here
 * are the ones from its table rather than tighter guesses.
 *
 * **A check that cannot mean anything yet is skipped out loud.** Several
 * thresholds in the methodology are targets for the finished agent, and the
 * baseline misses them by a wide margin — the joint-accuracy floor of 0.65
 * against a measured lower bound of 0.197, the hard-quadrant floor of 0.50
 * against 0.097. Enabling those today would make `main` permanently red, which
 * teaches everyone to merge past a red gate. They are implemented, listed in
 * every run's output, and report the condition that will switch them on.
 */

export type Classifier = 'baseline' | 'agent'

/**
 * Every threshold from the table in docs/eval-methodology.md, in one place.
 *
 * Changing a number here changes what is allowed to merge, so each carries the
 * reason it has the value it does. Ratcheting means editing this file in a
 * reviewable commit, not adjusting a constant at a call site.
 */
export const THRESHOLDS = {
  /**
   * How far joint accuracy's lower bound may fall below the value recorded on
   * `main` before the merge is blocked.
   *
   * 5pp is wide. It is meant to be: at n=22 the interval itself is ±19pp, so a
   * tighter bound would fire on fixtures being added rather than on the
   * classifier changing. It tightens as the dataset grows towards 60.
   */
  jointAccuracyRegressionPp: 0.05,

  /**
   * Absolute floor on joint accuracy's lower bound.
   *
   * A target for the agent, not a description of the baseline. Below roughly
   * two thirds, a classification is not worth the developer attention it costs
   * to read.
   */
  jointAccuracyFloor: 0.65,

  /**
   * Floor on accuracy within `app_code + intermittent`.
   *
   * The quadrant the project exists for. A classifier that scores well overall
   * by getting the easy quadrants right has not done the job, so this is gated
   * separately rather than averaged into the headline.
   */
  hardQuadrantFloor: 0.5,

  /**
   * Floor on how often the same fixture gets the same label across samples.
   *
   * A classifier that is accurate on average and unstable per fixture cannot be
   * trusted at the level of an individual pull request comment, which is the
   * only level at which anyone reads it.
   */
  selfConsistencyFloor: 0.8,

  /** Proportional rise in cost per fixture that blocks a merge. */
  costIncrease: 0.5,
} as const

// ---------------------------------------------------------------------------
// The snapshot the gate compares
// ---------------------------------------------------------------------------

export interface Interval {
  point: number
  lower: number
  upper: number
}

/**
 * The machine-readable half of a run, committed next to the report.
 *
 * Separate from `report.md` because the gate has to read the values recorded on
 * `main`, and parsing prose for numbers is a way of turning a formatting change
 * into a silent gate failure.
 */
export interface MetricsSnapshot {
  version: 1
  classifier: Classifier
  slice: string
  datasetRevision: string
  n: number
  joint: Interval
  owner: Interval & { macroF1: number }
  determinism: Interval & { macroF1: number }
  hardQuadrant: Interval & { support: number; correct: number }
  /** Null until sampling exists — the baseline is deterministic (#36). */
  selfConsistency: number | null
  /** Null until a model is involved (#30). */
  costPerFixtureUsd: number | null
}

const IntervalSchema = z.object({
  point: z.number().min(0).max(1),
  lower: z.number().min(0).max(1),
  upper: z.number().min(0).max(1),
})

export const MetricsSnapshotSchema = z
  .object({
    version: z.literal(1),
    classifier: z.enum(['baseline', 'agent']),
    slice: z.string(),
    datasetRevision: z.string(),
    n: z.number().int().nonnegative(),
    joint: IntervalSchema,
    owner: IntervalSchema.extend({ macroF1: z.number() }),
    determinism: IntervalSchema.extend({ macroF1: z.number() }),
    hardQuadrant: IntervalSchema.extend({
      support: z.number().int().nonnegative(),
      correct: z.number().int().nonnegative(),
    }),
    selfConsistency: z.number().min(0).max(1).nullable(),
    costPerFixtureUsd: z.number().nonnegative().nullable(),
  })
  .strict()

/**
 * The values recorded on another git ref, or null when that ref has none.
 *
 * A missing file is an ordinary state — the first run, or a branch older than
 * this feature — and yields null so the comparison is skipped rather than
 * failed. A file that exists but does not parse is a different thing entirely
 * and throws: silently treating a corrupt reference as "no reference" would
 * disable the gate exactly when something is wrong.
 */
export function readReferenceSnapshot(path: string, ref = 'origin/main'): MetricsSnapshot | null {
  let raw: string
  try {
    raw = execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }

  const parsed = MetricsSnapshotSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    throw new Error(
      `${ref}:${path} exists but is not a valid metrics snapshot: ` +
        `${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`,
    )
  }
  return parsed.data
}

const interval = (p: { point: number; interval: { lower: number; upper: number } }): Interval => ({
  point: p.point,
  lower: p.interval.lower,
  upper: p.interval.upper,
})

export function snapshot(
  metrics: Metrics,
  quadrants: readonly QuadrantRow[],
  context: { classifier: Classifier; slice: string; datasetRevision: string },
): MetricsSnapshot {
  const hard = quadrants.find((q) => q.hard)

  return {
    version: 1,
    classifier: context.classifier,
    slice: context.slice,
    datasetRevision: context.datasetRevision,
    n: metrics.n,
    joint: interval(metrics.joint),
    owner: { ...interval(metrics.owner.accuracy), macroF1: metrics.owner.macroF1 },
    determinism: {
      ...interval(metrics.determinism.accuracy),
      macroF1: metrics.determinism.macroF1,
    },
    hardQuadrant: {
      ...interval(hard?.accuracy ?? { point: 0, interval: { lower: 0, upper: 1 } }),
      support: hard?.support ?? 0,
      correct: hard?.correct ?? 0,
    },
    selfConsistency: null,
    costPerFixtureUsd: null,
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export interface CheckResult {
  id: string
  /** What is being gated, in the words the report uses. */
  metric: string
  status: CheckStatus
  /** Names both values and the threshold, so the failure is actionable without a rerun. */
  detail: string
}

export interface GateInput {
  current: MetricsSnapshot
  /** The values recorded on `main`, or null on the first run and on `main` itself. */
  reference: MetricsSnapshot | null
  /** Present once both classifiers are scored — the delta is the project's headline. */
  baseline?: MetricsSnapshot | null
}

export interface GateReport {
  checks: CheckResult[]
  failed: boolean
}

const pp = (n: number): string => `${(n * 100).toFixed(1)}pp`

export function runGate(input: GateInput): GateReport {
  const checks = [
    jointRegression(input),
    jointFloor(input),
    hardQuadrantFloor(input),
    beatsBaseline(input),
    selfConsistency(input),
    cost(input),
  ]
  return { checks, failed: checks.some((c) => c.status === 'fail') }
}

function jointRegression({ current, reference }: GateInput): CheckResult {
  const id = 'joint-accuracy-regression'
  const metric = 'joint accuracy (lower bound) against main'

  if (reference === null) {
    return { id, metric, status: 'skipped', detail: 'no metrics recorded on main to compare with' }
  }
  if (reference.slice !== current.slice) {
    // Comparing a dev number with a held-out one would fire on the slice
    // changing rather than on the classifier changing.
    return {
      id,
      metric,
      status: 'skipped',
      detail: `main recorded the \`${reference.slice}\` slice, this run scored \`${current.slice}\``,
    }
  }

  const allowed = reference.joint.lower - THRESHOLDS.jointAccuracyRegressionPp
  const detail =
    `${pp(current.joint.lower)} now, ${pp(reference.joint.lower)} on main ` +
    `(allowed down to ${pp(allowed)}, a drop of ${pp(THRESHOLDS.jointAccuracyRegressionPp)})`

  return { id, metric, status: current.joint.lower >= allowed ? 'pass' : 'fail', detail }
}

function jointFloor({ current }: GateInput): CheckResult {
  const id = 'joint-accuracy-floor'
  const metric = 'joint accuracy (lower bound) against the absolute floor'
  const skip = agentOnly(current.classifier, THRESHOLDS.jointAccuracyFloor, current.joint.lower)
  if (skip !== null) return { id, metric, ...skip }

  return {
    id,
    metric,
    status: current.joint.lower >= THRESHOLDS.jointAccuracyFloor ? 'pass' : 'fail',
    detail: `${pp(current.joint.lower)} against a floor of ${pp(THRESHOLDS.jointAccuracyFloor)}`,
  }
}

function hardQuadrantFloor({ current }: GateInput): CheckResult {
  const id = 'hard-quadrant-floor'
  const metric = '`app_code` + `intermittent` accuracy (lower bound)'
  const skip = agentOnly(
    current.classifier,
    THRESHOLDS.hardQuadrantFloor,
    current.hardQuadrant.lower,
  )
  if (skip !== null) return { id, metric, ...skip }

  if (current.hardQuadrant.support === 0) {
    return { id, metric, status: 'skipped', detail: 'no hard-quadrant fixtures in this slice' }
  }

  return {
    id,
    metric,
    status: current.hardQuadrant.lower >= THRESHOLDS.hardQuadrantFloor ? 'pass' : 'fail',
    detail:
      `${pp(current.hardQuadrant.lower)} over ${String(current.hardQuadrant.support)} fixtures, ` +
      `against a floor of ${pp(THRESHOLDS.hardQuadrantFloor)}`,
  }
}

/**
 * An absolute floor the baseline is nowhere near is a target, not a gate.
 *
 * Enabling it now would make `main` permanently red on a fact everybody already
 * knows, and a permanently red gate is one people learn to merge past. The check
 * still runs and still prints, so the distance to the target stays visible.
 */
function agentOnly(
  classifier: Classifier,
  floor: number,
  observed: number,
): Pick<CheckResult, 'status' | 'detail'> | null {
  if (classifier === 'agent') return null
  return {
    status: 'skipped',
    detail:
      `a target for the agent, not the baseline — currently ${pp(observed)} against ` +
      `${pp(floor)}. Enforced from M3, when \`--classifier=agent\` runs (#35).`,
  }
}

function beatsBaseline({ current, baseline }: GateInput): CheckResult {
  const id = 'beats-baseline'
  const metric = 'agent joint accuracy against the baseline on the same fixtures'

  if (current.classifier !== 'agent') {
    return { id, metric, status: 'skipped', detail: 'this run scored the baseline itself' }
  }
  if (baseline === null || baseline === undefined) {
    return { id, metric, status: 'skipped', detail: 'no baseline scored alongside this run' }
  }

  return {
    id,
    metric,
    status: current.joint.lower >= baseline.joint.lower ? 'pass' : 'fail',
    detail:
      `agent ${pp(current.joint.lower)}, baseline ${pp(baseline.joint.lower)} — ` +
      'any regression against the control blocks, since the delta is the result this project reports',
  }
}

function selfConsistency({ current }: GateInput): CheckResult {
  const id = 'self-consistency'
  const metric = 'label stability across samples'

  if (current.selfConsistency === null) {
    return {
      id,
      metric,
      status: 'skipped',
      detail:
        'not measured — the baseline is deterministic, so sampling means nothing until a model ' +
        'is involved. Enforced from M3 (#36).',
    }
  }

  return {
    id,
    metric,
    status: current.selfConsistency >= THRESHOLDS.selfConsistencyFloor ? 'pass' : 'fail',
    detail: `${pp(current.selfConsistency)} against a floor of ${pp(THRESHOLDS.selfConsistencyFloor)}`,
  }
}

function cost({ current, reference }: GateInput): CheckResult {
  const id = 'cost-per-fixture'
  const metric = 'cost per fixture against main'

  if (current.costPerFixtureUsd === null) {
    return {
      id,
      metric,
      status: 'skipped',
      detail: 'no model call, so no cost. Enforced from M3 (#30).',
    }
  }
  if (reference?.costPerFixtureUsd == null) {
    return { id, metric, status: 'skipped', detail: 'no cost recorded on main to compare with' }
  }

  const allowed = reference.costPerFixtureUsd * (1 + THRESHOLDS.costIncrease)
  return {
    id,
    metric,
    status: current.costPerFixtureUsd <= allowed ? 'pass' : 'fail',
    detail:
      `$${current.costPerFixtureUsd.toFixed(4)} now, $${reference.costPerFixtureUsd.toFixed(4)} on main ` +
      `(allowed up to $${allowed.toFixed(4)}, +${String(THRESHOLDS.costIncrease * 100)}%)`,
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const MARK: Record<CheckStatus, string> = { pass: 'pass', fail: 'FAIL', skipped: 'skip' }

export function renderGateReport(report: GateReport): string {
  const lines = report.checks.map(
    (c) => `  ${MARK[c.status].padEnd(5)} ${c.metric}\n        ${c.detail}`,
  )

  const failed = report.checks.filter((c) => c.status === 'fail')
  if (failed.length > 0) {
    lines.push(
      '',
      `  ${String(failed.length)} threshold(s) crossed. The numbers above come from this run and`,
      '  from the metrics recorded on main; neither is an estimate of the other.',
      '',
      '  If the change is a deliberate trade, say so in the pull request and move the',
      '  threshold in eval/gate.ts in the same commit, so the decision is reviewable.',
    )
  }

  return lines.join('\n')
}
