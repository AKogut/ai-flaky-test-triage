import { CONTEXT_FIELDS, type ContextField, type ContextOptions } from '@sentra/agents'
import {
  emptyHistory,
  type ClassificationInput,
  type TestError,
  type TestResult,
} from '@sentra/contracts'
import { analyse } from '@sentra/flakemetry'

/**
 * What the ablation study varies, and how a withheld input reaches each
 * classifier.
 *
 * The variants are the table in docs/eval-methodology.md#ablation-study, one
 * entry each, and a test reads that table so the two cannot drift. Each one is an
 * argument rather than a rewiring: a list of inputs to withhold, handed to the
 * same classifier seam `npm run eval` uses.
 *
 * ## One list, applied two ways
 *
 * The agent and the baseline read their input differently, so "withhold the
 * diff" cannot mean the same operation for both — only the same information.
 *
 * - **The agent is told.** `agents/context.ts` drops the fields from the prompt
 *   and names them in a line saying they were withheld on purpose. That is the
 *   assembler's own design, and the reason it exists: "no stack trace was
 *   captured" and "we chose not to send one" are different inputs, and only the
 *   second is the variable being measured.
 * - **The baseline is handed less.** It reads the raw `ClassificationInput`, not
 *   a prompt, so there is nobody to tell. The input itself is blanked, to the
 *   value that carries no signal for that input.
 *
 * Both start from the same `INPUTS` entry, so neither can be denied something
 * the other still sees.
 *
 * ## Inputs, not fields
 *
 * The unit is an input — a part of `ClassificationInput` — rather than one of
 * the assembler's thirteen fields, because three of those fields are views of
 * one string. `diffSummary`, `diffHunks` and `derivedDiffSignal` are all derived
 * from `diff`, and there is no raw-input operation that removes the hunks while
 * keeping the paths. Withholding by input keeps the two classifiers' deprivation
 * identical by construction; a field-level variant would have to be a fiction
 * for one of them.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface Input {
  /** How the report names it. */
  label: string
  /** The assembler fields it feeds — what the agent's prompt loses. */
  fields: readonly ContextField[]
  /** What the baseline is handed instead, in words, for the report. */
  blankedAs: string
  /** The same thing as a function. Pure: returns a new input, never edits one. */
  blank: (input: ClassificationInput) => ClassificationInput
  /**
   * Whether this input carries anything to withhold.
   *
   * A variant over fixtures that never had the input cannot differ from the full
   * context, and the report says so rather than presenting the identical row as
   * a finding.
   */
  present: (input: ClassificationInput) => boolean
}

const withResult = (
  input: ClassificationInput,
  change: (result: TestResult) => TestResult,
): ClassificationInput => ({
  ...input,
  subject: { ...input.subject, result: change(input.subject.result) },
})

/** A result with no error is left alone: there is nothing to withhold from it. */
const withError = (
  input: ClassificationInput,
  change: (error: TestError) => TestError,
): ClassificationInput =>
  withResult(input, (result) =>
    result.error === undefined ? result : { ...result, error: change(result.error) },
  )

/**
 * The signal a cache miss produces, computed rather than imitated.
 *
 * "No history" has a real-world form, and it is this one: the analyser run
 * against an empty history, which scores the test on this run alone and sets
 * `historyAvailable: false`. Handing the baseline that — rather than zeroes
 * chosen here — means the variant tests an input the pipeline actually produces,
 * by the same code that produces it. A hand-written blank would be a second
 * definition of "no history", and the first one to drift.
 *
 * The run is synthetic and dated from the fixture's own `firstSeenAt`, so the
 * result is deterministic. Nothing but the signal is read back.
 */
function cacheMiss(input: ClassificationInput): ClassificationInput {
  const { result, signal } = input.subject
  const at = signal.firstSeenAt
  const analysis = analyse(
    {
      runId: 'ablation',
      commitSha: '0000000',
      branch: 'ablation',
      startedAt: at,
      durationMs: result.durationMs,
      source: 'synthetic',
      results: [result],
    },
    emptyHistory(),
    { analysedAt: at },
  )

  const scored = analysis.tests[0]
  if (scored === undefined) throw new Error('the analyser scored no test from a one-result run')

  return {
    ...input,
    subject: { ...input.subject, signal: scored.signal },
    historyAvailable: analysis.historyAvailable,
  }
}

