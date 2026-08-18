import { quadrantOf } from '@sentra/contracts'
import type { TriagedTest } from './pipeline.js'
import { cost, formatUsd, type Usage } from './pricing.js'

/**
 * The one document this pipeline writes, and the only thing most people read.
 *
 * Two properties separate it from an ordinary report generator, and both are
 * about not being trusted more than it has earned.
 *
 * **It states the classifier's own measured accuracy inline.** A verdict in a
 * pull-request comment reads as ground truth unless the comment says otherwise,
 * and this one says otherwise in the footer, next to a link to how the number
 * was arrived at.
 *
 * **Everything a model produced is escaped before rendering.** The agents are
 * fed strings a contributor controls — test titles, error messages, diffs — and
 * a model that repeats one back can carry markdown with it. Unescaped, a
 * hypothesis containing a `##` heading or a `</details>` forges the report's own
 * structure, and a reader has no way to tell which parts the pipeline wrote.
 */

/** GitHub refuses an issue comment above this. Being refused is worse than being short. */
export const COMMENT_LIMIT = 65_536

/** Room kept for the footer and the truncation notice, so the cap never cuts them off. */
const RESERVE = 2_000

export const TRUNCATION_NOTICE =
  '\n\n> **This report was truncated** to fit GitHub’s comment limit. ' +
  'The full document is attached to the workflow run as an artifact.\n'

/**
 * Neutralise markdown a model may have carried out of its input.
 *
 * Not an HTML escape and not a code fence — the text has to stay readable prose.
 * What it removes is the ability to *forge structure*: a leading `#` that would
 * open a section, a table pipe that would split a cell, a fence that would end
 * the block it is inside, and any HTML tag, since `<details>` is how this report
 * groups things and a forged one moves everything after it.
 */
export function escapeAgentText(text: string): string {
  return text
    .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
    .replace(/`/g, '&#96;')
    .replace(/\|/g, '&#124;')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.replace(/^(\s*)(#{1,6}\s|>\s|-{3,}\s*$|={3,}\s*$)/, '$1\\$2'))
    .join('\n')
}

/** One cell of a table: escaped, single-line, and short enough to read. */
const cell = (text: string, max = 120): string => {
  const flat = escapeAgentText(text).replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

export interface ReportInput {
  triaged: readonly TriagedTest[]
  commitSha: string
  branch: string
  runId: string
  model: string
  promptVersions: Record<string, string>
  usage: readonly Usage[]
  /**
   * How well this classifier scored on the golden dataset, and where that came
   * from. Absent when no evaluation has been published, which the footer says
   * rather than omitting the line — a report with no accuracy figure and no
   * explanation reads as a report from a system that does not measure itself.
   */
  accuracy?: { joint: number; n: number; promptVersion: string }
  /** Degradations the run already knows about — no key, no history, budget hit. */
  notices?: readonly string[]
  limit?: number
}

const QUADRANTS = [
  'app_code+deterministic',
  'app_code+intermittent',
  'test_code+deterministic',
  'test_code+intermittent',
  'environment+deterministic',
  'environment+intermittent',
] as const

export function quadrantCounts(triaged: readonly TriagedTest[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(QUADRANTS.map((q) => [q, 0]))
  for (const row of triaged) {
    if (row.classification === undefined) continue
    counts[quadrantOf(row.classification)] = (counts[quadrantOf(row.classification)] ?? 0) + 1
  }
  return counts
}

export function renderReport(input: ReportInput): string {
  const limit = input.limit ?? COMMENT_LIMIT
  const classified = input.triaged.filter((r) => r.classification !== undefined)
  const gaps = input.triaged.filter((r) => r.unclassified !== undefined)

  const header = [
    '<!-- sentra:report -->',
    '## Flaky-test triage',
    '',
    `${String(input.triaged.length)} failing or newly-unstable tests on \`${input.branch}\` at \`${input.commitSha.slice(0, 7)}\`.`,
    '',
    ...quadrantLines(input.triaged),
    ...gapLines(gaps),
    ...(input.notices ?? []).map((n) => `> ⚠️ ${escapeAgentText(n)}`),
    '',
  ]

  const table = [
    '| Test | Quadrant | Confidence | Reason |',
    '| --- | --- | --- | --- |',
    ...input.triaged.map(row),
    '',
  ]

  // `app_code` is what a reader has to act on, so it is open. Everything else is
  // information they may want and did not ask for, which is what <details> is for.
  const detailed = classified
    .filter((r) => r.classification?.owner === 'app_code')
    .map((r) => section(r, true))
  const collapsed = classified
    .filter((r) => r.classification?.owner !== 'app_code')
    .map((r) => section(r, false))

  const body = [...header, ...table, ...detailed, ...collapsed].join('\n')
  const footer = renderFooter(input)

  return fit(body, footer, limit)
}

function quadrantLines(triaged: readonly TriagedTest[]): string[] {
  const counts = quadrantCounts(triaged)
  const present = QUADRANTS.filter((q) => (counts[q] ?? 0) > 0)
  if (present.length === 0) return []
  return [present.map((q) => `**${q}** ${String(counts[q] ?? 0)}`).join(' · '), '']
}

