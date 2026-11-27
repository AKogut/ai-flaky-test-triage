import { readFileSync, writeFileSync } from 'node:fs'
import { format } from 'prettier'
import {
  CassetteMissError,
  formatUsd,
  MODEL_CONFIG,
  resolveMode,
  type Mode,
  type Transport,
} from '@sentra/agents'
import { DeterminismSchema, OwnerSchema, type ClassificationInput } from '@sentra/contracts'
import { CURRENT_PROMPT } from '@sentra/prompts'
import { markdownTable, type Align } from './confusion.js'
import { DATASET_DIR, listFixtures, loadLabels, loadPayload } from './dataset.js'
import { formatProportion, type Interval, type Proportion } from './metrics.js'
import {
  DEFAULT_SAMPLES,
  DEFAULTS,
  evaluate,
  UsageError,
  type EvaluatedFixture,
  type Evaluation,
} from './run-eval.js'
import { inSlice, type SliceSelector } from './slices.js'
import {
  carries,
  describeWithheld,
  INPUT_NAMES,
  INPUTS,
  OTHER_VARIANTS,
  VARIANTS,
  withheldFields,
  type Reference,
  type Variant,
} from './variants.js'

/**
 * `npm run eval:ablation` — the golden dataset, once per context variant, and
 * `eval/ablation.md`.
 *
 * The question is which parts of the context bundle the classifier actually
 * uses. A field that contributes nothing is cost and latency with no return, and
 * the only way to find out which fields those are is to remove them one at a
 * time and score what is left the same way the headline is scored. So each
 * variant here is `evaluate` from `run-eval.ts` with one more argument, not a
 * second harness: the same fixtures, the same consensus over samples, the same
 * intervals.
 *
 * ## Two studies, one of which can run today
 *
 * The methodology asks this of the agent, and the agent's variants need model
 * calls. With no cassettes recorded (#38), every one of them stops at its first
 * replay miss, and this file reports that per variant rather than estimating
 * anything. A run in which no agent variant could be scored writes nothing.
 *
 * `--classifier=baseline` asks the same question of the control, which costs
 * nothing and answers something real: which signals the baseline relies on. It
 * is labelled as exactly that, because the two are easy to confuse — a field the
 * baseline ignores may be the one the agent needs. The committed report is that
 * run, until the agent's can replace it.
 *
 * ## The held-out slice is never ablated
 *
 * An ablation is iteration by definition: its output is a decision about what to
 * change. Running it on the held-out slice would spend the budget in
 * `eval/holdout-log.json` on runs nobody uses to confirm anything, so the slice
 * is fixed here and `--slice` is refused rather than accepted.
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AblationOptions {
  classifier: 'baseline' | 'agent'
  samples: number
  /** Verify the committed report matches a fresh run. Writes nothing. */
  check: boolean
  out: string
}

export const ABLATION_PATH = 'eval/ablation.md'

/** Not an option. See the module comment. */
export const ABLATION_SLICE: SliceSelector = 'dev'

/**
 * The agent by default, because the methodology's ablation is the agent's.
 *
 * The baseline control is the explicit one, so a reader who runs the bare
 * command is told the agent's variants have not run rather than being handed
 * the control's numbers under a name that suggests otherwise.
 */
export const ABLATION_DEFAULTS: AblationOptions = {
  classifier: 'agent',
  samples: DEFAULT_SAMPLES.agent,
  check: false,
  out: ABLATION_PATH,
}

export function parseArgs(argv: string[]): AblationOptions {
  const options: AblationOptions = { ...ABLATION_DEFAULTS }
  let samplesWereGiven = false

  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (match === null) throw new UsageError(`unexpected argument "${arg}"`)
    const [, flag = '', value] = match

    switch (flag) {
      case 'classifier':
        if (value !== 'baseline' && value !== 'agent') {
          throw new UsageError(`--classifier must be one of baseline | agent, got "${value ?? ''}"`)
        }
        options.classifier = value
        break
      case 'n':
      case 'samples': {
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new UsageError(
            `--${flag} must be a whole number of 1 or more, got "${value ?? ''}"`,
          )
        }
        options.samples = parsed
        samplesWereGiven = true
        break
      }
      case 'check':
        options.check = true
        break
      case 'out':
        if (value === undefined || value === '') throw new UsageError('--out needs a path')
        options.out = value
        break
      case 'slice':
        // Named rather than left to the unknown-flag branch, because the reason
        // is the useful part of the message.
        throw new UsageError(
          'the ablation runs on the development slice only. Every run of it is iteration, and the held-out slice is for confirming a result — see docs/eval-methodology.md',
        )
      default:
        throw new UsageError(`unknown flag "--${flag}"`)
    }
  }

  if (!samplesWereGiven) options.samples = DEFAULT_SAMPLES[options.classifier]
  return options
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface VariantRun {
  variant: Variant
  /** Null when the variant could not be scored. Never estimated. */
  evaluation: Evaluation | null
  /** Why `evaluation` is null. */
  notRun: string | null
  /**
   * Headline fixtures that carry something this variant withholds.
   *
   * Zero means the row cannot differ from the full context on this slice, and
   * the report says so instead of offering an identical row as a result.
   */
  carriedBy: number
}

