import { readdirSync } from 'node:fs'
import {
  BucketSchema,
  pairFixtureFiles,
  type Bucket,
  type FixtureLabels,
  type FixturePayload,
  LABELS_SUFFIX,
  PAYLOAD_SUFFIX,
} from '@sentra/contracts'
import { scoreStatusHistory } from '@sentra/flakemetry'
import { DATASET_DIR, loadLabels, loadPayload } from './dataset.js'

/**
 * Dataset hygiene.
 *
 * Label leakage is the quietest way to inflate an accuracy number. A fixture
 * whose test is titled "should not lose the update when requests overlap", sitting
 * in the hard quadrant, hands the classifier the answer — and the resulting
 * metric measures nothing while looking exactly like a metric that does.
 *
 * This cannot catch everything. Semantic leakage survives any word list, and a
 * scenario sentence can give the game away without using a single flagged term.
 * It catches the careless cases, and running it in CI means the discipline does
 * not depend on anybody remembering.
 */

/**
 * Vocabulary that gives away a label.
 *
 * Word-bounded, which is not fussiness: `race` unbounded matches every stack
 * trace in the dataset, and a check that fires on everything gets switched off.
 *
 * Only string **values** are scanned. Schema key names — `flakinessScore`,
 * `flakyWithinRun` — are part of the format rather than something a fixture
 * author chose, and flagging them would make the check unusable.
 *
 * Exported because the constraint reaches further than this directory. TaskFlow's
 * seed data is quoted verbatim into captured fixtures — an assertion comparing
 * the rendered board against the seed prints every title into the failure message
 * — so a seeded title carrying one of these words makes every fixture that
 * quotes the list unusable. One of them did. A test now checks the seed against
 * this list rather than the rule living in somebody's memory.
 */
export const LEAK_TERMS: readonly RegExp[] = [
  /\bapp_code\b/i,
  /\btest_code\b/i,
  /\benvironment\b/i,
  /\bflaky\b/i,
  /\bflakiness\b/i,
  /\brace\b/i,
  /\bdeterministic\b/i,
  /\bintermittent\b/i,
  /\bregression\b/i,
  /\bstale\b/i,
  /\bground truth\b/i,
  /\bhard quadrant\b/i,
]

/**
 * Target composition, from docs/eval-methodology.md.
 *
 * Drift is only an error once the dataset is large enough for the shares to mean
 * something. Below that it is reported and not enforced — a half-built dataset
 * is not out of composition, it is unfinished, and failing on it would train
 * everyone to ignore the check during exactly the period it is being built.
 */
const TARGET_SHARE: Record<Bucket, number> = {
  'hard-quadrant': 0.2,
  'misleading-history': 0.1,
  'environment-as-regression': 0.1,
  'stale-test': 0.15,
  'unsynchronised-test': 0.1,
  'cross-file-state-leak': 0.1,
  straightforward: 0.25,
}

const ENFORCE_COMPOSITION_FROM = 60
const DRIFT_TOLERANCE = 0.1

/** A justification long enough to pass the schema can still be too short to be an argument. */
const THIN_JUSTIFICATION = 150

export interface Finding {
  fixture: string
  message: string
}

export interface HygieneReport {
  fixtures: number
  errors: Finding[]
  warnings: Finding[]
  composition: { bucket: Bucket; count: number; share: number; target: number; drift: number }[]
  compositionEnforced: boolean
}

/** Every string value in a payload, with a path so a finding can name where it is. */
function* strings(value: unknown, path: string[] = []): Generator<[string, string]> {
  if (typeof value === 'string') {
    yield [path.join('.'), value]
  } else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* strings(item, [...path, String(i)])
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* strings(item, [...path, key])
  }
}

export function checkLeakage(name: string, payload: FixturePayload): Finding[] {
  const findings: Finding[] = []

  for (const term of LEAK_TERMS) {
    if (term.test(name)) {
      findings.push({ fixture: name, message: `filename contains ${String(term)}` })
    }
  }

  for (const [path, text] of strings(payload)) {
    for (const term of LEAK_TERMS) {
      if (term.test(text)) {
        findings.push({
          fixture: name,
          message: `${path} contains ${String(term)} — "${excerpt(text, term)}"`,
        })
      }
    }
  }

  return findings
}

/** The letters the reporters produce, so a run's status can be compared to the history's tail. */
const STATUS_LETTER: Record<string, string> = {
  passed: 'P',
  failed: 'F',
  timedOut: 'T',
  skipped: 'S',
}

/**
 * A fixture's signal has to be one production could have produced.
 *
 * The dataset is what the accuracy number is computed over, so a signal that no
 * pipeline would emit means the classifier is being scored on inputs it will
 * never see — measuring the fixtures rather than the classifier. Thirty-six of
 * these carried a hand-picked `flakinessScore`; two histories were spelled with
 * a failure streak that contradicted their own letters, and one pair of
 * identical histories carried two different scores, which is the shape of the
 * problem in one line: no definition produces both.
 *
 * `flakinessScore` and `consecutiveFailures` are **errors** — they are derived,
 * so there is exactly one right answer and a wrong one is a defect.
 *
 * A history whose last letter disagrees with the run being triaged is a
 * **warning**. `analyse` always ends the history with the run it is analysing,
 * so a fixture ending in `P` for a failing test is a shape production cannot
 * emit — but extending it is a labelling decision, not arithmetic: a longer
 * history can change what the right answer is. Tracked in #177.
 */
