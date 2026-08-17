import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveMode, listCassettes, type Mode } from '@sentra/agents'
import {
  parseAnalysis,
  selectForTriage,
  type AnalysedTest,
  type Classification,
  type ClassificationInput,
} from '@sentra/contracts'
import { chooseClassifier, type ClassifierDeps } from '@sentra/eval'

/**
 * `npm run demo` — the pipeline, end to end, on a clean clone.
 *
 * This is the README's headline claim and the reason replay exists. Somebody
 * evaluating this repository will not provision an API key; if the demo needs
 * one, the project is unreadable to the audience it was written for. So: no key,
 * no network, no build, no configuration, and a real `report.md` at the end.
 *
 * **It is honest about what it is showing.** Replay proves the plumbing — the
 * bundle, the fences, the schema, the report — not the model's behaviour today.
 * A demo that implied a live classification had just happened would be the same
 * kind of quiet dishonesty this project spends its time removing elsewhere, so
 * the banner says which classifier ran and why.
 *
 * The renderer here is deliberately small and is not the report writer. That is
 * #68, and it belongs with the orchestrator in #66; this file exists to prove the
 * path is joined up, not to be the product.
 */

export const DEMO_DIR = 'demo'
export const OUTPUT = 'report.md'

interface DemoDeps extends ClassifierDeps {
  /** Injected so a test can drive replay, record or live without touching the process. */
  read?: (path: string) => string
  write?: (path: string, contents: string) => void
  log?: (message: string) => void
  cassettes?: () => number
}

/**
 * Which classifier the demo can actually run.
 *
 * Replay needs cassettes, and until the first recorded evaluation lands there
 * are none. Rather than fail on a clean clone — the one thing this script exists
 * not to do — it falls back to the baseline heuristic and says so in the banner
 * and in the report. A degraded run that announces itself is worth more than a
 * broken one, and far more than a polished one that quietly ran something else.
 */
export function pick(
  mode: Mode,
  cassettes: number,
): { classifier: 'baseline' | 'agent'; why: string } {
  if (mode !== 'replay') {
    return {
      classifier: 'agent',
      why: `credentials are present, so this run is live (${mode}) and costs money`,
    }
  }
  return cassettes > 0
    ? {
        classifier: 'agent',
        why: `replaying ${String(cassettes)} recorded response(s) — no network, no key, no cost`,
      }
    : {
        classifier: 'baseline',
        why: 'no cassettes are recorded yet, so the model-free baseline ran instead (#38 records them)',
      }
}

export async function main(deps: DemoDeps = {}): Promise<number> {
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'))
  const write = deps.write ?? ((path: string, text: string) => writeFileSync(path, text))
  const log = deps.log ?? console.log
  const countCassettes = deps.cassettes ?? (() => listCassettes().length)

  const analysis = parseAnalysis(
    JSON.parse(read(join(DEMO_DIR, 'analysis.json'))),
    join(DEMO_DIR, 'analysis.json'),
  )
  const diff = read(join(DEMO_DIR, 'diff.patch'))

  const mode = resolveMode(deps.env ?? process.env)
  const chosen = pick(mode, countCassettes())
  const classifier = chooseClassifier(chosen.classifier, deps)

  log(banner(analysis.runId, chosen.why))

  const failing = selectForTriage(analysis)
  const rows: Row[] = []
  for (const subject of failing) {
    const input: ClassificationInput = {
      subject,
      diff,
      historyAvailable: analysis.historyAvailable,
      ...source(read, subject),
    }
    rows.push({ subject, classification: await classifier.classify(input, 0) })
  }

  write(OUTPUT, render(analysis.branch, analysis.commitSha, chosen, rows, failing.length))

  log(`  Classified ${String(rows.length)} of ${String(analysis.tests.length)} tests.`)
  log(`  Wrote ${OUTPUT}.\n`)
  return 0
}

