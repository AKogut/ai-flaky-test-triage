import {
  DeterminismSchema,
  OwnerSchema,
  type Determinism,
  type FixtureLabels,
  type Owner,
} from '@sentra/contracts'
import { formatProportion, proportion, score, type Judgement, type Metrics } from './metrics.js'

/**
 * Structure behind the headline.
 *
 * Aggregate accuracy hides the shape of the errors, and the shape is what tells
 * you whether a classifier is usable. Two classifiers at 85% — one whose
 * mistakes are spread evenly, one that never once predicts `environment` — are
 * different artefacts, and only the matrix distinguishes them. The baseline in
 * this repository is the second kind, and the matrix is how that became
 * visible.
 *
 * Unlike `metrics.ts`, this module does know about the fixture format. Scoring
 * is a pure function of label pairs; *reporting* has to say which fixtures the
 * numbers came from, and provenance and bucket live on `FixtureLabels`. Holding
 * ground truth is exactly this layer's job — the leakage discipline is about
 * never handing labels to a classifier, not about never reading them.
 */

// ---------------------------------------------------------------------------
// Confusion matrices
// ---------------------------------------------------------------------------

export interface ConfusionMatrix {
  axis: string
  labels: readonly string[]
  /**
   * `counts[actual][predicted]`.
   *
   * Row-is-truth is stated everywhere it could be misread, including in the
   * rendered header, because the transposed reading inverts precision and
   * recall and produces a table that looks entirely reasonable.
   */
  counts: number[][]
  /** Per actual class — the support. */
  rowTotals: number[]
  /** Per predicted class — how often the classifier reached for it. */
  columnTotals: number[]
  total: number
}

export function confusionMatrix(
  judgements: Judgement[],
  axis: 'owner' | 'determinism',
): ConfusionMatrix {
  const labels: readonly string[] =
    axis === 'owner' ? OwnerSchema.options : DeterminismSchema.options

  const counts = labels.map((actual) =>
    labels.map(
      (predicted) =>
        judgements.filter((j) => j.actual[axis] === actual && j.predicted[axis] === predicted)
          .length,
    ),
  )

  return {
    axis,
    labels,
    counts,
    rowTotals: counts.map(sum),
    columnTotals: labels.map((_, column) => sum(counts.map((row) => row[column] ?? 0))),
    total: judgements.length,
  }
}