export interface Study {
  classifier: 'baseline' | 'agent'
  samples: number
  /** One per variant, in `VARIANTS` order, so the first is the reference. */
  runs: VariantRun[]
}

export interface Ablation {
  options: AblationOptions
  /** The agent's first, when it was asked for; the baseline control always. */
  studies: Study[]
  /** How the agent reached the model. Null when only the baseline ran. */
  mode: Mode | null
}

export interface AblationDeps {
  env?: NodeJS.ProcessEnv
  /** Injected so the agent's study is testable without a key, a cassette or a network. */
  transport?: Transport
}

export const NO_CASSETTES = 'no cassettes, see #38'

/**
 * One classifier over every variant.
 *
 * A cassette miss ends that variant and only that variant: the next one asks
 * different questions and may have its answers recorded. Anything else — a
 * spent budget, a refusal, a corrupt cassette — ends the run, exactly as it
 * would end `npm run eval`, because those are faults rather than absences.
 */
export async function runStudy(
  classifier: Study['classifier'],
  samples: number,
  deps: AblationDeps = {},
): Promise<Study> {
  const scored = scoredInputs()
  const runs: VariantRun[] = []
  for (const variant of VARIANTS) {
    const carriedBy = scored.filter((input) => carries(input, variant.withheld)).length
    try {
      const evaluation = await evaluate(
        { ...DEFAULTS, classifier, samples, slice: ABLATION_SLICE },
        { ...deps, withhold: variant.withheld },
      )
      runs.push({ variant, evaluation, notRun: null, carriedBy })
    } catch (error) {
      if (!(error instanceof CassetteMissError)) throw error
      runs.push({ variant, evaluation: null, notRun: NO_CASSETTES, carriedBy })
    }
  }
  return { classifier, samples, runs }
}

/** The inputs the headline scores: the ablation's slice, arguable ground truth left out. */
function scoredInputs(): ClassificationInput[] {
  return listFixtures()
    .filter((name) => inSlice(name, ABLATION_SLICE) && !loadLabels(name).lowConfidenceGroundTruth)
    .map((name) => loadPayload(name).payload)
}

export async function ablate(options: AblationOptions, deps: AblationDeps = {}): Promise<Ablation> {
  if (options.classifier === 'baseline') {
    return {
      options,
      studies: [await runStudy('baseline', options.samples)],
      mode: null,
    }
  }

  const mode = resolveMode(deps.env ?? process.env)
  const agent = await runStudy('agent', options.samples, deps)
  const baseline = await runStudy('baseline', DEFAULT_SAMPLES.baseline)
  return { options, studies: [agent, baseline], mode }
}

// ---------------------------------------------------------------------------
// Comparing two runs
// ---------------------------------------------------------------------------

const headline = (evaluation: Evaluation): EvaluatedFixture[] =>
  evaluation.fixtures.filter((f) => !f.labels.lowConfidenceGroundTruth)

const jointlyRight = (f: EvaluatedFixture): boolean =>
  f.judgement.predicted.owner === f.judgement.actual.owner &&
  f.judgement.predicted.determinism === f.judgement.actual.determinism

export interface Change {
  /** Fixtures whose prediction moved on either axis. */
  changed: number
  owner: number
  determinism: number
  /** Wrong under the reference, right under the variant. */
  gained: number
  lost: number
}

/**
 * Fixture by fixture, which is the measurement the intervals cannot make.
 *
 * Both runs score the same fixtures, so this is exact: six predictions can move
 * in both directions and leave accuracy where it was, and only a paired count
 * can say so.
 */
export function compareRuns(reference: Evaluation, variant: Evaluation): Change {
  const before = new Map(headline(reference).map((f) => [f.judgement.name, f]))
  const change: Change = { changed: 0, owner: 0, determinism: 0, gained: 0, lost: 0 }

  for (const after of headline(variant)) {
    const was = before.get(after.judgement.name)
    if (was === undefined) continue
    const owner = was.judgement.predicted.owner !== after.judgement.predicted.owner
    const determinism =
      was.judgement.predicted.determinism !== after.judgement.predicted.determinism
    if (owner) change.owner += 1
    if (determinism) change.determinism += 1
    if (owner || determinism) change.changed += 1
    if (!jointlyRight(was) && jointlyRight(after)) change.gained += 1
    if (jointlyRight(was) && !jointlyRight(after)) change.lost += 1
  }

  return change
}

export const overlaps = (a: Interval, b: Interval): boolean =>
  a.lower <= b.upper && b.lower <= a.upper