export function checkSignal(name: string, payload: FixturePayload): Finding[] {
  const { signal } = payload.subject
  const history = signal.statusHistory
  const findings: Finding[] = []

  const score = scoreStatusHistory(history)
  if (signal.flakinessScore !== score) {
    findings.push({
      fixture: name,
      message: `flakinessScore is ${String(signal.flakinessScore)}, but ${history} scores ${String(score)}`,
    })
  }

  const streak = (/[FT]*$/.exec(history)?.[0] ?? '').length
  if (signal.consecutiveFailures !== streak) {
    findings.push({
      fixture: name,
      message: `consecutiveFailures is ${String(signal.consecutiveFailures)}, but ${history} ends in ${String(streak)}`,
    })
  }

  if (signal.totalRuns < history.length) {
    findings.push({
      fixture: name,
      message: `totalRuns is ${String(signal.totalRuns)}, fewer than the ${String(history.length)} runs the history shows`,
    })
  }

  return findings
}

/** Separated from {@link checkSignal} because it is a labelling question, not arithmetic. */
export function checkHistoryEndsWithRun(name: string, payload: FixturePayload): Finding[] {
  const { signal, result } = payload.subject
  const expected = STATUS_LETTER[result.status] ?? '?'
  const actual = signal.statusHistory.slice(-1)
  return actual === expected
    ? []
    : [
        {
          fixture: name,
          message: `history ends in ${actual} but the run being triaged ${result.status} — analyse() always ends it with this run (#177)`,
        },
      ]
}

function excerpt(text: string, term: RegExp): string {
  const at = text.search(term)
  const from = Math.max(0, at - 25)
  return `${from > 0 ? '…' : ''}${text.slice(from, at + 45).replace(/\n/g, ' ')}…`
}

export function checkComposition(
  labels: FixtureLabels[],
): Pick<HygieneReport, 'composition' | 'compositionEnforced'> {
  const total = labels.length
  const composition = BucketSchema.options.map((bucket) => {
    const count = labels.filter((l) => l.bucket === bucket).length
    const share = total === 0 ? 0 : count / total
    const target = TARGET_SHARE[bucket]
    return { bucket, count, share, target, drift: share - target }
  })
  return { composition, compositionEnforced: total >= ENFORCE_COMPOSITION_FROM }
}

export function runHygiene(dir: string = DATASET_DIR): HygieneReport {
  const errors: Finding[] = []
  const warnings: Finding[] = []

  const paired = pairFixtureFiles(readdirSync(dir))
  for (const name of paired.missingLabels) {
    errors.push({ fixture: name, message: `has ${PAYLOAD_SUFFIX} but no ${LABELS_SUFFIX}` })
  }
  for (const name of paired.orphanedLabels) {
    errors.push({ fixture: name, message: `has ${LABELS_SUFFIX} but no ${PAYLOAD_SUFFIX}` })
  }

  const labels: FixtureLabels[] = []
  for (const name of paired.names) {
    const { payload } = loadPayload(name, dir)
    errors.push(...checkLeakage(name, payload))
    errors.push(...checkSignal(name, payload))
    warnings.push(...checkHistoryEndsWithRun(name, payload))

    const label = loadLabels(name, dir)
    labels.push(label)

    if (label.justification.length < THIN_JUSTIFICATION) {
      warnings.push({
        fixture: name,
        message: `justification is ${String(label.justification.length)} characters — long enough to parse, short enough to suggest the tempting alternative was never addressed`,
      })
    }
  }

  const { composition, compositionEnforced } = checkComposition(labels)
  if (compositionEnforced) {
    for (const row of composition) {
      if (Math.abs(row.drift) > DRIFT_TOLERANCE) {
        errors.push({
          fixture: row.bucket,
          message: `share is ${pct(row.share)} against a target of ${pct(row.target)} — drift ${pct(Math.abs(row.drift))} exceeds ${pct(DRIFT_TOLERANCE)}`,
        })
      }
    }
  }

  return { fixtures: paired.names.length, errors, warnings, composition, compositionEnforced }
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`

/**
 * Returns the exit code rather than calling `process.exit`, so the failure path
 * is testable. A guard whose only untested branch is the one that fails the
 * build is a guard nobody has watched work.
 */
export function main(dir: string = DATASET_DIR): number {
  const report = runHygiene(dir)

  console.log(`\n  Golden dataset: ${String(report.fixtures)} fixtures\n`)
  console.log('  bucket                       count   share   target')
  for (const row of report.composition) {
    const flag = report.compositionEnforced && Math.abs(row.drift) > DRIFT_TOLERANCE ? ' ←' : ''
    console.log(
      `  ${row.bucket.padEnd(28)}${String(row.count).padStart(4)}  ${pct(row.share).padStart(6)}  ${pct(row.target).padStart(6)}${flag}`,
    )
  }
  if (!report.compositionEnforced) {
    console.log(
      `\n  Composition is reported but not enforced below ${String(ENFORCE_COMPOSITION_FROM)} fixtures.`,
    )
  }

  for (const w of report.warnings) console.log(`\n  warning  ${w.fixture}: ${w.message}`)
  for (const e of report.errors) console.error(`\n  error    ${e.fixture}: ${e.message}`)

  if (report.errors.length > 0) {
    console.error(
      `\n  ${String(report.errors.length)} problem(s). See eval/golden-dataset/README.md.\n`,
    )
    return 1
  }
  console.log('\n  No leakage or pairing problems found.\n')
  return 0
}

if (process.argv[1]?.endsWith('hygiene.ts') === true) process.exitCode = main()
