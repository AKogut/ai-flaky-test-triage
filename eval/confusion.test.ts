import type { Determinism, FixtureLabels, Owner } from '@sentra/contracts'
import { format } from 'prettier'
import { describe, expect, it } from 'vitest'
import { classifyWithBaseline } from './baseline.js'
import {
  confusionMatrix,
  partitionByGroundTruthConfidence,
  quadrantBreakdown,
  renderBreakdown,
  renderBreakdownSections,
  renderConfusionMatrix,
  renderQuadrantTable,
  scoreBy,
  type ScoredFixture,
} from './confusion.js'
import { loadAllPayloads, loadLabels } from './dataset.js'
import type { Judgement } from './metrics.js'

const judge = (
  actual: [Owner, Determinism],
  predicted: [Owner, Determinism],
  name = 'f',
): Judgement => ({
  name,
  actual: { owner: actual[0], determinism: actual[1] },
  predicted: { owner: predicted[0], determinism: predicted[1] },
})

describe('confusionMatrix orientation', () => {
  /**
   * Deliberately asymmetric: one fixture that is `app_code` and was called
   * `test_code`, and nothing in the opposite cell. A transposed implementation
   * passes every symmetric test ever written, and inverts precision and recall
   * while producing a table that looks entirely reasonable.
   */
  const judgements = [
    judge(['app_code', 'deterministic'], ['test_code', 'deterministic'], 'a'),
    judge(['app_code', 'deterministic'], ['app_code', 'deterministic'], 'b'),
  ]
  const matrix = confusionMatrix(judgements, 'owner')

  it('indexes counts as [actual][predicted]', () => {
    const actualAppCode = matrix.labels.indexOf('app_code')
    const predictedTestCode = matrix.labels.indexOf('test_code')
    expect(matrix.counts[actualAppCode]?.[predictedTestCode]).toBe(1)
    expect(matrix.counts[predictedTestCode]?.[actualAppCode]).toBe(0)
  })

  it('totals rows by support and columns by prediction count', () => {
    expect(matrix.rowTotals).toEqual([2, 0, 0])
    expect(matrix.columnTotals).toEqual([1, 1, 0])
    expect(matrix.total).toBe(2)
  })

  it('covers every fixture exactly once', () => {
    const cells = matrix.counts.flat().reduce((a, b) => a + b, 0)
    expect(cells).toBe(matrix.total)
  })

  it('has one row and column per schema value, present or not', () => {
    expect(confusionMatrix([], 'owner').labels).toHaveLength(3)
    expect(confusionMatrix([], 'determinism').labels).toHaveLength(2)
  })
})

describe('rendering a confusion matrix', () => {
  const rendered = renderConfusionMatrix(
    confusionMatrix(
      [
        judge(['app_code', 'deterministic'], ['app_code', 'deterministic'], 'a'),
        judge(['test_code', 'deterministic'], ['app_code', 'deterministic'], 'b'),
      ],
      'owner',
    ),
  )

  it('says which axis is which, in the table itself', () => {
    // A reader who takes the transposed reading gets a plausible, wrong answer.
    expect(rendered).toContain('actual ↓ / predicted →')
    expect(rendered).toMatch(/Rows are ground truth/)
  })

  it('bolds the diagonal so the error shape is visible before the numbers', () => {
    expect(rendered).toContain('**1**')
  })

  it('carries row and column totals', () => {
    expect(rendered).toContain('**total**')
    expect(rendered).toContain('**2**')
  })
})

describe('quadrant breakdown', () => {
  const judgements = [
    ...Array.from({ length: 3 }, (_, i) =>
      judge(['app_code', 'intermittent'], ['app_code', 'intermittent'], `hit${String(i)}`),
    ),
    judge(['app_code', 'intermittent'], ['app_code', 'deterministic'], 'miss'),
    judge(['test_code', 'deterministic'], ['test_code', 'deterministic'], 'other'),
  ]
  const rows = quadrantBreakdown(judgements)
  const hard = rows.find((r) => r.hard)

  it('reports all six cells whether or not they have fixtures', () => {
    expect(rows).toHaveLength(6)
    expect(rows.filter((r) => r.support === 0)).not.toHaveLength(0)
  })

  it('flags exactly one quadrant as hard', () => {
    expect(rows.filter((r) => r.hard)).toHaveLength(1)
    expect(hard).toMatchObject({ owner: 'app_code', determinism: 'intermittent' })
  })

  it('counts a quadrant hit only when both axes land in it', () => {
    // The `miss` fixture is app_code and intermittent, and the classifier got
    // the owner right. It is still not a hit.
    expect(hard).toMatchObject({ support: 4, correct: 3 })
  })

  it('renders the hard quadrant in bold with a legend', () => {
    const rendered = renderQuadrantTable(rows)
    expect(rendered).toContain('**`app_code` + `intermittent`**')
    expect(rendered).toContain('hard quadrant')
  })

  it('prints n/a for a quadrant with no fixtures rather than 0%', () => {
    // 0% would read as failing cases that do not exist.
    expect(renderQuadrantTable(rows)).toContain('n/a')
  })
})