function gapLines(gaps: readonly TriagedTest[]): string[] {
  if (gaps.length === 0) return []
  const byReason = new Map<string, number>()
  for (const gap of gaps) {
    const reason = gap.unclassified?.reason ?? 'error'
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  const words: Record<string, string> = {
    budget: 'the run reached its token budget',
    error: 'the classifier call failed',
    'not-dispatched': 'never reached, because the budget ran out first',
    'not-run': 'the classifier never ran — see the notice above',
  }
  return [
    `> **${String(gaps.length)} unclassified.** ` +
      [...byReason].map(([r, n]) => `${String(n)} — ${words[r] ?? r}`).join('; ') +
      '. A missing row would read as "nothing was wrong with this test", so they are listed below.',
    '',
  ]
}

function row(entry: TriagedTest): string {
  const name = cell(entry.test.result.testId, 90)
  if (entry.classification === undefined) {
    return `| ${name} | — | — | unclassified: ${cell(entry.unclassified?.detail ?? '', 60)} |`
  }
  return [
    '',
    name,
    quadrantOf(entry.classification),
    entry.classification.confidence.toFixed(2),
    cell(entry.classification.reasoning, 100),
    '',
  ].join(' | ')
}

function section(entry: TriagedTest, open: boolean): string {
  const c = entry.classification
  if (c === undefined) return ''
  const lines: string[] = [
    `### ${cell(entry.test.result.title, 120)}`,
    '',
    `\`${cell(entry.test.result.file, 120)}\` — **${quadrantOf(c)}**, confidence ${c.confidence.toFixed(2)}`,
    '',
    escapeAgentText(c.reasoning),
    '',
  ]

  if (entry.rootCause !== undefined) {
    const rc = entry.rootCause
    lines.push(
      `**Hypothesis** (${rc.mechanism}, confidence ${rc.confidence.toFixed(2)}): ${escapeAgentText(rc.hypothesis)}`,
      '',
    )
    if (rc.alternativeHypothesis !== undefined) {
      lines.push(`**Alternative:** ${escapeAgentText(rc.alternativeHypothesis)}`, '')
    }
    if (rc.implicatedFiles.length > 0) {
      lines.push(`**Files:** ${rc.implicatedFiles.map((f) => `\`${cell(f)}\``).join(', ')}`, '')
    }
    if (entry.droppedFiles !== undefined && entry.droppedFiles.length > 0) {
      lines.push(
        `> ${String(entry.droppedFiles.length)} named path(s) are not in the checkout and were dropped.`,
        '',
      )
    }
  }

  if (entry.fixSuggestion !== undefined) {
    const fix = entry.fixSuggestion
    lines.push(
      `**Suggested fix:** ${escapeAgentText(fix.summary)}`,
      '',
      escapeAgentText(fix.approach),
      '',
    )
    if (fix.patch !== undefined) {
      // Fenced, and labelled as not applied. Nothing in this pipeline can apply it.
      lines.push(
        '_Illustrative only — nothing applies this._',
        '',
        '```diff',
        fix.patch.replace(/```/g, "'''"),
        '```',
        '',
      )
    }
    lines.push(`**Risks:** ${fix.risks.map((r) => escapeAgentText(r)).join('; ')}`, '')
    if (fix.testGap !== undefined) lines.push(`**Test gap:** ${escapeAgentText(fix.testGap)}`, '')
  }

  if (open) return lines.join('\n')
  return [
    '<details>',
    `<summary>${cell(entry.test.result.title, 120)}</summary>`,
    '',
    ...lines.slice(1),
    '</details>',
    '',
  ].join('\n')
}

function renderFooter(input: ReportInput): string {
  const spend = cost(input.usage)
  const versions = Object.entries(input.promptVersions)
    .map(([agent, version]) => `${agent} \`${version}\``)
    .join(', ')

  return [
    '',
    '---',
    '',
    `Model \`${input.model}\` · ${versions} · ${String(spend.inputTokens + spend.outputTokens)} tokens · ${formatUsd(spend.usd)}`,
    '',
    input.accuracy === undefined
      ? '**This classifier has not been scored yet.** No accuracy figure exists, so none is quoted — ' +
        'read every verdict above as a suggestion from an unmeasured system. ' +
        '[Methodology](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/eval-methodology.md)'
      : `**Measured accuracy of this classifier: ${(input.accuracy.joint * 100).toFixed(0)}% joint** ` +
        `(${input.accuracy.promptVersion}, n=${String(input.accuracy.n)}). It is wrong about ` +
        `${((1 - input.accuracy.joint) * 100).toFixed(0)}% of failures — read the verdicts above with that in mind. ` +
        '[Methodology](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/eval-methodology.md)',
    '',
  ].join('\n')
}

/**
 * Fit the document under the limit without losing the footer.
 *
 * The footer carries the accuracy figure, which is the line that stops a reader
 * treating the rest as ground truth — so it is the one part that must survive
 * truncation. Sections are dropped from the end, where the collapsed
 * non-`app_code` findings are, rather than characters from the middle.
 */
export function fit(body: string, footer: string, limit: number): string {
  const whole = body + footer
  if (whole.length <= limit) return whole

  const room = limit - footer.length - TRUNCATION_NOTICE.length - RESERVE
  const kept = body.slice(0, Math.max(0, room))
  // Cut at a section boundary so the document does not end mid-sentence.
  const boundary = kept.lastIndexOf('\n### ')
  return (boundary > 0 ? kept.slice(0, boundary) : kept) + TRUNCATION_NOTICE + footer
}