type Axis = 'owner' | 'determinism'
const AXES: readonly Axis[] = ['owner', 'determinism']

const become = (count: number): string => (count === 1 ? 'becomes' : 'become')

/** `a`, `a and b`, `a, b and c`. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`
}

/** `app_code + intermittent`: the case the project exists for, counted on its own. */
function hardQuadrant(evaluation: Evaluation): { correct: number; support: number } {
  const hard = headline(evaluation).filter(
    (f) =>
      f.judgement.actual.owner === 'app_code' && f.judgement.actual.determinism === 'intermittent',
  )
  return { correct: hard.filter(jointlyRight).length, support: hard.length }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const REPO = 'https://github.com/AKogut/ai-flaky-test-triage'
const ISSUE_38 = `[#38](${REPO}/issues/38)`
const NONE = '—'

const share = (p: Proportion): string => formatProportion(p, { withN: false })
const pct = (p: Proportion): string => `${(p.point * 100).toFixed(1)}%`
const code = (value: string): string => `\`${value}\``
const link = (reference: Reference): string => `[${reference.label}](${reference.href})`

/** `+3.8pp`, `-11.5pp`, `0.0pp`. */
export function signedPoints(delta: number): string {
  const rounded = Math.round(delta * 1000) / 10
  if (rounded === 0) return '0.0pp'
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded).toFixed(1)}pp`
}

/** The command that regenerates the report a run produced. */
export function regenerateCommand(options: AblationOptions): string {
  const flags = [
    ...(options.classifier === 'baseline' ? ['--classifier=baseline'] : []),
    ...(options.samples === DEFAULT_SAMPLES[options.classifier]
      ? []
      : [`--n=${String(options.samples)}`]),
  ]
  return flags.length === 0
    ? 'npm run eval:ablation'
    : `npm run eval:ablation -- ${flags.join(' ')}`
}

const studyOf = (ablation: Ablation, classifier: Study['classifier']): Study | undefined =>
  ablation.studies.find((study) => study.classifier === classifier)

/** The baseline's full-context run. Always present: the baseline cannot miss a cassette. */
function baselineReference(ablation: Ablation): Evaluation {
  const evaluation = studyOf(ablation, 'baseline')?.runs[0]?.evaluation
  if (evaluation == null) throw new Error('the baseline control did not score its full context')
  return evaluation
}

export function renderAblation(ablation: Ablation): string {
  return [
    '# Ablation study',
    '',
    `> Generated by \`${regenerateCommand(ablation.options)}\`. Do not edit by hand — the next run overwrites it.`,
    '',
    renderProvenance(ablation),
    '',
    ...ablation.studies.flatMap((study) => [renderStudy(study, ablation), '']),
    '## Variants',
    '',
    renderVariants(),
    '',
    '## How to read this',
    '',
    renderHowToRead(ablation),
    '',
  ].join('\n')
}

/** Prettier is the final authority on layout, so the committed file always passes `format:check`. */
export async function buildAblation(ablation: Ablation): Promise<string> {
  return format(renderAblation(ablation), { parser: 'markdown' })
}

function renderProvenance(ablation: Ablation): string {
  const reference = baselineReference(ablation)
  const agent = studyOf(ablation, 'agent')
  const scored = headline(reference).length
  const excluded = reference.fixtures.length - scored

  const rows: string[][] = [
    [
      'classifier',
      agent === undefined ? '`baseline`' : '`agent`, with the baseline control beside it',
    ],
    ['model', agent === undefined ? 'none — a heuristic, no model call' : code(MODEL_CONFIG.model)],
    ...(agent === undefined
      ? []
      : [
          ['prompt version', code(promptVersionOf(agent))],
          ['model calls', code(ablation.mode ?? 'replay')],
        ]),
    ['dataset', `${String(reference.fixtures.length)} fixtures in \`${DATASET_DIR}\``],
    ['dataset revision', code(reference.datasetRevision)],
    ['slice', `\`${ABLATION_SLICE}\` — the held-out slice is never ablated`],
    [
      'samples per fixture',
      ablation.studies.map((study) => `${String(study.samples)} (${study.classifier})`).join(', '),
    ],
    ['scored per variant', `${String(scored)} (${String(excluded)} excluded)`],
    ['variants', String(VARIANTS.length)],
  ]

  return [
    '## Provenance',
    '',
    markdownTable(['', ''], rows, ['left', 'left']),
    '',
    'The dataset revision is the one `eval/report.md` carries: the same fixtures, hashed before',
    'anything is withheld. No generation timestamp, for the reason that report gives —',
    '`git log eval/ablation.md` already dates every set of numbers, and a clock reading in the body',
    'would make every regeneration a diff.',
  ].join('\n')
}

/**
 * The agent's prompt version, from whichever of its variants ran.
 *
 * At least one did, or nothing is rendered: `main` stops before the report when
 * every variant missed. The fallback is the version the classifier would load.
 */
