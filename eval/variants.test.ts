import { readFileSync } from 'node:fs'
import {
  assembleContext,
  classifyWithBaseline,
  CONTEXT_FIELDS,
  renderContext,
} from '@sentra/agents'
import type { ClassificationInput } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { listFixtures, loadPayload } from './dataset.js'
import { sliceOf } from './slices.js'
import {
  carries,
  contextFor,
  describeWithheld,
  INPUT_NAMES,
  INPUTS,
  OTHER_VARIANTS,
  VARIANTS,
  withhold,
  withheldFields,
  type InputName,
} from './variants.js'

/**
 * Fixtures from the development slice only. These tests read payloads to check
 * what a variant does to them, and the held-out slice has no business being an
 * input to anything that is iterated on — including a test.
 */
const dev: ClassificationInput[] = listFixtures()
  .filter((name) => sliceOf(name) === 'dev')
  .map((name) => loadPayload(name).payload)

const fixture = (predicate: (input: ClassificationInput) => boolean): ClassificationInput => {
  const found = dev.find(predicate)
  if (found === undefined) throw new Error('no development fixture has the shape this test needs')
  return found
}

const withEverything = fixture(
  (input) =>
    input.diff !== undefined &&
    input.testSource !== undefined &&
    input.subject.result.error?.stack !== undefined &&
    input.subject.result.error.snippet !== undefined,
)

/** The one input no committed fixture carries yet, added so its blank has something to remove. */
const withRunContext: ClassificationInput = {
  ...withEverything,
  runContext: {
    workerIndex: 0,
    before: [{ testId: 'a', title: 'a neighbour', file: 'tests/a.spec.ts', status: 'passed' }],
    omitted: 0,
  },
}

describe('the inputs a variant can withhold', () => {
  it("cover every assembler field exactly once, in the assembler's order", () => {
    // The partition is the property that keeps the two classifiers' deprivation
    // identical. A field outside every input could never be withheld from the
    // agent; a field in two would be withheld by a variant that names neither.
    expect(INPUT_NAMES.flatMap((name) => INPUTS[name].fields)).toEqual([...CONTEXT_FIELDS])
  })

  it('apply the run outcome before the history', () => {
    // A cache miss scores this run's status. The other order would leave a
    // timed-out status behind in the one-letter history after both are withheld.
    expect(INPUT_NAMES.indexOf('runOutcome')).toBeLessThan(INPUT_NAMES.indexOf('history'))
  })

  it.each(INPUT_NAMES)('%s has a label and a description for the report', (name) => {
    expect(INPUTS[name].label.length).toBeGreaterThan(0)
    expect(INPUTS[name].blankedAs.length).toBeGreaterThan(0)
  })
})

describe('withhold', () => {
  it('is the identity when nothing is withheld', () => {
    // Not merely equal: the full-context baseline must be handed the very input
    // `npm run eval` hands it, or the reference row is a different measurement.
    expect(withhold(withEverything, [])).toBe(withEverything)
  })

  it('never edits the input it was given', () => {
    const before = JSON.stringify(withRunContext)
    withhold(withRunContext, INPUT_NAMES)
    expect(JSON.stringify(withRunContext)).toBe(before)
  })

  it('gives the same result whatever order the names arrive in', () => {
    const timedOut: ClassificationInput = {
      ...withEverything,
      subject: {
        ...withEverything.subject,
        result: { ...withEverything.subject.result, status: 'timedOut' },
      },
    }
    expect(withhold(timedOut, ['history', 'runOutcome'])).toEqual(
      withhold(timedOut, ['runOutcome', 'history']),
    )
    expect(withhold(timedOut, ['history', 'runOutcome']).subject.signal.statusHistory).toBe('F')
  })

  it('removes the diff, the test source and the run context outright', () => {
    const blanked = withhold(withRunContext, ['diff', 'testSource', 'runContext'])
    expect(blanked).not.toHaveProperty('diff')
    expect(blanked).not.toHaveProperty('testSource')
    expect(blanked).not.toHaveProperty('runContext')
  })

  it('blanks the error a piece at a time', () => {
    const error = (names: InputName[]) => withhold(withEverything, names).subject.result.error
    expect(error(['errorStack'])).not.toHaveProperty('stack')
    expect(error(['errorStack'])?.message).toBe(withEverything.subject.result.error?.message)
    expect(error(['errorSnippet'])).not.toHaveProperty('snippet')
    expect(error(['errorMessage'])?.message).toBe('')
    expect(error(['errorMessage'])?.stack).toBe(withEverything.subject.result.error?.stack)
  })

  it('leaves a result with no error alone', () => {
    const { error: _error, ...result } = withEverything.subject.result
    const clean: ClassificationInput = {
      ...withEverything,
      subject: { ...withEverything.subject, result },
    }
    const blanked = withhold(clean, ['errorMessage', 'errorStack', 'errorSnippet'])
    expect(blanked.subject.result).toEqual(result)
  })

  it('blanks the title, the path and the run outcome to values that carry nothing', () => {
    const { result } = withhold(withEverything, ['testTitle', 'testFile', 'runOutcome']).subject
    expect(result).toMatchObject({
      title: '',
      file: '',
      status: 'failed',
      attempts: 1,
      flakyWithinRun: false,
      durationMs: 0,
    })
    // The key the run is filed under is not context and is not withheld.
    expect(result.testId).toBe(withEverything.subject.result.testId)
  })

  it('replaces the history with what a cache miss produces', () => {
    const streak = fixture(
      (input) =>
        input.subject.signal.consecutiveFailures >= 3 && input.subject.result.status === 'failed',
    )
    const blanked = withhold(streak, ['history'])
    expect(blanked.historyAvailable).toBe(false)
    expect(blanked.subject.signal).toMatchObject({
      statusHistory: 'F',
      consecutiveFailures: 1,
      totalRuns: 1,
      isNew: true,
      flakinessScore: 0,
      lastPassedAt: null,
    })
  })

  it('scores a retry that passed as instability even with no history, as the analyser does', () => {
    const retried = fixture((input) => input.subject.result.flakyWithinRun)
    expect(withhold(retried, ['history']).subject.signal.flakinessScore).toBe(1)
  })

  it('takes away from the baseline what the variant names', () => {
    // A fixture whose baseline answer rests on a failure streak, and one whose
    // ownership rests on the diff: each must lose exactly that.
    const streak = fixture((input) => classifyWithBaseline(input).determinism === 'deterministic')
    expect(classifyWithBaseline(withhold(streak, ['history'])).determinism).toBe('intermittent')

    const fromDiff = fixture((input) =>
      classifyWithBaseline(input).reasoning.includes('the commit changes product source'),
    )
    expect(classifyWithBaseline(withhold(fromDiff, ['diff'])).reasoning).not.toContain(
      'the commit changes product source',
    )
  })
})

