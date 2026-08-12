import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { format } from 'prettier'
import type { FixtureLabels } from '@sentra/contracts'
import { cost, formatUsd, MODEL_CONFIG, type Cost } from '@sentra/agents'
import {
  calibrate,
  deriveThreshold,
  judge,
  MIN_SUPPORT,
  TARGET_ACCURACY,
  type Calibration,
  type Point,
  type Threshold,
  type Verdict,
} from './calibration.js'
import { chooseClassifier, type ClassifierContext, type ClassifierDeps } from './classifier.js'
import { consensus, summarise, type Prediction, type SamplingSummary } from './consistency.js'
import {
  confusionMatrix,
  markdownTable,
  quadrantBreakdown,
  renderBreakdownSections,
  renderConfusionMatrix,
  renderQuadrantTable,
  type ScoredFixture,
} from './confusion.js'
import { DATASET_DIR, listFixtures, loadLabels, loadPayload } from './dataset.js'
import { readReferenceSnapshot, renderGateReport, runGate, snapshot } from './gate.js'
import { formatProportion, score, type Metrics } from './metrics.js'
import {
  appendHoldoutRun,
  consultsHoldout,
  emptyHoldoutBuckets,
  HOLDOUT_LOG,
  HOLDOUT_SHARE,
  inSlice,
  isoDate,
  lastEvaluated,
  overuse,
  overuseWarning,
  readHoldoutLog,
  sliceComposition,
  type Overuse,
  type SliceComposition,
  type SliceSelector,
} from './slices.js'

/**
 * `npm run eval` — scores a classifier over the golden dataset and writes
 * `eval/report.md`.
 *
 * The report is a deliverable, not a log. Somebody should be able to open it
 * cold and answer two questions: how good is this classifier, and how much
 * should I trust the number. Everything here serves the second question as much
 * as the first.
 *
 * Committed on purpose, so a regression arrives as a reviewable diff rather than
 * as a line scrolling past in CI. `--gate` is what keeps that true: it
 * regenerates in memory and fails if the committed file disagrees.
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface Options {
  classifier: 'baseline' | 'agent'
  slice: SliceSelector
  samples: number
  /** Verify the committed report is current, and hold the numbers to the thresholds. */
  gate: boolean
  out: string
  /** Git ref holding the metrics a regression is measured against. */
  reference: string
}

/**
 * Where each slice's report lands.
 *
 * Separate files rather than one, so the committed dev report — the one
 * `--gate` checks on every pull request — never contains a held-out number. A
 * single file would have to be regenerated from whichever slice ran last, and
 * the gate could not tell an out-of-date report from a differently-sliced one.
 */
export const REPORT_PATHS: Record<SliceSelector, string> = {
  dev: 'eval/report.md',
  holdout: 'eval/holdout-report.md',
  all: 'eval/report-all.md',
}

/**
 * The machine-readable half, written beside each report.
 *
 * The gate has to read the values recorded on `main`, and parsing prose for
 * numbers turns a formatting change into a silent gate failure. Two artefacts
 * for one run is the cost of not having a regex over a markdown table decide
 * what merges.
 */
export const METRICS_PATHS: Record<SliceSelector, string> = {
  dev: 'eval/metrics.json',
  holdout: 'eval/holdout-metrics.json',
  all: 'eval/metrics-all.json',
}

/**
 * The default slice is `dev`, not `all`.
 *
 * This is the whole discipline in one line. Anything that runs habitually — the
 * CI gate, a local check before pushing — must not touch the held-out fixtures,
 * or they stop being held out.
 */
export const DEFAULTS: Options = {
  classifier: 'baseline',
  slice: 'dev',
  samples: 1,
  gate: false,
  out: REPORT_PATHS.dev,
  reference: 'origin/main',
}

/** Capabilities the CLI accepts but cannot do yet, with the issue that will land them. */
const NOT_YET: Record<string, { what: string; milestone: string; issue: number }> = {}

export class UsageError extends Error {}

/**
 * Parse `--flag=value` arguments.
 *
 * Unknown flags are an error rather than being ignored. A silently dropped
 * `--slice=holdout` would report the full dataset under a heading claiming
 * otherwise, which is the one failure mode this whole file exists to prevent.
 */