function promptVersionOf(study: Study): string {
  return (
    study.runs.find((run) => run.evaluation !== null)?.evaluation?.classifier.promptVersion ??
    CURRENT_PROMPT.triage
  )
}

/** A reason for the report, with the issue it points at made a link. */
const linked = (reason: string): string => reason.replace('#38', ISSUE_38)

function renderStudy(study: Study, ablation: Ablation): string {
  const alone = ablation.studies.length === 1
  const heading =
    study.classifier === 'agent'
      ? '## Agent'
      : alone
        ? "## Baseline control — the agent's ablation waits on #38"
        : '## Baseline control'

  const intro =
    study.classifier === 'agent'
      ? [
          'The triage agent over the development slice, once per variant, through the cassette',
          `transport — \`${ablation.mode ?? 'replay'}\` on this run. A variant with no recorded responses is`,
          'listed as not run rather than estimated. The last row is the baseline heuristic on the full',
          `context: the methodology's "is the LLM needed at all", measured on the same fixtures.`,
        ]
      : alone
        ? [
            "The ablation this report exists for is the agent's: which parts of the context bundle the",
            'model uses. Every one of those variants needs model calls, and none are recorded yet —',
            `tracked in ${ISSUE_38} — so \`npm run eval:ablation\` on its own reports each`,
            'of them as not run and writes nothing.',
            '',
            'This section asks the same question of the control, which can be answered today. The',
            "baseline heuristic runs over the development slice once per variant, with that variant's",
            'inputs withheld, and each row is scored exactly as `eval/report.md` scores its headline.',
            'What it measures is which signals the **baseline** relies on — not which ones the agent',
            'does. A field the baseline never responds to may still be the one the agent needs; showing',
            "that is the agent's run, not this one.",
          ]
        : [
            'The same variants, run through the baseline heuristic. It reads the raw input rather than',
            'a prompt, so a withheld input is blanked rather than announced — see',
            '[How a withheld input reaches each classifier](#how-a-withheld-input-reaches-each-classifier).',
          ]

  const agentReference = study.classifier === 'agent' ? (study.runs[0]?.evaluation ?? null) : null
  const extra =
    study.classifier === 'agent'
      ? { name: 'Baseline heuristic', evaluation: baselineReference(ablation) }
      : null

  return [
    heading,
    '',
    ...intro,
    '',
    '### Comparison',
    '',
    renderComparison(study, extra),
    '',
    '### What it shows',
    '',
    renderConclusions(study, agentReference, extra),
    '',
    '### Per quadrant',
    '',
    renderQuadrants(study, extra),
    '',
    '### Per bucket',
    '',
    renderBuckets(study, extra),
    '',
    '### Cost',
    '',
    renderCost(study),
  ].join('\n')
}

interface Extra {
  name: string
  evaluation: Evaluation
}

function costPerFixture(evaluation: Evaluation): string {
  const { cost } = evaluation
  if (cost.inputTokens + cost.outputTokens === 0) return 'none — no model call'
  return formatUsd(cost.usd / Math.max(1, evaluation.fixtures.length))
}

function renderComparison(study: Study, extra: Extra | null): string {
  const reference = study.runs[0]?.evaluation ?? null

  const row = (
    name: string,
    withheld: string,
    carried: string,
    evaluation: Evaluation | null,
    notRun: string | null,
    isReference: boolean,
  ): string[] => {
    if (evaluation === null) {
      return [
        name,
        withheld,
        carried,
        `not run — ${linked(notRun ?? '')}`,
        NONE,
        NONE,
        NONE,
        NONE,
        NONE,
      ]
    }
    const comparable = reference !== null && !isReference
    const change = comparable ? compareRuns(reference, evaluation) : null
    return [
      isReference ? `**${name}**` : name,
      withheld,
      carried,
      share(evaluation.metrics.joint),
      share(evaluation.metrics.owner.accuracy),
      share(evaluation.metrics.determinism.accuracy),
      comparable
        ? signedPoints(evaluation.metrics.joint.point - reference.metrics.joint.point)
        : NONE,
      change === null ? NONE : `${String(change.changed)} of ${String(evaluation.metrics.n)}`,
      costPerFixture(evaluation),
    ]
  }

  const rows = study.runs.map((run, index) =>
    row(
      run.variant.name,
      describeWithheld(run.variant.withheld),
      index === 0 ? NONE : String(run.carriedBy),
      run.evaluation,
      run.notRun,
      index === 0,
    ),
  )
  if (extra !== null)
    rows.push(row(extra.name, 'nothing — no model', NONE, extra.evaluation, null, false))

  const n = reference?.metrics.n ?? extra?.evaluation.metrics.n ?? 0
  const align: Align[] = [
    'left',
    'left',
    'right',
    'right',
    'right',
    'right',
    'right',
    'right',
    'right',
  ]

  return [
    markdownTable(
      [
        'variant',
        'withheld',
        'carried by',
        'joint',
        '`owner`',
        '`determinism`',
        'Δ joint',
        'changed',
        'cost / fixture',
      ],
      rows,
      align,
    ),
    '',
    `All figures over **n = ${String(n)}**, with 95% Wilson intervals. Δ is against the bold`,
    'full-context row. `carried by` counts the fixtures that have something for the variant to',
    'withhold — a row carried by none cannot differ from the full context. `changed` counts',
    'fixtures whose predicted label moved on either axis; every row scores the same fixtures, so',
    'that count is exact where the intervals are not.',
  ].join('\n')
}