describe('carries', () => {
  it('says whether a variant has anything to take away', () => {
    expect(carries(withEverything, ['diff'])).toBe(true)
    expect(carries(withEverything, ['runContext'])).toBe(false)
    expect(carries(withRunContext, ['runContext'])).toBe(true)
    expect(carries(withEverything, [])).toBe(false)
  })

  it('is false for every input once that input has been withheld', () => {
    // Except the run outcome, which every result has: blanking it leaves a
    // neutral outcome rather than none.
    const blanked = withhold(withRunContext, INPUT_NAMES)
    for (const name of INPUT_NAMES.filter((n) => n !== 'runOutcome')) {
      expect(carries(blanked, [name]), name).toBe(false)
    }
  })
})

describe('the agent is told rather than deprived', () => {
  it('drops exactly the fields an input feeds', () => {
    expect(assembleContext(withEverything, contextFor(['diff'])).omitted).toEqual([
      'diffSummary',
      'diffHunks',
      'derivedDiffSignal',
    ])
  })

  it('says in the prompt what was withheld', () => {
    expect(renderContext(assembleContext(withEverything, contextFor(['history'])))).toContain(
      'Withheld from this run on purpose (ablation): flakinessSignal, statusHistory.',
    )
  })

  it('renders the prompt `npm run eval` sends when nothing is withheld', () => {
    // So the full-context row replays the main evaluation's cassettes rather
    // than needing a second recording of the same request.
    expect(renderContext(assembleContext(withEverything, contextFor([])))).toBe(
      renderContext(assembleContext(withEverything)),
    )
  })

  it("names fields in the assembler's order whatever order the inputs arrive in", () => {
    expect(withheldFields(['diff', 'history'])).toEqual(withheldFields(['history', 'diff']))
  })
})

describe('the variants', () => {
  it('lead with the full context, which every row is compared against', () => {
    expect(VARIANTS[0]).toMatchObject({ name: 'Full context', withheld: [] })
  })

  it('have unique names', () => {
    const names = [...VARIANTS, ...OTHER_VARIANTS].map((variant) => variant.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('leave nothing but the error message in "Error message only"', () => {
    const only = VARIANTS.find((variant) => variant.name === 'Error message only')
    expect(withheldFields(only?.withheld ?? [])).toEqual(
      CONTEXT_FIELDS.filter((field) => field !== 'errorMessage'),
    )
  })

  /**
   * The methodology's table is the specification, so the code is checked
   * against it rather than the other way round. A row added to the document
   * with no variant behind it — or a variant nobody documented — fails here.
   */
  it("are exactly the rows of the methodology's ablation table", () => {
    const doc = readFileSync('docs/eval-methodology.md', 'utf8')
    const lines = doc.slice(doc.indexOf('## Ablation study')).split('\n')
    const start = lines.findIndex((line) => line.startsWith('|'))
    const end = lines.findIndex((line, index) => index > start && !line.startsWith('|'))
    // Past the header and its divider, up to the first line that is not a row.
    const rows = lines.slice(start + 2, end).map((line) => line.split('|')[1]?.trim() ?? '')

    expect(rows).toEqual([...VARIANTS, ...OTHER_VARIANTS].map((variant) => variant.name))
  })
})

describe('describeWithheld', () => {
  it.each([
    [[], 'nothing'],
    [['diff'], 'diff'],
    [['diff', 'history'], 'history, diff'],
    [INPUT_NAMES.filter((name) => name !== 'errorMessage'), 'all but the error message'],
    [INPUT_NAMES, 'everything'],
  ] as [InputName[], string][])('%j reads as "%s"', (names, expected) => {
    expect(describeWithheld(names)).toBe(expected)
  })
})