/** Read by the caller and passed in, so nothing under `agents/` touches the disk. */
function source(read: (path: string) => string, subject: AnalysedTest): { testSource?: string } {
  try {
    return { testSource: read(join(DEMO_DIR, 'sources', subject.result.file)) }
  } catch {
    // A missing source is an ordinary state in production too — a renamed file,
    // a shallow checkout — and the bundle says "not available" rather than
    // pretending it was considered.
    return {}
  }
}

const banner = (runId: string, why: string): string =>
  [
    '',
    '  Sentra — flaky-test triage, end to end',
    '',
    `  Input:      ${DEMO_DIR}/analysis.json (bundled run ${runId})`,
    `  Classifier: ${why}`,
    '',
    '  Replay proves the plumbing — context assembly, the fences around untrusted',
    '  text, the forced output schema, the report — not what the model would say',
    '  today. The accuracy of whatever ran is measured separately, in eval/report.md,',
    '  and this report states it rather than asking you to assume it.',
    '',
  ].join('\n')

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

interface Row {
  subject: AnalysedTest
  classification: Classification
}

const QUADRANT: Record<string, string> = {
  'app_code/deterministic': 'Regression — ship-blocking',
  'app_code/intermittent': 'Product race — looks flaky, is a bug',
  'test_code/deterministic': 'Stale test — fix or delete it',
  'test_code/intermittent': 'Unsynchronised test — missing wait or shared state',
  'environment/deterministic': 'Broken setup — fix CI',
  'environment/intermittent': 'Infra noise — rerun, then track it',
}

function render(
  branch: string,
  commit: string,
  chosen: { classifier: string; why: string },
  rows: readonly Row[],
  selected: number,
): string {
  const sorted = [...rows].sort((a, b) => order(a) - order(b) || name(a).localeCompare(name(b)))

  return [
    '# Flaky-test triage',
    '',
    `Branch \`${branch}\` at \`${commit.slice(0, 12)}\`. ${String(selected)} failing or newly-unstable test(s).`,
    '',
    `> Produced by \`npm run demo\` with the **${chosen.classifier}** classifier — ${chosen.why}.`,
    `> This output is advisory. The classifier's measured accuracy is published in`,
    `> [eval/report.md](eval/report.md); read it before trusting a row below.`,
    '',
    '| test | verdict | confidence | why |',
    '| ---- | ------- | ---------: | --- |',
    ...sorted.map((row) => {
      const { owner, determinism, confidence, reasoning } = row.classification
      return `| \`${row.subject.result.title}\` | ${QUADRANT[`${owner}/${determinism}`] ?? ''} <br> \`${owner}\` + \`${determinism}\` | ${confidence.toFixed(2)} | ${escape(reasoning)} |`
    }),
    '',
    ...sorted.flatMap((row) => [
      `### \`${row.subject.result.title}\``,
      '',
      `\`${row.subject.result.file}\` — ${row.subject.result.status}, ` +
        `${String(row.subject.result.attempts)} attempt(s), history \`${row.subject.signal.statusHistory}\``,
      '',
      'Evidence the classifier says it relied on:',
      '',
      ...row.classification.evidence.map((quote) => `- ${escape(quote)}`),
      '',
    ]),
  ].join('\n')
}

const order = (row: Row): number =>
  row.classification.owner === 'app_code' ? 0 : row.classification.owner === 'test_code' ? 1 : 2

const name = (row: Row): string => row.subject.result.testId

/**
 * Agent output is escaped before it reaches markdown.
 *
 * Every string in a classification originates in text a contributor wrote, so an
 * unescaped one can forge a table row or open a `<details>` the report never
 * closed. The worst case is cosmetic, which is exactly why it would go
 * unnoticed.
 */
const escape = (text: string): string =>
  text.replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('\n', ' ')

if (process.argv[1]?.endsWith('demo.ts') === true) {
  process.exitCode = await main()
}