/**
 * The prose, written by the generator so it cannot go stale.
 *
 * It refuses to call a difference real when the intervals overlap, which at
 * this dataset size is most of them. "Within noise" is said in those words:
 * it is a statement about the size of the dataset, not evidence that a field
 * does nothing, and a report that let the two blur would be claiming the second.
 */
function renderConclusions(
  study: Study,
  agentReference: Evaluation | null,
  extra: Extra | null,
): string {
  const [first, ...rest] = study.runs
  const reference = first?.evaluation ?? null
  const who = study.classifier === 'agent' ? 'the agent' : 'the baseline'

  if (reference === null) {
    const notRun = study.runs
      .filter((run) => run.evaluation === null)
      .map((run) => run.variant.name)
    return [
      `The full-context row did not run, so no variant has anything to be compared against.`,
      `Not run: ${joinNames(notRun)} — ${linked(NO_CASSETTES)}.`,
    ].join(' ')
  }

  const n = reference.metrics.n
  const beyond: string[] = []
  const within: string[] = []
  const inert: string[] = []
  const untestable: string[] = []
  const notRun: string[] = []
  const axisBeyond: Record<Axis, string[]> = { owner: [], determinism: [] }
  const bullets: string[] = []

  for (const run of rest) {
    const name = run.variant.name
    if (run.evaluation === null) {
      notRun.push(name)
      continue
    }
    const after = run.evaluation
    const change = compareRuns(reference, after)

    // `a diff`, `a run context`; a variant withholding several has no one noun.
    const [only, ...others] = run.variant.withheld
    const withheld =
      only !== undefined && others.length === 0
        ? `a ${INPUTS[only].label}`
        : 'anything it withholds'
    if (run.carriedBy === 0) {
      untestable.push(name)
      bullets.push(
        `- **${name}** cannot be measured on this slice: no fixture in it carries ${withheld}, ` +
          'so the row is the full context under another name. It starts to mean something with ' +
          'the first fixture that does.',
      )
      continue
    }

    if (change.changed === 0) {
      inert.push(name)
      bullets.push(
        `- **${name}** changes none of the ${String(n)} predictions, although ${String(run.carriedBy)} ` +
          `of them carry ${withheld}: on these fixtures ${who}'s answer does not depend on it. ` +
          (study.classifier === 'baseline'
            ? 'That says nothing yet about whether the agent needs it.'
            : 'It costs tokens and moved nothing, which makes it a candidate for removal.'),
      )
      continue
    }

    const real = !overlaps(after.metrics.joint.interval, reference.metrics.joint.interval)
    ;(real ? beyond : within).push(name)

    const delta = after.metrics.joint.point - reference.metrics.joint.point
    const movement =
      signedPoints(delta) === '0.0pp'
        ? `leaves joint accuracy where it was, at ${pct(after.metrics.joint)}`
        : `moves joint accuracy from ${pct(reference.metrics.joint)} to ${pct(after.metrics.joint)} (${signedPoints(delta)})`

    const axes = AXES.filter((axis) => change[axis] > 0).map(
      (axis) => `\`${axis}\` on ${String(change[axis])}`,
    )

    const axisLines = AXES.filter(
      (axis) =>
        !overlaps(after.metrics[axis].accuracy.interval, reference.metrics[axis].accuracy.interval),
    ).map((axis) => {
      axisBeyond[axis].push(name)
      return (
        `\`${axis}\` accuracy on its own goes from ${share(reference.metrics[axis].accuracy)} to ` +
        `${share(after.metrics[axis].accuracy)}, and those intervals do not overlap.`
      )
    })

    const [hardBefore, hardAfter] = [hardQuadrant(reference), hardQuadrant(after)]
    const hardLine =
      hardBefore.correct === hardAfter.correct
        ? []
        : [
            `In the hard quadrant it places ${String(hardAfter.correct)} of ${String(hardAfter.support)} ` +
              `correctly, against ${String(hardBefore.correct)} with the full context.`,
          ]

    bullets.push(
      [
        `- **${name}** ${movement}. It changes ${String(change.changed)} of ${String(n)} predictions ` +
          `(${axes.join(', ')}): ${String(change.gained)} ${become(change.gained)} right and ` +
          `${String(change.lost)} ${become(change.lost)} wrong.`,
        real
          ? `The joint intervals do not overlap — at n = ${String(n)} that is beyond the noise.`
          : `The joint intervals overlap, so at n = ${String(n)} that is within noise.`,
        ...axisLines,
        ...hardLine,
      ].join(' '),
    )
  }

  const list = (names: string[]): string => joinNames(names.map((name) => `**${name}**`))
  const verb = (names: string[], one: string, many: string): string =>
    names.length === 1 ? one : many
  const summary = [
    beyond.length === 0
      ? 'No variant moves joint accuracy beyond its interval.'
      : `${list(beyond)} ${verb(beyond, 'moves', 'move')} joint accuracy beyond the interval.`,
    within.length === 0
      ? null
      : `${list(within)} ${verb(within, 'changes', 'change')} predictions without moving it beyond ` +
        `the interval — within noise at n = ${String(n)}.`,
    inert.length === 0
      ? null
      : `${list(inert)} ${verb(inert, 'changes', 'change')} no prediction at all.`,
    untestable.length === 0
      ? null
      : `${list(untestable)} cannot be measured yet: no fixture in the slice carries what ` +
        `${verb(untestable, 'it withholds', 'they withhold')}.`,
    ...AXES.filter((axis) => axisBeyond[axis].length > 0).map(
      (axis) =>
        `On \`${axis}\` alone the picture is sharper: ${list(axisBeyond[axis])} ` +
        `${verb(axisBeyond[axis], 'moves', 'move')} it beyond the interval.`,
    ),
    notRun.length === 0 ? null : `Not run: ${joinNames(notRun)} — ${linked(NO_CASSETTES)}.`,
  ].filter((line): line is string => line !== null)

  const versus =
    extra !== null && agentReference !== null
      ? [
          '',
          `**Is the LLM needed at all?** The agent scores ${share(agentReference.metrics.joint)} on the full context ` +
            `against the baseline's ${share(extra.evaluation.metrics.joint)}. ` +
            (overlaps(
              agentReference.metrics.joint.interval,
              extra.evaluation.metrics.joint.interval,
            )
              ? 'The intervals overlap: on this dataset the two cannot be told apart.'
              : 'The intervals do not overlap: that difference is real at this size.'),
        ]
      : []

  return [summary.join(' '), '', ...bullets, ...versus].join('\n')
}