describe('grouped breakdowns', () => {
  const judgements = [
    judge(['app_code', 'intermittent'], ['app_code', 'intermittent'], 'a'),
    judge(['test_code', 'deterministic'], ['app_code', 'deterministic'], 'b'),
    judge(['test_code', 'deterministic'], ['test_code', 'deterministic'], 'c'),
  ]

  it('scores each group independently', () => {
    const groups = scoreBy(judgements, (j) => (j.name === 'a' ? 'first' : 'second'))
    expect(groups.map((g) => g.group)).toEqual(['first', 'second'])
    expect(groups[0]?.metrics.joint.point).toBe(1)
    expect(groups[1]?.metrics.joint.point).toBe(0.5)
  })

  it('sorts groups so the report does not churn between runs', () => {
    const groups = scoreBy(judgements, (j) => ({ a: 'zeta', b: 'alpha', c: 'mid' })[j.name] ?? '')
    expect(groups.map((g) => g.group)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('replaces a single-group table with a sentence explaining why', () => {
    // One row is not a breakdown; it restates the headline in a layout that
    // looks like analysis.
    const rendered = renderBreakdown(
      'provenance',
      scoreBy(judgements, () => 'synthetic'),
      3,
    )
    expect(rendered).not.toContain('|')
    expect(rendered).toContain('`synthetic`')
    expect(rendered).toContain('repeat the headline')
  })

  it('renders a table once the dimension has more than one value', () => {
    const rendered = renderBreakdown(
      'bucket',
      scoreBy(judgements, (j) => (j.name === 'a' ? 'hard-quadrant' : 'stale-test')),
      3,
    )
    expect(rendered).toContain('| bucket')
    expect(rendered).toContain('`hard-quadrant`')
  })

  it('says so plainly when there is nothing to break down', () => {
    expect(renderBreakdown('provenance', [], 0)).toContain('No fixtures')
  })
})

// ---------------------------------------------------------------------------

const labelsFor = (over: Partial<FixtureLabels> = {}): FixtureLabels => ({
  name: 'f',
  owner: 'app_code',
  determinism: 'intermittent',
  justification: 'x'.repeat(200),
  ruleApplied: 'rule-4-default-app-code',
  provenance: 'synthetic',
  bucket: 'hard-quadrant',
  lowConfidenceGroundTruth: false,
  ...over,
})

describe('low-confidence ground truth', () => {
  const fixtures: ScoredFixture[] = [
    {
      judgement: judge(['app_code', 'intermittent'], ['app_code', 'intermittent'], 'solid'),
      labels: labelsFor(),
    },
    {
      judgement: judge(['app_code', 'intermittent'], ['test_code', 'deterministic'], 'arguable'),
      labels: labelsFor({
        name: 'arguable',
        lowConfidenceGroundTruth: true,
        justification: `Either reading is defensible here. ${'x'.repeat(150)}`,
      }),
    },
  ]

  it('keeps arguable fixtures out of the headline set', () => {
    const { headline, lowConfidence } = partitionByGroundTruthConfidence(fixtures)
    expect(headline.map((f) => f.judgement.name)).toEqual(['solid'])
    expect(lowConfidence.map((f) => f.judgement.name)).toEqual(['arguable'])
  })

  it('scores them separately rather than dropping them', () => {
    // Excluded from the headline is not the same as unreported. A disputed label
    // must not be able to quietly improve the number.
    const rendered = renderBreakdownSections(fixtures)
    expect(rendered).toContain('`arguable`')
    expect(rendered).toContain('Either reading is defensible here')
    expect(rendered).toContain('Joint accuracy on these')
  })

  it('treats an empty exclusion list as a fact about the dataset, not a success', () => {
    const rendered = renderBreakdownSections(
      fixtures.filter((f) => !f.labels.lowConfidenceGroundTruth),
    )
    expect(rendered).toContain('No fixture is currently marked')
    expect(rendered).toContain('may simply be avoiding the hard cases')
  })

  it('counts the excluded fixture out of the breakdown totals too', () => {
    // Excluding from the headline has to mean excluding everywhere the headline
    // is decomposed, or the sections would not add up to it.
    const rendered = renderBreakdownSections(fixtures)
    expect(rendered).toContain('The only fixture has one provenance')
  })
})

// ---------------------------------------------------------------------------

const dataset: ScoredFixture[] = loadAllPayloads().map(({ name, payload }) => {
  const labels = loadLabels(name)
  const predicted = classifyWithBaseline(payload)
  return {
    judgement: {
      name,
      predicted: { owner: predicted.owner, determinism: predicted.determinism },
      actual: { owner: labels.owner, determinism: labels.determinism },
    },
    labels,
  }
})
const judgements = dataset.map((f) => f.judgement)

describe('the baseline against the committed dataset', () => {
  it('pins the owner confusion matrix', () => {
    // Rows app_code / test_code / environment, columns the same.
    expect(confusionMatrix(judgements, 'owner').counts).toEqual([
      [17, 4, 0],
      [8, 0, 0],
      [3, 0, 1],
    ])
  })

  it('pins the determinism confusion matrix', () => {
    expect(confusionMatrix(judgements, 'determinism').counts).toEqual([
      [17, 4],
      [3, 9],
    ])
  })

  it('shows the whole `test_code` row collapsing into `app_code`', () => {
    // Eight fixtures, every one called app_code. This is the single most
    // informative cell in the report and accuracy alone never shows it.
    const matrix = confusionMatrix(judgements, 'owner')
    const row = matrix.counts[matrix.labels.indexOf('test_code')]
    expect(row).toEqual([8, 0, 0])
  })

  it('scores 3 of 10 on the hard quadrant', () => {
    // The project's thesis number. The baseline being poor here is the dataset
    // working, not the control being unfair.
    const hard = quadrantBreakdown(judgements).find((r) => r.hard)
    expect(hard).toMatchObject({ support: 10, correct: 3 })
    expect(hard?.accuracy.point).toBeCloseTo(0.3, 10)
  })

  it('has an empty quadrant, so the n/a path is exercised by real data', () => {
    const empty = quadrantBreakdown(judgements).filter((r) => r.support === 0)
    expect(empty.map((r) => `${r.owner}+${r.determinism}`)).toEqual(['test_code+intermittent'])
  })

  const byBucket = scoreBy(judgements, (j) => {
    const labels = dataset.find((f) => f.judgement.name === j.name)?.labels
    return labels?.bucket ?? 'unknown'
  })
  const bucket = (name: string) => byBucket.find((g) => g.group === name)?.metrics

  it('covers every bucket the dataset currently has', () => {
    expect(byBucket.map((g) => g.group)).toEqual([
      'environment-as-regression',
      'hard-quadrant',
      'misleading-history',
      'stale-test',
      'straightforward',
    ])
  })

  /**
   * These are the numbers docs/eval-methodology.md publishes as evidence that the
   * buckets do what they claim. Pinning them here is what makes that claim
   * checkable rather than asserted — and each assertion below is really a claim
   * about the *dataset*, not about the baseline.
   */
  it('passes every straightforward case, which is the control on the control', () => {
    // A baseline that failed these would be broken, and every failure below
    // would say nothing about the fixtures.
    expect(bucket('straightforward')?.joint.point).toBe(1)
  })

  it('is defeated by stale-test on owner alone, the axis that bucket attacks', () => {
    expect(bucket('stale-test')?.owner.accuracy.point).toBe(0)
    expect(bucket('stale-test')?.determinism.accuracy.point).toBe(1)
  })

  it('is defeated by misleading-history on determinism alone', () => {
    // The mirror image of the previous case. Both buckets failing on both axes
    // would mean the fixtures were merely hard; failing on precisely the
    // intended axis is what makes them adversarial.
    expect(bucket('misleading-history')?.determinism.accuracy.point).toBe(0)
    expect(bucket('misleading-history')?.owner.accuracy.point).toBeCloseTo(0.75, 10)
  })

  it('is defeated by environment-as-regression on owner, leaving determinism intact', () => {
    expect(bucket('environment-as-regression')?.owner.accuracy.point).toBeCloseTo(0.25, 10)
    expect(bucket('environment-as-regression')?.determinism.accuracy.point).toBe(1)
  })

  it('scores 30% joint on the hard quadrant bucket', () => {
    expect(bucket('hard-quadrant')?.joint.point).toBeCloseTo(0.3, 10)
    expect(bucket('hard-quadrant')?.owner.accuracy.point).toBeCloseTo(0.6, 10)
  })

  it('declines to print a provenance breakdown while every fixture is synthetic', () => {
    const rendered = renderBreakdownSections(dataset)
    expect(rendered).toContain('All 33 fixtures share one provenance')
    expect(rendered).toContain('### By difficulty bucket')
  })
})

describe('the rendered markdown', () => {
  const report = [
    '#### `owner`',
    '',
    renderConfusionMatrix(confusionMatrix(judgements, 'owner')),
    '',
    '#### `determinism`',
    '',
    renderConfusionMatrix(confusionMatrix(judgements, 'determinism')),
    '',
    '### Per quadrant',
    '',
    renderQuadrantTable(quadrantBreakdown(judgements)),
    '',
    renderBreakdownSections(dataset),
    '',
  ].join('\n')

  it('is already formatted the way Prettier would format it', async () => {
    // eval/report.md is generated and then checked by `npm run format:check`.
    // Emitting anything Prettier would rewrite turns every regeneration into a
    // CI failure, so the renderer matches its padding rather than hoping.
    expect(await format(report, { parser: 'markdown' })).toBe(report)
  })

  it('pads columns by code point, which is what Prettier counts', async () => {
    // The header contains ↓ and →. Measuring with .length mis-pads every row in
    // any table whose header has one, and the file fails its own format check.
    //
    // A bare table is not a whole document, so the one permitted difference is
    // the trailing newline Prettier ends a file with. Asserting that exact
    // difference rather than trimming keeps the padding claim intact.
    const withArrows = renderConfusionMatrix(confusionMatrix(judgements, 'owner'))
    expect(withArrows).toContain('↓')
    expect(await format(withArrows, { parser: 'markdown' })).toBe(`${withArrows}\n`)
  })
})
