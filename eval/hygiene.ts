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
 */
const LEAK_TERMS: readonly RegExp[] = [
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