function columnsFor(
  study: Study,
  extra: Extra | null,
): { name: string; evaluation: Evaluation | null }[] {
  return [
    ...study.runs.map((run) => ({ name: run.variant.name, evaluation: run.evaluation })),
    ...(extra === null ? [] : [extra]),
  ]
}

function renderQuadrants(study: Study, extra: Extra | null): string {
  const columns = columnsFor(study, extra)
  const reference = columns.find((column) => column.evaluation !== null)?.evaluation ?? null
  const truth = reference === null ? [] : headline(reference)

  const rows = OwnerSchema.options.flatMap((owner) =>
    DeterminismSchema.options.map((determinism) => {
      const inQuadrant = (f: EvaluatedFixture): boolean =>
        f.judgement.actual.owner === owner && f.judgement.actual.determinism === determinism
      const name = `${code(owner)} + ${code(determinism)}`
      const hard = owner === 'app_code' && determinism === 'intermittent'
      return [
        hard ? `**${name}**` : name,
        String(truth.filter(inQuadrant).length),
        ...columns.map((column) =>
          column.evaluation === null
            ? NONE
            : String(
                headline(column.evaluation).filter((f) => inQuadrant(f) && jointlyRight(f)).length,
              ),
        ),
      ]
    }),
  )
  const supports = rows.map((row) => Number(row[1])).filter((support) => support > 0)

  return [
    markdownTable(['quadrant', 'support', ...columns.map((column) => column.name)], rows, [
      'left',
      'right',
      ...columns.map((): Align => 'right'),
    ]),
    '',
    'Fixtures placed in their true quadrant — both axes right — out of `support`, by ground-truth',
    `quadrant. Counts rather than intervals: a quadrant holds between ${String(Math.min(...supports))} and ${String(Math.max(...supports))} fixtures`,
    'here, and an interval over that few would span most of the scale. The bold row is the hard',
    'quadrant, `app_code` that does not reproduce on rerun — where a field that only matters for',
    'difficult cases would show.',
  ].join('\n')
}