/**
 * Every input, in the order they are applied.
 *
 * The order matters once, and it is written down rather than left to chance:
 * `runOutcome` comes before `history`, because a cache miss scores the test on
 * this run's status. Withholding both must not leave the original status behind
 * in a one-letter history.
 *
 * `testId` is not an input. It is the key the run is filed under, never
 * rendered into a prompt and never read by a rule, so it stays.
 */
export const INPUTS = {
  testTitle: {
    label: 'test title',
    fields: ['testTitle'],
    blankedAs: 'an empty title',
    blank: (input) => withResult(input, (result) => ({ ...result, title: '' })),
    present: (input) => input.subject.result.title !== '',
  },
  testFile: {
    label: 'test file',
    fields: ['testFile'],
    blankedAs: 'an empty path',
    blank: (input) => withResult(input, (result) => ({ ...result, file: '' })),
    present: (input) => input.subject.result.file !== '',
  },
  runOutcome: {
    label: 'run outcome',
    fields: ['runOutcome'],
    blankedAs: 'one attempt, no pass on retry, status `failed`, no duration',
    blank: (input) =>
      withResult(input, (result) => ({
        ...result,
        status: 'failed',
        attempts: 1,
        flakyWithinRun: false,
        durationMs: 0,
      })),
    // Every result has an outcome; there is no run without one.
    present: () => true,
  },
  errorMessage: {
    label: 'error message',
    fields: ['errorMessage'],
    blankedAs: 'an empty message',
    blank: (input) => withError(input, (error) => ({ ...error, message: '' })),
    present: (input) => (input.subject.result.error?.message ?? '') !== '',
  },
  errorStack: {
    label: 'stack',
    fields: ['errorStack'],
    blankedAs: 'no stack',
    blank: (input) => withError(input, ({ stack: _stack, ...error }) => error),
    present: (input) => input.subject.result.error?.stack !== undefined,
  },
  errorSnippet: {
    label: 'snippet',
    fields: ['errorSnippet'],
    blankedAs: 'no snippet',
    blank: (input) => withError(input, ({ snippet: _snippet, ...error }) => error),
    present: (input) => input.subject.result.error?.snippet !== undefined,
  },
  history: {
    label: 'history',
    fields: ['flakinessSignal', 'statusHistory'],
    blankedAs:
      'what the analyser emits on a cache miss — this run alone, `historyAvailable: false`',
    blank: cacheMiss,
    present: (input) => input.historyAvailable,
  },
  testSource: {
    label: 'test source',
    fields: ['testSource'],
    blankedAs: 'no test source',
    blank: ({ testSource: _testSource, ...input }) => input,
    present: (input) => input.testSource !== undefined,
  },
  runContext: {
    label: 'run context',
    fields: ['runContext'],
    blankedAs: 'no run context',
    blank: ({ runContext: _runContext, ...input }) => input,
    present: (input) => input.runContext !== undefined,
  },
  diff: {
    label: 'diff',
    fields: ['diffSummary', 'diffHunks', 'derivedDiffSignal'],
    blankedAs: 'no diff',
    blank: ({ diff: _diff, ...input }) => input,
    present: (input) => (input.diff ?? '') !== '',
  },
} as const satisfies Record<string, Input>

export type InputName = keyof typeof INPUTS

export const INPUT_NAMES = Object.keys(INPUTS) as InputName[]

/** The input as the baseline sees it with `names` withheld. Order-independent; see `INPUTS`. */
export function withhold(
  input: ClassificationInput,
  names: readonly InputName[],
): ClassificationInput {
  return INPUT_NAMES.filter((name) => names.includes(name)).reduce<ClassificationInput>(
    (current, name) => INPUTS[name].blank(current),
    input,
  )
}