export function parseArgs(argv: string[]): Options {
  const options: Options = { ...DEFAULTS }
  let outWasGiven = false
  let samplesWereGiven = false

  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (match === null) throw new UsageError(`unexpected argument "${arg}"`)
    const [, flag = '', value] = match

    switch (flag) {
      case 'classifier':
        options.classifier = expect(flag, value, ['baseline', 'agent'])
        break
      case 'slice':
        options.slice = expect(flag, value, ['dev', 'holdout', 'all'])
        break
      case 'n':
      case 'samples':
        options.samples = wholeNumber(flag, value)
        samplesWereGiven = true
        break
      case 'gate':
        options.gate = true
        break
      case 'reference':
        if (value === undefined || value === '') throw new UsageError(`--reference needs a git ref`)
        options.reference = value
        break
      case 'out':
        if (value === undefined || value === '') throw new UsageError(`--out needs a path`)
        options.out = value
        outWasGiven = true
        break
      default:
        throw new UsageError(`unknown flag "--${flag}"`)
    }
  }

  // Resolved after the loop, not inside it, so `--out=x --slice=holdout` and
  // `--slice=holdout --out=x` mean the same thing.
  if (!outWasGiven) options.out = REPORT_PATHS[options.slice]
  if (!samplesWereGiven) options.samples = DEFAULT_SAMPLES[options.classifier]

  return options
}

/**
 * How many times each fixture is classified, by default.
 *
 * Five for the agent, because there is no temperature to pin and a single run
 * cannot tell a prompt improvement from the same prompt run twice. One for the
 * baseline, which is a pure function — five identical runs would cost time and
 * report a self-consistency of 1 that says nothing about anything.
 *
 * The same in every mode, including replay. The issue proposed defaulting to one
 * under replay to keep a demo quick; that would make the committed report
 * unreproducible in CI, since the gate regenerates it from the defaults and would
 * find a one-sample run disagreeing with a five-sample file. Replaying five
 * cassettes costs nothing but disk, so there was nothing to save.
 */
export const DEFAULT_SAMPLES: Record<Options['classifier'], number> = {
  baseline: 1,
  agent: 5,
}

function expect<T extends string>(flag: string, value: string | undefined, allowed: T[]): T {
  if (value === undefined || !allowed.includes(value as T)) {
    throw new UsageError(`--${flag} must be one of ${allowed.join(' | ')}, got "${value ?? ''}"`)
  }
  return value as T
}

function wholeNumber(flag: string, value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`--${flag} must be a whole number of 1 or more, got "${value ?? ''}"`)
  }
  return parsed
}