function renderBuckets(study: Study, extra: Extra | null): string {
  const columns = columnsFor(study, extra)
  const reference = columns.find((column) => column.evaluation !== null)?.evaluation ?? null
  const truth = reference === null ? [] : headline(reference)
  const buckets = [...new Set(truth.map((f) => f.labels.bucket))].sort()

  const rows = buckets.map((bucket) => [
    code(bucket),
    String(truth.filter((f) => f.labels.bucket === bucket).length),
    ...columns.map((column) =>
      column.evaluation === null
        ? NONE
        : String(
            headline(column.evaluation).filter((f) => f.labels.bucket === bucket && jointlyRight(f))
              .length,
          ),
    ),
  ])

  return [
    markdownTable(['bucket', 'n', ...columns.map((column) => column.name)], rows, [
      'left',
      'right',
      ...columns.map((): Align => 'right'),
    ]),
    '',
    'Jointly correct fixtures per difficulty bucket. Each adversarial bucket was built to defeat one',
    'kind of reasoning — `misleading-history` punishes reading the flakiness score alone,',
    '`environment-as-regression` and `stale-test` punish reading the diff alone — so a variant that',
    'removes the input a bucket attacks is expected to move that bucket first.',
  ].join('\n')
}

function renderCost(study: Study): string {
  const ran = study.runs.filter(
    (run): run is VariantRun & { evaluation: Evaluation } => run.evaluation !== null,
  )
  const spent = ran.some(
    (run) => run.evaluation.cost.inputTokens + run.evaluation.cost.outputTokens > 0,
  )

  if (!spent) {
    return [
      'No variant made a model call, so every row costs nothing and spends no tokens. The column is',
      "there because the agent's run fills it: a field is pruned on accuracy _and_ price, and a",
      'variant that loses a point while halving the prompt is a different decision from one that',
      'loses a point for nothing.',
    ].join('\n')
  }

  const unpriced = [...new Set(ran.flatMap((run) => run.evaluation.cost.unpricedModels))].sort()
  return [
    markdownTable(
      ['variant', 'input tokens', 'output tokens', 'total', 'per fixture'],
      ran.map((run) => [
        run.variant.name,
        String(run.evaluation.cost.inputTokens),
        String(run.evaluation.cost.outputTokens),
        formatUsd(run.evaluation.cost.usd),
        costPerFixture(run.evaluation),
      ]),
      ['left', 'right', 'right', 'right', 'right'],
    ),
    '',
    `At ${String(study.samples)} sample(s) per fixture. In replay these are the tokens the recorded responses`,
    'cost when they were recorded — nothing was spent producing this report.',
    ...(unpriced.length === 0
      ? []
      : ['', `Unpriced models, counted at nothing: ${unpriced.map(code).join(', ')}.`]),
  ].join('\n')
}

function renderVariants(): string {
  const withheldRows = VARIANTS.map((variant) => [
    variant.name,
    variant.reference === undefined
      ? variant.question
      : `${variant.question} (${link(variant.reference)})`,
    variant.withheld.length === 0
      ? 'nothing'
      : variant.withheld.length > INPUT_NAMES.length / 2
        ? `every field but ${INPUT_NAMES.filter((name) => !variant.withheld.includes(name))
            .flatMap((name) => INPUTS[name].fields)
            .map(code)
            .join(', ')}`
        : withheldFields(variant.withheld).map(code).join(', '),
  ])

  const otherRows = OTHER_VARIANTS.map((variant) => [
    variant.name,
    variant.reference === undefined
      ? variant.question
      : `${variant.question} (${link(variant.reference)})`,
    variant.status,
  ])

  const inputRows = INPUT_NAMES.map((name) => [
    INPUTS[name].label,
    INPUTS[name].fields.map(code).join(', '),
    INPUTS[name].blankedAs,
  ])

  return [
    '### What each variant withholds',
    '',
    'The context variants in [the methodology](../docs/eval-methodology.md#ablation-study), and the',
    "assembler fields each one takes out of the agent's prompt.",
    '',
    markdownTable(['variant', 'question it answers', 'withheld from the context'], withheldRows, [
      'left',
      'left',
      'left',
    ]),
    '',
    '### Not varied here',
    '',
    "The rest of the methodology's table varies the classifier rather than its input.",
    '',
    markdownTable(['variant', 'question it answers', 'status'], otherRows, [
      'left',
      'left',
      'left',
    ]),
    '',
    '### How a withheld input reaches each classifier',
    '',
    '**The agent is told.** `agents/context.ts` drops the fields from the prompt and names them in a',
    'line saying they were withheld on purpose — never as missing from the repository, because "no',
    'stack trace was captured" and "we chose not to send one" are different inputs, and only the',
    'second is the variable. With nothing withheld the prompt is byte-identical to the one',
    '`npm run eval` sends, so the full-context row replays the same cassettes.',
    '',
    '**The baseline is handed less.** It reads the raw input rather than a prompt, so there is',
    'nobody to tell; the input itself is blanked, to the value that carries no signal. Both start',
    'from the same list, so neither classifier can be denied something the other still sees.',
    '',
    markdownTable(['input', 'context fields', 'the baseline is handed'], inputRows, [
      'left',
      'left',
      'left',
    ]),
  ].join('\n')
}