export function renderConfusionMatrix(matrix: ConfusionMatrix): string {
  const header = ['actual ↓ / predicted →', ...matrix.labels.map(code), '**total**']

  const rows = matrix.labels.map((label, r) => [
    code(label),
    // The diagonal is the correct cell. Bolding it means the reader sees the
    // shape of the errors before reading a single number.
    ...matrix.labels.map((_, c) => {
      const value = String(matrix.counts[r]?.[c] ?? 0)
      return r === c ? `**${value}**` : value
    }),
    String(matrix.rowTotals[r] ?? 0),
  ])

  rows.push([
    '**total**',
    ...matrix.columnTotals.map((n) => String(n)),
    `**${String(matrix.total)}**`,
  ])

  return [
    `Rows are ground truth, columns are what the classifier said; the bold diagonal is correct.`,
    '',
    markdownTable(header, rows, ['left', ...matrix.labels.map(() => 'right' as const), 'right']),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Quadrants
// ---------------------------------------------------------------------------

export interface QuadrantRow {
  owner: Owner
  determinism: Determinism
  /** `app_code + intermittent` — the one the project exists for. */
  hard: boolean
  /** Fixtures whose ground truth is this quadrant. */
  support: number
  /** Of those, how many the classifier placed in the same quadrant. */
  correct: number
  accuracy: ReturnType<typeof proportion>
}

export function quadrantBreakdown(judgements: Judgement[]): QuadrantRow[] {
  const rows: QuadrantRow[] = []

  for (const owner of OwnerSchema.options) {
    for (const determinism of DeterminismSchema.options) {
      const inQuadrant = judgements.filter(
        (j) => j.actual.owner === owner && j.actual.determinism === determinism,
      )
      const correct = inQuadrant.filter(
        (j) => j.predicted.owner === owner && j.predicted.determinism === determinism,
      ).length

      rows.push({
        owner,
        determinism,
        hard: owner === 'app_code' && determinism === 'intermittent',
        support: inQuadrant.length,
        correct,
        accuracy: proportion(correct, inQuadrant.length),
      })
    }
  }

  return rows
}

export function renderQuadrantTable(rows: QuadrantRow[]): string {
  const body = rows.map((row) => {
    const name = `${code(row.owner)} + ${code(row.determinism)}`
    return [
      row.hard ? `**${name}**` : name,
      String(row.support),
      String(row.correct),
      // An empty quadrant prints n/a rather than 0%, which would read as a
      // failure on cases that do not exist.
      formatProportion(row.accuracy, { withN: false }),
    ]
  })

  return [
    markdownTable(['quadrant', 'support', 'correct', 'accuracy'], body, [
      'left',
      'right',
      'right',
      'right',
    ]),
    '',
    'The bold row is the hard quadrant — an `app_code` defect that does not reproduce on rerun.',
    'It is the case this project exists for, so it is reported on its own rather than averaged',
    'into the headline, where ten fixtures out of thirty-three would be invisible.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Grouped breakdowns
// ---------------------------------------------------------------------------

export interface GroupedMetrics {
  group: string
  metrics: Metrics
}

/** Score each group separately. Groups are returned in sorted order for a stable report. */
export function scoreBy(judgements: Judgement[], key: (j: Judgement) => string): GroupedMetrics[] {
  return scoreGroups(collect(judgements, key, (j) => j))
}

function collect<T>(
  items: readonly T[],
  key: (item: T) => string,
  toJudgement: (item: T) => Judgement,
): Map<string, Judgement[]> {
  const groups = new Map<string, Judgement[]>()
  for (const item of items) {
    const k = key(item)
    groups.set(k, [...(groups.get(k) ?? []), toJudgement(item)])
  }
  return groups
}

/** Sorted, so regenerating the report produces no diff when nothing changed. */
function scoreGroups(groups: Map<string, Judgement[]>): GroupedMetrics[] {
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, members]) => ({ group, metrics: score(members) }))
}

/**
 * A breakdown table, or a sentence saying why there is not one.
 *
 * A single-group breakdown is not a breakdown — it restates the headline in a
 * layout that looks like analysis. Saying so is more useful than printing it,
 * and it self-heals: the table appears as soon as the dimension has more than
 * one value.
 */
export function renderBreakdown(
  dimension: string,
  groups: GroupedMetrics[],
  total: number,
): string {
  if (groups.length === 0) return `No fixtures, so no ${dimension} breakdown.`

  const only = groups[0]
  if (groups.length === 1 && only !== undefined) {
    const subject = total === 1 ? 'The only fixture has' : `All ${String(total)} fixtures share`
    return (
      `${subject} one ${dimension} (${code(only.group)}), so this breakdown would repeat the ` +
      `headline. It appears here once the dataset has more than one.`
    )
  }

  return markdownTable(
    [dimension, 'n', 'joint', 'owner', 'determinism'],
    groups.map((g) => [
      code(g.group),
      String(g.metrics.n),
      formatProportion(g.metrics.joint, { withN: false }),
      formatProportion(g.metrics.owner.accuracy, { withN: false }),
      formatProportion(g.metrics.determinism.accuracy, { withN: false }),
    ]),
    ['left', 'right', 'right', 'right', 'right'],
  )
}

// ---------------------------------------------------------------------------
// Fixture-aware assembly
// ---------------------------------------------------------------------------

export interface ScoredFixture {
  judgement: Judgement
  labels: FixtureLabels
}

export interface Partitioned {
  /** Everything the headline is computed from. */
  headline: ScoredFixture[]
  /**
   * Fixtures whose ground truth is genuinely arguable.
   *
   * Excluded from the headline and reported on their own, rather than quietly
   * resolved in the project's favour — docs/eval-methodology.md promises this,
   * and a promise nothing enforces is a preference.
   */
  lowConfidence: ScoredFixture[]
}

export function partitionByGroundTruthConfidence(fixtures: ScoredFixture[]): Partitioned {
  return {
    headline: fixtures.filter((f) => !f.labels.lowConfidenceGroundTruth),
    lowConfidence: fixtures.filter((f) => f.labels.lowConfidenceGroundTruth),
  }
}

/** Every section that depends on knowing which fixture is which. */
export function renderBreakdownSections(fixtures: ScoredFixture[]): string {
  const { headline, lowConfidence } = partitionByGroundTruthConfidence(fixtures)

  // Grouped straight off the fixtures rather than looked up by name from the
  // judgements. The labels travel with the judgement they belong to, so there is
  // no lookup that could miss and no guard branch that could never fire.
  const by = (pick: (labels: FixtureLabels) => string): GroupedMetrics[] =>
    scoreGroups(
      collect(
        headline,
        (f) => pick(f.labels),
        (f) => f.judgement,
      ),
    )

  return [
    '### By provenance',
    '',
    renderBreakdown(
      'provenance',
      by((l) => l.provenance),
      headline.length,
    ),
    '',
    '### By difficulty bucket',
    '',
    renderBreakdown(
      'bucket',
      by((l) => l.bucket),
      headline.length,
    ),
    '',
    '### Excluded from the headline',
    '',
    renderLowConfidence(lowConfidence),
  ].join('\n')
}

function renderLowConfidence(fixtures: ScoredFixture[]): string {
  if (fixtures.length === 0) {
    return (
      'No fixture is currently marked `lowConfidenceGroundTruth`. That is a statement about the ' +
      'dataset, not a target — docs/eval-methodology.md expects roughly 10% of a finished dataset ' +
      'to be genuinely arguable, and a dataset with none may simply be avoiding the hard cases.'
    )
  }

  const metrics = score(fixtures.map((f) => f.judgement))
  return [
    `${String(fixtures.length)} fixture(s) have ground truth the author considers arguable. They ` +
      'are excluded from every figure above and scored here instead, so a disputed label cannot ' +
      'quietly improve the headline.',
    '',
    `Joint accuracy on these: ${formatProportion(metrics.joint)}`,
    '',
    ...fixtures.map((f) => `- \`${f.judgement.name}\` — ${f.labels.justification.split('.')[0]}.`),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export type Align = 'left' | 'right'

/**
 * A markdown table padded the way Prettier pads them.
 *
 * Generated markdown lands in a file the format check reads, so emitting
 * something Prettier would rewrite turns every report regeneration into a CI
 * failure. Matching its output means the file is stable the moment it is
 * written — asserted by a test that runs the real formatter over the result.
 */
export function markdownTable(headers: string[], rows: string[][], align: Align[]): string {
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i] ?? '')), 3),
  )

  const line = (cells: string[]): string =>
    `| ${cells.map((cell, i) => pad(cell, widths[i] ?? 0, align[i] ?? 'left')).join(' | ')} |`

  const divider = `| ${widths
    .map((width, i) =>
      (align[i] ?? 'left') === 'right' ? `${'-'.repeat(width - 1)}:` : '-'.repeat(width),
    )
    .join(' | ')} |`

  return [line(headers), divider, ...rows.map(line)].join('\n')
}

const pad = (cell: string, width: number, align: Align): string => {
  const padding = ' '.repeat(Math.max(0, width - displayWidth(cell)))
  return align === 'right' ? padding + cell : cell + padding
}

/**
 * Prettier measures table cells in code points, not UTF-16 units.
 *
 * Every arrow and en dash in this report is outside the BMP-adjacent range that
 * makes the two agree, so using `.length` mis-pads any row containing one and
 * the file fails its own format check.
 */
const displayWidth = (cell: string): number => [...cell].length

const code = (value: string): string => `\`${value}\``

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
