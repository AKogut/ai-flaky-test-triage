import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { format } from 'prettier'
import type { FixtureLabels } from '@sentra/contracts'
import { classifyWithBaseline } from './baseline.js'
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
const NOT_YET: Record<string, { what: string; milestone: string; issue: number }> = {
  'classifier=agent': { what: 'The agent classifier', milestone: 'M3', issue: 35 },
}

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

  return options
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
  confidence: number
  reasoning: string
}

/** Read from the committed log, and only present on a run that looked at held-out fixtures. */
export interface HoldoutContext {
  lastEvaluated: string | null
  overuse: Overuse
}

export interface Evaluation {
  options: Options
  fixtures: EvaluatedFixture[]
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

export function evaluate(options: Options): Evaluation {
  const every = listFixtures().map((name) => ({ name, bucket: loadLabels(name).bucket }))

  const fixtures = listFixtures()
    .filter((name) => inSlice(name, options.slice))
    .map((name): EvaluatedFixture => {
      const { payload, hash } = loadPayload(name)
      const labels = loadLabels(name)
      const predicted = classifyWithBaseline(payload)

      return {
        judgement: {
          name,
          predicted: { owner: predicted.owner, determinism: predicted.determinism },
          actual: { owner: labels.owner, determinism: labels.determinism },
        },
        labels,
        payloadHash: hash,
        confidence: predicted.confidence,
        reasoning: predicted.reasoning,
      }
    })

  const headline = fixtures.filter((f) => !f.labels.lowConfidenceGroundTruth)

  return {
    options,
    fixtures,
    metrics: score(headline.map((f) => f.judgement)),
    // Over the whole dataset, not the slice being scored, so the dev report can
    // say what is being withheld from it.
    composition: sliceComposition(every),
    datasetRevision: datasetRevision(fixtures),
  }
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

function renderProvenance(evaluation: Evaluation): string {
  const { options, fixtures, datasetRevision: revision } = evaluation
  const excluded = fixtures.filter((f) => f.labels.lowConfidenceGroundTruth).length

  const rows: string[][] = [
    ['classifier', `\`${options.classifier}\``],
    ['model', options.classifier === 'baseline' ? 'none — a heuristic, no model call' : 'unknown'],
    ['prompt version', options.classifier === 'baseline' ? 'none' : 'unknown'],
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
    // Indent the text, not the blank lines between it — trailing spaces on an
    // otherwise empty line show up in anything that captures the output.
    const indented = blocked.split('\n').map((line) => (line === '' ? '' : `  ${line}`))
    console.error(['', ...indented, ''].join('\n'))
    return 2
  }

  if (options.samples > 1 && options.classifier === 'baseline') {
    console.log(
      `\n  Note: the baseline is deterministic, so --n=${String(options.samples)} would produce ${String(options.samples)} identical runs.\n  Sampling only means something once a model is involved.\n`,
    )
  }

  const evaluation = evaluate(options)

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
      slice: options.slice,
      datasetRevision: evaluation.datasetRevision,
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