function renderHowToRead(ablation: Ablation): string {
  const reference = baselineReference(ablation)
  const width =
    (reference.metrics.joint.interval.upper - reference.metrics.joint.interval.lower) * 100

  return [
    '**Joint accuracy is the number**, as in `eval/report.md`: both axes right on the same fixture.',
    '',
    '**Beyond the interval means the two intervals do not overlap.** It is the rule the main report',
    'applies, and it is conservative — every row scores the same fixtures, so a paired test would',
    `detect smaller moves. At n = ${String(reference.metrics.n)} the full-context interval alone is ${width.toFixed(1)} points wide,`,
    'so most single-field effects land inside it. "Within noise" is a statement about the size of',
    'the dataset, not evidence that a field does nothing.',
    '',
    '**`changed` is the paired measurement.** It counts fixtures whose answer moved, which the',
    'intervals cannot see: a variant can move several predictions and leave accuracy unchanged.',
    '',
    '**A row the baseline ignores is not a finding about the field.** The baseline reads a handful',
    'of inputs by rule. Where withholding one changes nothing on fixtures that carry it, the rules',
    'never consult it — the agent may still depend on it. Where no fixture carries it, nothing was',
    'measured at all.',
    '',
    '**Development slice only.** An ablation is iteration, and the held-out slice is for confirming',
    'a result. Ablating it would spend the budget in `eval/holdout-log.json` on runs nobody uses to',
    'confirm anything.',
    '',
    `**Regenerate with** \`${regenerateCommand(ablation.options)}\`.`,
    ...(ablation.options.classifier === 'baseline'
      ? [
          'CI runs the same command with `--check` on every pull request and fails when this file is',
          'stale.',
        ]
      : []),
    'Full methodology: [`docs/eval-methodology.md`](../docs/eval-methodology.md#ablation-study).',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
  npm run eval:ablation -- [options]

    --classifier=agent|baseline   which classifier to ablate  (default: agent)
    --n=<number>                  samples per fixture         (default: 5 agent, 1 baseline)
    --check                       verify the committed report matches a fresh run; writes nothing
    --out=<path>                  where to write              (default: ${ABLATION_PATH})

  Always the development slice. The held-out slice is never ablated.
`

/** Indents the text and not the blank lines — a trailing space shows up in captured output. */
const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n')

function readCommitted(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The agent's variants, one line each, for a run that could not score any of them. */
function notRunMessage(study: Study, out: string): string {
  const width = Math.max(...study.runs.map((run) => run.variant.name.length))
  return [
    '',
    "The agent's ablation could not run: no variant has cassettes to replay.",
    '',
    ...study.runs.map(
      (run) => `  ${run.variant.name.padEnd(width)}   not run — ${run.notRun ?? ''}`,
    ),
    '',
    'Replay never falls through to a live call. Recording needs credentials, and is #38:',
    '',
    '  SENTRA_RECORD=1 npm run eval:ablation',
    '',
    'What runs today is the baseline control, which needs no model:',
    '',
    '  npm run eval:ablation -- --classifier=baseline',
    '',
    `Nothing was measured, so ${out} was left as it is.`,
    '',
  ].join('\n')
}

export async function main(argv: string[], deps: AblationDeps = {}): Promise<number> {
  let options: AblationOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    return 2
  }

  let ablation: Ablation
  try {
    if (options.classifier === 'agent') {
      const mode = resolveMode(deps.env ?? process.env)
      if (mode !== 'replay') {
        console.log(
          `\n  Model calls are \`${mode}\`: ${String(VARIANTS.length)} variants, each a full run over the development slice at ${String(options.samples)} sample(s) per fixture. This costs money.\n`,
        )
      }
    }
    ablation = await ablate(options, deps)
  } catch (error) {
    // Same shape as `npm run eval`: a run that could not finish is exit 1, and
    // what the reader needs is the message rather than a stack trace.
    console.error(
      `\n  The ablation could not finish.\n\n${indent(error instanceof Error ? error.message : String(error))}\n`,
    )
    return 1
  }

  const agent = studyOf(ablation, 'agent')
  if (agent?.runs.every((run) => run.evaluation === null) === true) {
    console.error(indent(notRunMessage(agent, options.out)))
    return 1
  }

  const report = await buildAblation(ablation)

  if (options.check) {
    const committed = readCommitted(options.out)
    if (committed === report) {
      console.log(`\n  ${options.out} is up to date.\n`)
      return 0
    }
    console.error(
      [
        '',
        `  ${options.out} does not match what this run produces.`,
        '',
        committed === null
          ? '  The file is missing entirely.'
          : '  Either a classifier or the dataset changed and the study was not regenerated, or the\n  file was edited by hand. Both are fixed the same way:',
        '',
        `    ${regenerateCommand(options)}`,
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

if (process.argv[1]?.endsWith('ablation.ts') === true) {
  process.exitCode = await main(process.argv.slice(2))
}
