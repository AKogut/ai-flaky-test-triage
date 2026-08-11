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
import { formatProportion, score, type Metrics } from './metrics.js'

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
  slice: 'dev' | 'holdout' | 'all'
  samples: number
  /** Verify the committed report is current instead of rewriting it. */
  gate: boolean
  out: string
}

export const DEFAULTS: Options = {
  classifier: 'baseline',
  slice: 'all',
  samples: 1,
  gate: false,
  out: 'eval/report.md',
}

/** Capabilities the CLI accepts but cannot do yet, with the issue that will land them. */
const NOT_YET: Record<string, { what: string; milestone: string; issue: number }> = {
  'classifier=agent': { what: 'The agent classifier', milestone: 'M3', issue: 35 },
  'slice=dev': { what: 'Dataset slices', milestone: 'M2', issue: 28 },
  'slice=holdout': { what: 'Dataset slices', milestone: 'M2', issue: 28 },
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
      case 'out':
        if (value === undefined || value === '') throw new UsageError(`--out needs a path`)
        options.out = value
        break
      default:
        throw new UsageError(`unknown flag "--${flag}"`)
    }
  }

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

export interface Evaluation {
  options: Options
  fixtures: EvaluatedFixture[]
  metrics: Metrics
  datasetRevision: string
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
  const fixtures = listFixtures().map((name): EvaluatedFixture => {
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
    'There is deliberately **no generation timestamp** in this file. The report is committed, so',
    '`git log eval/report.md` already records when each set of numbers was produced — and a clock',
    'reading in the body would make every regeneration a diff even when nothing measured changed,',
    'which is exactly the noise that trains people to stop reading the diff.',
    '',
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
    --gate                        verify the committed report is current, write nothing
    --out=<path>                  where to write              (default: eval/report.md)
`

async function main(argv: string[]): Promise<number> {
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

  const report = await buildReport(evaluate(options))

  if (options.gate) {
    const committed = readCommitted(options.out)
    if (committed === report) {
      console.log(`\n  ${options.out} is up to date.\n`)
      return 0
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
  console.log(`\n  Wrote ${options.out}\n`)
  return 0
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