/** Whether withholding `names` takes anything away from this input. */
export function carries(input: ClassificationInput, names: readonly InputName[]): boolean {
  return names.some((name) => INPUTS[name].present(input))
}

/** The assembler fields `names` feed, in the assembler's own order. */
export function withheldFields(names: readonly InputName[]): ContextField[] {
  const dropped = new Set<ContextField>(names.flatMap((name) => INPUTS[name].fields))
  return CONTEXT_FIELDS.filter((field) => dropped.has(field))
}

/**
 * The same withholding, as the agent's assembler takes it.
 *
 * Nothing withheld is an empty selection, which assembles exactly the prompt
 * `npm run eval` sends — so the full-context variant shares its cassettes rather
 * than needing a second recording of the same request.
 */
export function contextFor(names: readonly InputName[]): ContextOptions {
  return {
    include: Object.fromEntries(withheldFields(names).map((field) => [field, false])),
  }
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/** Where a question is tracked, when it is tracked somewhere. */
export interface Reference {
  label: string
  href: string
}

export interface Variant {
  /** As the methodology's table names it. */
  name: string
  /** The question the methodology says it answers. */
  question: string
  withheld: readonly InputName[]
  reference?: Reference
}

const REPO = 'https://github.com/AKogut/ai-flaky-test-triage'
const issue = (n: number): Reference => ({
  label: `#${String(n)}`,
  href: `${REPO}/issues/${String(n)}`,
})

const allBut = (...kept: InputName[]): InputName[] =>
  INPUT_NAMES.filter((name) => !kept.includes(name))

/**
 * The context variants, reference first.
 *
 * Every row compares against the first, so it has to be the full context; a
 * test pins that.
 *
 * "No run context" is the one row the methodology's table did not list before
 * this harness existed. ADR-0008 added the field after the table was written and
 * named this study as what decides whether it stays, so the table gained the row
 * in the same change as the code.
 */
export const VARIANTS: readonly Variant[] = [
  { name: 'Full context', question: 'Reference', withheld: [] },
  {
    name: 'No history',
    question: 'How much does the flakiness signal contribute?',
    withheld: ['history'],
    reference: issue(79),
  },
  { name: 'No diff', question: 'How much does git context contribute?', withheld: ['diff'] },
  { name: 'No test source', question: 'Does reading the test matter?', withheld: ['testSource'] },
  {
    name: 'No run context',
    question: 'Does the worker sequence earn its place?',
    withheld: ['runContext'],
    reference: {
      label: 'ADR-0008',
      href: '../docs/adr/0008-run-level-context-is-the-worker-sequence.md',
    },
  },
  {
    name: 'Error message only',
    question: 'How far does the trivial input get?',
    withheld: allBut('errorMessage'),
  },
]

/**
 * The rest of the methodology's table: rows that vary the classifier rather
 * than its input.
 *
 * Listed so the report can say what happened to each of them instead of
 * dropping them silently — a table with three rows missing reads as a study that
 * covered everything.
 */
export const OTHER_VARIANTS: readonly (Omit<Variant, 'withheld'> & { status: string })[] = [
  {
    name: 'Baseline heuristic',
    question: 'Is the LLM needed at all?',
    status: "run — the classifier the baseline control ablates, and a row in the agent's study",
  },
  {
    name: 'Multi-step agent variant',
    question: 'Does a loop beat one call?',
    status: 'not built — a different agent, not a different input',
    reference: issue(80),
  },
  {
    name: 'Smaller model',
    question: 'What does the capability tier buy?',
    status: 'not built — a different model, not a different input',
    reference: issue(81),
  },
]

/** `history`, `diff` — or, past half of them, what was kept: `all but the error message`. */
export function describeWithheld(names: readonly InputName[]): string {
  if (names.length === 0) return 'nothing'
  const kept = INPUT_NAMES.filter((name) => !names.includes(name))
  if (kept.length === 0) return 'everything'
  return names.length > kept.length
    ? `all but the ${kept.map((name) => INPUTS[name].label).join(', ')}`
    : INPUT_NAMES.filter((name) => names.includes(name))
        .map((name) => INPUTS[name].label)
        .join(', ')
}