/** Reject a request the CLI understands but cannot yet serve. Returns the message, or null. */
export function unsupported(options: Options): string | null {
  for (const key of [`classifier=${options.classifier}`, `slice=${options.slice}`]) {
    const pending = NOT_YET[key]
    if (pending !== undefined) {
      return [
        `${pending.what} is not implemented yet.`,
        '',
        `Lands in milestone ${pending.milestone}, tracked in`,
        `https://github.com/AKogut/ai-flaky-test-triage/issues/${String(pending.issue)}`,
        '',
        'What works today: npm run eval -- --classifier=baseline --slice=all',
      ].join('\n')
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * A scored fixture plus what the report needs and the metrics do not.
 *
 * Extends `ScoredFixture` rather than replacing it so the breakdown renderers
 * keep taking the smaller type — they have no business seeing a confidence
 * score, and nothing downstream of them can start depending on one.
 */
export interface EvaluatedFixture extends ScoredFixture {
  payloadHash: string
  /** Mean across samples — one sample's number would be arbitrary. */
  confidence: number
  /** From the first sample. Averaging prose is not a thing. */
  reasoning: string
  /** Every sample this fixture produced, in order. */
  samples: Prediction[]
  /** Share of samples that agreed with the consensus label. */
  stability: number
}

/** Read from the committed log, and only present on a run that looked at held-out fixtures. */
export interface HoldoutContext {
  lastEvaluated: string | null
  overuse: Overuse
}

export interface Evaluation {
  options: Options
  fixtures: EvaluatedFixture[]
  /** Which prompt, and whether the run touched the network. */
  classifier: ClassifierContext
  /** Mean single-run accuracy, its spread, and which fixtures flipped. */
  sampling: SamplingSummary
  /** Whether the stated confidence is worth anything, and what follows if it is. */
  calibration: Calibration
  threshold: Threshold
  verdict: Verdict
  /** Tokens and dollars. Zero everywhere for the baseline, which makes no calls. */
  cost: Cost
  metrics: Metrics
  /** How the whole dataset divides between the slices, whichever slice ran. */
  composition: SliceComposition[]
  datasetRevision: string
  holdout?: HoldoutContext
}

/**
 * Identity of the exact data a number was computed from.
 *
 * Covers labels as well as payloads: an edited justification does not move a
 * metric, but an edited `owner` silently moves all of them, and a report that
 * cannot tell those apart is not auditable.
 */
export function datasetRevision(fixtures: EvaluatedFixture[]): string {
  const hash = createHash('sha256')
  for (const fixture of fixtures) {
    hash.update(`${fixture.judgement.name}:${fixture.payloadHash}:${labelDigest(fixture.labels)}\n`)
  }
  return hash.digest('hex').slice(0, 16)
}

const labelDigest = (labels: FixtureLabels): string =>
  `${labels.owner}/${labels.determinism}/${labels.bucket}/${labels.provenance}/${String(labels.lowConfidenceGroundTruth)}`

/**
 * Score a classifier over a slice.
 *
 * Sequential on purpose. Concurrency would buy wall-clock on the agent path and
 * cost the two things this function exists to provide: a deterministic order for
 * the token budget to run out in, and a report whose per-fixture rows are in the
 * same order on every run. A dataset of this size is not where latency matters.
 */
export async function evaluate(options: Options, deps: ClassifierDeps = {}): Promise<Evaluation> {
  const every = listFixtures().map((name) => ({ name, bucket: loadLabels(name).bucket }))
  const chosen = chooseClassifier(options.classifier, deps)

  const fixtures: EvaluatedFixture[] = []
  for (const name of listFixtures().filter((n) => inSlice(n, options.slice))) {
    const { payload, hash } = loadPayload(name)
    const labels = loadLabels(name)

    // Sample-major per fixture rather than run-major over the dataset: a budget
    // that runs out then leaves whole fixtures unscored instead of leaving every
    // fixture with a different number of samples, which nothing downstream could
    // interpret.
    const samples: Prediction[] = []
    let reasoning = ''
    for (let sample = 0; sample < options.samples; sample++) {
      const predicted = await chosen.classify(payload, sample)
      samples.push({
        owner: predicted.owner,
        determinism: predicted.determinism,
        confidence: predicted.confidence,
      })
      if (sample === 0) reasoning = predicted.reasoning
    }

    const agreed = consensus(samples)
    fixtures.push({
      judgement: {
        name,
        predicted: { owner: agreed.owner, determinism: agreed.determinism },
        actual: { owner: labels.owner, determinism: labels.determinism },
      },
      labels,
      payloadHash: hash,
      confidence: agreed.confidence,
      reasoning,
      samples,
      stability: agreed.stability,
    })
  }

  const headline = fixtures.filter((f) => !f.labels.lowConfidenceGroundTruth)

  return {
    options,
    fixtures,
    classifier: chosen.context,
    sampling: summarise(
      headline.map((f) => ({
        name: f.judgement.name,
        samples: f.samples,
        actual: f.judgement.actual,
      })),
    ),
    cost: cost(chosen.usage),
    ...calibrationOf(headline),
    metrics: score(headline.map((f) => f.judgement)),
    // Over the whole dataset, not the slice being scored, so the dev report can
    // say what is being withheld from it.
    composition: sliceComposition(every),
    datasetRevision: datasetRevision(fixtures),
  }
}

/**
 * Every prediction the run produced, as a confidence and a verdict.
 *
 * One point per sample rather than per fixture: with sampling, each sample is a
 * classification the pipeline could have emitted, and each carries its own
 * stated confidence. Fixtures with arguable ground truth are already excluded by
 * the caller — a calibration measured against a label the project itself is
 * unsure of would be measuring the dataset.
 */
function calibrationOf(fixtures: readonly EvaluatedFixture[]): {
  calibration: Calibration
  threshold: Threshold
  verdict: Verdict
} {
  const points: Point[] = fixtures.flatMap((fixture) =>
    fixture.samples.map((sample) => ({
      confidence: sample.confidence,
      correct:
        sample.owner === fixture.judgement.actual.owner &&
        sample.determinism === fixture.judgement.actual.determinism,
    })),
  )

  const calibration = calibrate(points)
  const threshold = deriveThreshold(points)
  return { calibration, threshold, verdict: judge(calibration, threshold) }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const NOT_MEASURED = '—'

export function renderReport(evaluation: Evaluation): string {
  const { options, metrics, fixtures } = evaluation
  const judgements = fixtures
    .filter((f) => !f.labels.lowConfidenceGroundTruth)
    .map((f) => f.judgement)

  return [
    '# Evaluation report',
    '',
    '> Generated by `npm run eval`. Do not edit by hand — the next run overwrites it.',
    '',
    renderProvenance(evaluation),
    '',
    '## Headline',
    '',
    renderHeadline(metrics),
    '',
    '## Stability',
    '',
    renderStability(evaluation),
    '',
    '## Calibration',
    '',
    renderCalibration(evaluation),
    '',
    '## Per quadrant',
    '',
    renderQuadrantTable(quadrantBreakdown(judgements)),
    '',
    '## Confusion matrices',
    '',
    '### `owner`',
    '',
    renderConfusionMatrix(confusionMatrix(judgements, 'owner')),
    '',
    '### `determinism`',
    '',
    renderConfusionMatrix(confusionMatrix(judgements, 'determinism')),
    '',
    '## Per class',
    '',
    renderPerClass(metrics),
    '',
    '## Breakdowns',
    '',
    renderBreakdownSections(fixtures),
    '',
    '## Slices',
    '',
    renderSlices(evaluation),
    '',
    ...(evaluation.holdout === undefined
      ? []
      : ['## Held-out usage', '', renderHoldoutUsage(evaluation.holdout), '']),
    '## Every fixture',
    '',
    renderPerFixture(fixtures),
    '',
    '## How to read this',
    '',
    HOW_TO_READ(options),
    '',
  ].join('\n')
}

/**
 * What repeated sampling says, and what the headline above is therefore not.
 *
 * The headline is scored on the consensus label, which keeps every count in this
 * report meaning one fixture — support, confusion cells, quadrant recall. But
 * the shipped pipeline classifies once, so the number a pull-request comment
 * actually gets is the single-run mean, and it belongs on the page rather than
 * in a footnote. The gap between the two is the price of instability.
 */
/**
 * Whether the confidence number means anything, said in words first.
 *
 * The words lead because they are the part that changes what anybody does. A
 * reliability table is only actionable once someone has decided whether the
 * column it is built on carries information, and that decision belongs on the
 * page rather than in the reader.
 */
function renderCalibration(evaluation: Evaluation): string {
  const { calibration, threshold, verdict } = evaluation

  const headline = [
    `**${LABEL[verdict.usability]}** ${verdict.summary}`,
    '',
    markdownTable(
      ['', ''],
      [
        ['predictions scored', String(calibration.n)],
        ['distinct confidence values', String(calibration.distinctValues)],
        [
          'discrimination (AUROC)',
          calibration.discrimination === null
            ? `${NOT_MEASURED} — every prediction landed the same way`
            : `${calibration.discrimination.toFixed(3)} — 0.50 is a coin toss`,
        ],
        ['expected calibration error', calibration.ece.toFixed(3)],
        ['worst single bin', calibration.mce.toFixed(3)],
        [
          'derived root-cause threshold',
          threshold.value === null
            ? `not derived — ${threshold.reason}`
            : threshold.value.toFixed(2),
        ],
      ],
      ['left', 'left'],
    ),
  ]

  const populated = calibration.bins.filter((bin) => bin.count > 0)
  const curve =
    populated.length === 0
      ? ['No predictions to bin.']
      : [
          '### Reliability curve',
          '',
          'Stated confidence against observed accuracy. A perfectly calibrated classifier has the',
          'two columns equal in every row. Empty bins are omitted; where the classifier never says',
          '0.3, there is nothing to be right or wrong about.',
          '',
          markdownTable(
            ['confidence', 'predictions', 'stated', 'observed', 'gap'],
            populated.map((bin) => [
              `${bin.lower.toFixed(1)}–${bin.upper.toFixed(1)}`,
              String(bin.count),
              bin.meanConfidence.toFixed(3),
              bin.accuracy.toFixed(3),
              signed(bin.accuracy - bin.meanConfidence),
            ]),
            ['left', 'right', 'right', 'right', 'right'],
          ),
        ]

  const derivation =
    threshold.sweep.length === 0
      ? []
      : [
          '',
          '### Deriving the threshold',
          '',
          `Each confidence value the classifier produced, with the accuracy of every prediction at`,
          `or above it. The threshold is the lowest value clearing ${(TARGET_ACCURACY * 100).toFixed(0)}% over at least`,
          `${String(MIN_SUPPORT)} predictions — lower is better, because the point is to run the root-cause agent on`,
          'everything it can be right about, and a higher bar buys accuracy by answering less often.',
          '',
          markdownTable(
            ['threshold', 'predictions at or above', 'accuracy', ''],
            threshold.sweep.map((row) => [
              row.threshold.toFixed(2),
              String(row.count),
              `${(row.accuracy * 100).toFixed(1)}%`,
              row.threshold === threshold.value ? '**chosen**' : row.eligible ? 'eligible' : '',
            ]),
            ['right', 'right', 'right', 'left'],
          ),
        ]

  return [...headline, '', ...curve, ...derivation].join('\n')
}

const LABEL: Record<Verdict['usability'], string> = {
  unusable: 'Confidence is not usable.',
  weak: 'Confidence is weakly informative.',
  usable: 'Confidence is usable.',
}

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(3)}`

function renderStability(evaluation: Evaluation): string {
  const { sampling, cost: spend, options } = evaluation

  if (sampling.samples <= 1) {
    return [
      `Scored once per fixture (\`--n=1\`), so there is no spread to report.`,
      '',
      options.classifier === 'baseline'
        ? 'The baseline is a pure function: repeating it produces identical runs, and a self-consistency of 1 would say nothing about anything.'
        : 'Re-run with `--n=5` to measure how much a single classification moves.',
    ].join('\n')
  }

  const rows: string[][] = [
    ['samples per fixture', String(sampling.samples)],
    ['consensus joint accuracy', formatProportion(evaluation.metrics.joint)],
    [
      'single-run joint accuracy',
      `${share(sampling.meanJoint)} ± ${share(sampling.sdJoint)} — what one comment gets`,
    ],
    ['self-consistency', `${share(sampling.selfConsistency)} of samples agreed with the consensus`],
    [
      'fixtures that flipped',
      `${String(sampling.unstable.length)} of ${String(evaluation.metrics.n)}`,
    ],
  ]

  const flips =
    sampling.unstable.length === 0
      ? ['Every fixture gave the same answer on every sample.']
      : [
          'Fixtures that gave more than one answer, least stable first. These are where a',
          'single-run number and a consensus number disagree, and where a reader of one PR',
          'comment is being told something the next run would contradict.',
          '',
          markdownTable(
            ['fixture', 'stability', 'labels seen'],
            sampling.unstable.map((row) => [
              `\`${row.name}\``,
              share(row.stability),
              row.labels.map((label) => `\`${label}\``).join(', '),
            ]),
            ['left', 'right', 'left'],
          ),
        ]

  const spendRows: string[] =
    spend.inputTokens + spend.outputTokens === 0
      ? []
      : [
          '',
          '### Cost',
          '',
          markdownTable(
            ['', ''],
            [
              ['input tokens', String(spend.inputTokens)],
              ['output tokens', String(spend.outputTokens)],
              ['total', formatUsd(spend.usd)],
              [
                'per fixture',
                `${formatUsd(spend.usd / Math.max(1, evaluation.fixtures.length))} at ${String(sampling.samples)} sample(s) each`,
              ],
              [
                'projected, 50-failure CI run',
                formatUsd((spend.usd / Math.max(1, evaluation.fixtures.length)) * 50),
              ],
              ...(spend.unpricedModels.length === 0
                ? []
                : [['unpriced models', spend.unpricedModels.join(', ')]]),
            ],
            ['left', 'right'],
          ),
        ]

  return [markdownTable(['', ''], rows, ['left', 'left']), '', ...flips, ...spendRows].join('\n')
}

const share = (value: number): string => `${(value * 100).toFixed(1)}%`

function renderProvenance(evaluation: Evaluation): string {
  const { options, fixtures, datasetRevision: revision } = evaluation
  const excluded = fixtures.filter((f) => f.labels.lowConfidenceGroundTruth).length

  const rows: string[][] = [
    ['classifier', `\`${options.classifier}\``],
    [
      'model',
      options.classifier === 'baseline'
        ? 'none — a heuristic, no model call'
        : `\`${MODEL_CONFIG.model}\``,
    ],
    [
      'prompt version',
      evaluation.classifier.promptVersion === null
        ? 'none'
        : `\`${evaluation.classifier.promptVersion}\``,
    ],
    // Only when a model was involved. Whether a set of numbers came from
    // recorded responses or live ones is the difference between a run that cost
    // nothing and a run that cost money, and between one that is reproducible
    // and one that is not.
    ...(evaluation.classifier.mode === null
      ? []
      : [['model calls', `\`${evaluation.classifier.mode}\``]]),
    ['dataset', `${String(fixtures.length)} fixtures in \`${DATASET_DIR}\``],
    ['dataset revision', `\`${revision}\``],
    ['slice', `\`${options.slice}\``],
    ['samples per fixture', String(options.samples)],
    [
      'scored in the headline',
      `${String(fixtures.length - excluded)} (${String(excluded)} excluded)`,
    ],
  ]

  return [
    '## Provenance',
    '',
    markdownTable(['', ''], rows, ['left', 'left']),
    '',
    'There is deliberately **no generation timestamp** here. The report is committed, so',
    `\`git log ${options.out}\` already records when each set of numbers was produced — and a clock`,
    'reading in the body would make every regeneration a diff even when nothing measured changed,',
    'which is exactly the noise that trains people to stop reading the diff.',
    '',
    ...(consultsHoldout(options.slice)
      ? [
          'The date under **Held-out usage** below is not an exception to that. It records when the',
          'held-out slice was consulted, which is a fact about the dataset rather than a reading of',
          'the clock at render time, and it is the number that bounds what the figures here are',
          'worth.',
          '',
        ]
      : []),
    'The dataset revision is a hash over every fixture payload **and** its labels. A payload edit',
    'and a label edit both move it, because both move the numbers.',
  ].join('\n')
}

function renderHeadline(metrics: Metrics): string {
  const rows = [
    [
      '**joint accuracy**',
      formatProportion(metrics.joint, { withN: false }),
      NOT_MEASURED,
      NOT_MEASURED,
    ],
    [
      '`owner` accuracy',
      formatProportion(metrics.owner.accuracy, { withN: false }),
      NOT_MEASURED,
      NOT_MEASURED,
    ],
    [
      '`determinism` accuracy',
      formatProportion(metrics.determinism.accuracy, { withN: false }),
      NOT_MEASURED,
      NOT_MEASURED,
    ],
    ['`owner` macro-F1', metrics.owner.macroF1.toFixed(3), NOT_MEASURED, NOT_MEASURED],
    ['`determinism` macro-F1', metrics.determinism.macroF1.toFixed(3), NOT_MEASURED, NOT_MEASURED],
  ]

  return [
    markdownTable(['metric', 'baseline', 'agent', 'delta'], rows, [
      'left',
      'right',
      'right',
      'right',
    ]),
    '',
    `All figures over **n = ${String(metrics.n)}**, with 95% Wilson intervals.`,
    '',
    'The agent column is empty because the agent does not exist yet — it lands in M3, tracked in',
    '[#35](https://github.com/AKogut/ai-flaky-test-triage/issues/35). It is present rather than',
    'omitted because the delta over the baseline, not the absolute, is what this project reports as',
    'its result. A number in the baseline column with nothing to compare it against is not yet a',
    'finding.',
  ].join('\n')
}

function renderPerClass(metrics: Metrics): string {
  const rows = [metrics.owner, metrics.determinism].flatMap((axis) =>
    axis.classes.map((c) => [
      // Named even though the five class values happen to be distinct today.
      // They are two separate label spaces, and a table that only reads
      // correctly because of a coincidence is one schema change from misleading.
      `\`${axis.axis}\``,
      `\`${c.label}\``,
      String(c.support),
      String(c.predictedCount),
      String(c.truePositives),
      formatProportion(c.precision, { withN: false }),
      formatProportion(c.recall, { withN: false }),
      c.f1.toFixed(3),
    ]),
  )

  return [
    markdownTable(
      ['axis', 'class', 'support', 'predicted', 'correct', 'precision', 'recall', 'F1'],
      rows,
      ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
    ),
    '',
    '`support` is how many fixtures genuinely are that class; `predicted` is how often the',
    'classifier reached for it. A class with support and no correct predictions has an F1 of 0 and',
    'is invisible in the accuracy figure above — which is the reason macro-F1 is reported next to',
    'it.',
  ].join('\n')
}

/**
 * What is in this slice and what is being withheld from it.
 *
 * Present in every report, including the held-out one, because the question
 * "what did this number *not* see" has to be answerable from the report a
 * reader has open rather than by finding the other one.
 */
function renderSlices(evaluation: Evaluation): string {
  const { composition, options } = evaluation
  const totals = composition.reduce(
    (sum, row) => ({ dev: sum.dev + row.dev, holdout: sum.holdout + row.holdout }),
    { dev: 0, holdout: 0 },
  )
  const size = totals.dev + totals.holdout
  const empty = emptyHoldoutBuckets(composition)

  const rows = composition.map((row) => [
    `\`${row.bucket}\``,
    String(row.total),
    String(row.dev),
    String(row.holdout),
  ])
  rows.push([
    '**total**',
    `**${String(size)}**`,
    `**${String(totals.dev)}**`,
    `**${String(totals.holdout)}**`,
  ])

  return [
    `This report scores the \`${options.slice}\` slice.`,
    '',
    markdownTable(['bucket', 'total', 'dev', 'held out'], rows, [
      'left',
      'right',
      'right',
      'right',
    ]),
    '',
    `A fixture's slice is a pure function of its name — the first 32 bits of its SHA-256, held out`,
    `below ${(HOLDOUT_SHARE * 100).toFixed(0)}%. Nothing about the rest of the dataset enters into it, so adding, removing or`,
    'renaming any other fixture cannot move it. That property is worth more than an exact 80/20:',
    'a fixture silently changing slice would invalidate every held-out number ever published, and',
    'would do it without any visible failure.',
    '',
    `The realised split is ${String(totals.holdout)} of ${String(size)} — ${pct(totals.holdout, size)}, against a ${(HOLDOUT_SHARE * 100).toFixed(0)}% target. That gap is`,
    'ordinary binomial variance at this size, not a defect in the rule, and it narrows as the',
    'dataset grows towards the 60 fixtures the methodology targets.',
    ...(empty.length === 0
      ? []
      : [
          '',
          `**Held-out results currently say nothing about ${empty.map((b) => `\`${b}\``).join(', ')}** —`,
          'no fixture from that bucket is held out. A bucket of four has a 41% chance of that at a',
          '20% share, so it is expected rather than surprising, but it does bound what a held-out',
          'number can be read to mean.',
        ]),
  ].join('\n')
}

const pct = (part: number, whole: number): string =>
  whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(0)}%`

/**
 * How often the held-out slice has been looked at.
 *
 * This is the number that decides whether the held-out figure above still means
 * anything. Every look leaks a little of the slice into the next prompt
 * revision, so a set consulted freely is a development set with extra steps —
 * and the erosion is invisible unless somebody counts.
 */
function renderHoldoutUsage(context: HoldoutContext): string {
  const warning = overuseWarning(context.overuse)

  return [
    `Last evaluated: **${context.lastEvaluated ?? 'never'}** · ` +
      `${String(context.overuse.within)} evaluation(s) in the last ${String(context.overuse.windowDays)} days · ` +
      `limit ${String(context.overuse.limit)}`,
    '',
    `Every run is appended to [\`${HOLDOUT_LOG}\`](${HOLDOUT_LOG.replace('eval/', '')}), which is committed. A log kept`,
    'outside version control would be advisory in the worst way — absent on a fresh clone, and',
    'clearable by deleting a file nobody reviews.',
    ...(warning === null
      ? []
      : [
          '',
          '> [!WARNING]',
          ...warning.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)),
        ]),
  ].join('\n')
}

function renderPerFixture(fixtures: EvaluatedFixture[]): string {
  const rows = fixtures.map((f) => {
    const { judgement: j } = f
    const ownerOk = j.predicted.owner === j.actual.owner
    const determinismOk = j.predicted.determinism === j.actual.determinism
    return [
      `\`${j.name}\``,
      `\`${f.labels.bucket}\``,
      `${j.actual.owner} / ${j.actual.determinism}`,
      `${j.predicted.owner} / ${j.predicted.determinism}`,
      ownerOk && determinismOk ? '✓' : ownerOk || determinismOk ? '½' : '✗',
      f.confidence.toFixed(2),
    ]
  })

  return [
    '<details>',
    '<summary>All fixtures, ordered by name</summary>',
    '',
    markdownTable(['fixture', 'bucket', 'ground truth', 'predicted', '', 'conf.'], rows, [
      'left',
      'left',
      'left',
      'left',
      'left',
      'right',
    ]),
    '',
    '`½` means one axis right and one wrong — a fixture that counts towards both axis accuracies',
    'and towards neither joint accuracy nor a usable answer.',
    '',
    '</details>',
  ].join('\n')
}

const HOW_TO_READ = (options: Options): string =>
  [
    '**Joint accuracy is the number.** Both axes correct on the same fixture. Either axis alone',
    'overstates how often the classifier produces something a developer could act on.',
    '',
    '**Read the interval, not the point estimate.** At this dataset size the interval is wide',
    'enough that a movement of several percentage points between runs means nothing. Comparisons',
    'are only meaningful when the intervals do not overlap.',
    '',
    '**The interval is not a generalisation claim.** The dataset is stratified by design, so it',
    'answers "how much would this move on a different set of fixtures built the same way" — not',
    '"how would this do on CI failures in general". That second question is out of scope, and',
    '`docs/limitations-and-guardrails.md` says why.',
    '',
    `**Regenerate with** \`npm run eval${options.classifier === 'baseline' ? '' : ` -- --classifier=${options.classifier}`}\`.`,
    'Full methodology: [`docs/eval-methodology.md`](../docs/eval-methodology.md).',
  ].join('\n')

/** Prettier is the final authority on layout, so the committed file always passes `format:check`. */
export async function buildReport(evaluation: Evaluation): Promise<string> {
  return format(renderReport(evaluation), { parser: 'markdown' })
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
  npm run eval -- [options]

    --classifier=baseline|agent   which classifier to score   (default: baseline)
    --slice=dev|holdout|all       which fixtures to use       (default: all)
    --n=<number>                  samples per fixture         (default: 1)
    --gate                        verify the committed report is current and hold it to
                                  the thresholds in eval/gate.ts; writes nothing
    --reference=<git-ref>         what a regression is measured against (default: origin/main)
    --out=<path>                  where to write              (default: eval/report.md)
`

export async function main(argv: string[]): Promise<number> {
  let options: Options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    return 2
  }

  const blocked = unsupported(options)
  if (blocked !== null) {
    console.error(['', indent(blocked), ''].join('\n'))
    return 2
  }

  if (options.samples > 1 && options.classifier === 'baseline') {
    console.log(
      `\n  Note: the baseline is deterministic, so --n=${String(options.samples)} would produce ${String(options.samples)} identical runs.\n  Sampling only means something once a model is involved.\n`,
    )
  }

  let evaluation: Evaluation
  try {
    evaluation = await evaluate(options)
  } catch (error) {
    // A run that could not finish is not a threshold failure and not a usage
    // error, and the difference matters to whoever reads the exit code. What it
    // needs is the message: a cassette miss, a budget ceiling and a refusal each
    // already say exactly what to do next, and wrapping them in a stack trace
    // buries the one line that helps.
    console.error(
      `\n  The evaluation could not finish.\n\n${indent(
        error instanceof Error ? error.message : String(error),
      )}\n`,
    )
    return 1
  }

  // Reading the held-out slice is the act being recorded, so the run is logged
  // before the report is rendered — the report then states the usage including
  // itself, which is the number that decides how much its own figure is worth.
  //
  // `--gate` is excluded: it re-derives an evaluation that was already recorded
  // when the report was written, and counting a verification as a consultation
  // would let CI exhaust the budget on work nobody chose to do.
  if (consultsHoldout(options.slice) && !options.gate) {
    const runs = appendHoldoutRun({
      date: isoDate(new Date()),
      datasetRevision: evaluation.datasetRevision,
      slice: options.slice,
      n: evaluation.metrics.n,
      jointAccuracy: evaluation.metrics.joint.point,
    })
    evaluation.holdout = { lastEvaluated: lastEvaluated(runs), overuse: overuse(runs, new Date()) }
  } else if (consultsHoldout(options.slice)) {
    const runs = readHoldoutLog()
    evaluation.holdout = { lastEvaluated: lastEvaluated(runs), overuse: overuse(runs, new Date()) }
  }

  const report = await buildReport(evaluation)

  const warning = evaluation.holdout ? overuseWarning(evaluation.holdout.overuse) : null
  if (warning !== null) {
    console.warn(
      `\n  ${warning
        .split('\n')
        .map((l) => (l === '' ? '' : l))
        .join('\n  ')}\n`,
    )
  }

  const current = snapshot(
    evaluation.metrics,
    quadrantBreakdown(
      evaluation.fixtures.filter((f) => !f.labels.lowConfidenceGroundTruth).map((f) => f.judgement),
    ),
    {
      classifier: options.classifier,
      promptVersion: evaluation.classifier.promptVersion,
      slice: options.slice,
      datasetRevision: evaluation.datasetRevision,
      // Null rather than 1 when nothing was sampled. A single run of a
      // deterministic classifier agrees with itself trivially, and recording
      // that as a perfect score would let the self-consistency floor pass on
      // evidence nobody gathered.
      selfConsistency: evaluation.sampling.samples > 1 ? evaluation.sampling.selfConsistency : null,
      costPerFixtureUsd:
        evaluation.cost.inputTokens + evaluation.cost.outputTokens === 0
          ? null
          : evaluation.cost.usd / Math.max(1, evaluation.fixtures.length),
    },
  )
  const metricsPath = metricsPathFor(options)

  if (options.gate) {
    const committed = readCommitted(options.out)
    if (committed === report) {
      console.log(`\n  ${options.out} is up to date.\n`)

      // Freshness only says the report matches the code. The thresholds say
      // whether the numbers it contains are allowed to merge.
      const gate = runGate({
        current,
        reference: readReferenceSnapshot(metricsPath, options.reference),
      })
      console.log(`  Thresholds against \`${options.reference}\`:\n`)
      console.log(`${renderGateReport(gate)}\n`)
      return gate.failed ? 1 : 0
    }
    const cause =
      committed === null
        ? ['  The file is missing entirely.']
        : [
            '  Either the classifier changed and the report was not regenerated, or the',
            '  report was edited by hand. Both are fixed the same way:',
          ]

    console.error(
      [
        '',
        `  ${options.out} does not match what this run produces.`,
        '',
        ...cause,
        '',
        '    npm run eval',
        '',
        '  Then commit the diff. The diff is the record of what moved.',
        '',
      ].join('\n'),
    )
    return 1
  }

  writeFileSync(options.out, report)
  writeFileSync(metricsPath, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`\n  Wrote ${options.out} and ${metricsPath}\n`)
  return 0
}

/** Indents the text and not the blank lines — a trailing space shows up in captured output. */
const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n')

/** Follows `--out` when it was given, so a redirected run does not clobber the committed pair. */
function metricsPathFor(options: Options): string {
  return options.out === REPORT_PATHS[options.slice]
    ? METRICS_PATHS[options.slice]
    : options.out.replace(/\.md$/, '.metrics.json')
}

function readCommitted(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

if (process.argv[1]?.endsWith('run-eval.ts') === true) {
  process.exitCode = await main(process.argv.slice(2))
}
