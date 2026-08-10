import { createHash } from 'node:crypto'
import { z } from 'zod'
import { DeterminismSchema, OwnerSchema } from './agent-output.js'
import { AnalysedTestSchema } from './analysis.js'

/**
 * The golden-dataset fixture format.
 *
 * Every number this project publishes is computed against these files, so the
 * format has one job beyond holding data: making it structurally impossible to
 * leak ground truth into the classifier's input.
 *
 * Hence two files per fixture. `<name>.run.json` is the payload a classifier
 * sees; `<name>.labels.json` is the answer. They are loaded by separate
 * functions returning separate types, and no type in this module has both. A
 * single file with a `labels` key would be more convenient and would put the
 * answer one careless spread operator away from the prompt.
 *
 * Specified in docs/eval-methodology.md.
 */

export const ProvenanceSchema = z.enum(['synthetic', 'captured', 'mutated'])
export type Provenance = z.infer<typeof ProvenanceSchema>

/**
 * Difficulty buckets from docs/eval-methodology.md.
 *
 * Metrics are reported per bucket, so a high headline number cannot be produced
 * purely by easy cases — which is the single most common way an AI evaluation
 * flatters itself.
 */
export const BucketSchema = z.enum([
  'hard-quadrant',
  'misleading-history',
  'environment-as-regression',
  'stale-test',
  'cross-file-state-leak',
  'straightforward',
])
export type Bucket = z.infer<typeof BucketSchema>

/** The rules in docs/taxonomy.md, applied in order; the first that fires decides. */
export const LabellingRuleSchema = z.enum([
  'rule-1-no-assertion-reached',
  'rule-2-unsafe-test-assumption',
  'rule-3-reproduces-against-unchanged-product',
  'rule-4-default-app-code',
])
export type LabellingRule = z.infer<typeof LabellingRuleSchema>

/** The classifier's input. Deliberately contains nothing about the answer. */
export const FixturePayloadSchema = z
  .object({
    /** Stable identity, matching the filename stem. */
    name: z.string().regex(/^[a-z0-9-]+$/),
    /** One sentence of context. Must not hint at the label — checked by the hygiene lint. */
    scenario: z.string().min(10).max(300),
    /** The failing test plus its flakiness signal, exactly as the agents receive it. */
    subject: AnalysedTestSchema,
    /** Diff of the commit under test, when the scenario involves one. */
    diff: z.string().max(20_000).optional(),
    /** Source of the test itself, when the scenario turns on how it is written. */
    testSource: z.string().max(20_000).optional(),
    /** False when the run had no history to draw on. */
    historyAvailable: z.boolean(),
  })
  .strict()
export type FixturePayload = z.infer<typeof FixturePayloadSchema>

/** The answer. Never returned together with a payload. */
export const FixtureLabelsSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    owner: OwnerSchema,
    determinism: DeterminismSchema,

    /**
     * Why this label and not the tempting alternative.
     *
     * Long enough to be an argument rather than an assertion. A one-line
     * justification almost always means the label was not really reasoned about,
     * and unreasoned ground truth is how an evaluation quietly stops meaning
     * anything.
     */
    justification: z.string().min(80).max(1000),

    /** Which ordered rule decided it. Makes the labelling reproducible by someone else. */
    ruleApplied: LabellingRuleSchema,

    provenance: ProvenanceSchema,
    bucket: BucketSchema,

    /**
     * Genuinely arguable. Excluded from headline metrics and reported separately,
     * rather than quietly resolved in the project's favour.
     */
    lowConfidenceGroundTruth: z.boolean().default(false),
  })
  .strict()
export type FixtureLabels = z.infer<typeof FixtureLabelsSchema>

export const PAYLOAD_SUFFIX = '.run.json'
export const LABELS_SUFFIX = '.labels.json'

/**
 * Content identity of a fixture payload.
 *
 * Keyed on canonical JSON rather than raw bytes so reformatting is not a change,
 * while an edited assertion is. Recorded in `eval/report.md` next to the numbers,
 * which is what makes a published metric traceable to the exact data that
 * produced it — a fixture silently edited after a good result would otherwise be
 * invisible.
 */
export function fixtureHash(payload: FixturePayload): string {
  return createHash('sha256').update(canonicalise(payload)).digest('hex').slice(0, 16)
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`)
  return `{${entries.join(',')}}`
}

export function parseFixturePayload(value: unknown, sourceLabel: string): FixturePayload {
  return parseOrThrow(FixturePayloadSchema, value, sourceLabel, 'fixture payload')
}

export function parseFixtureLabels(value: unknown, sourceLabel: string): FixtureLabels {
  return parseOrThrow(FixtureLabelsSchema, value, sourceLabel, 'fixture label file')
}

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  sourceLabel: string,
  what: string,
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    throw new Error(`${sourceLabel} is not a valid ${what}:\n${issues}`)
  }
  return parsed.data
}

export interface FixturePairing {
  names: string[]
  /** A payload with no labels file — it would be scored against nothing. */
  missingLabels: string[]
  /** A labels file with no payload — the answer to a question nobody asks. */
  orphanedLabels: string[]
}

/**
 * Pair fixture filenames, reporting both kinds of orphan.
 *
 * Pure, taking a filename list rather than reading a directory, so it is
 * testable without a filesystem and so `contracts/` stays free of I/O.
 *
 * Orphans have to be an error rather than a silent skip: a payload whose labels
 * file was never written would simply vanish from the dataset, and the headline
 * would be computed over fewer fixtures than anyone thinks.
 */
export function pairFixtureFiles(filenames: string[]): FixturePairing {
  const payloads = new Set<string>()
  const labels = new Set<string>()

  for (const filename of filenames) {
    if (filename.endsWith(PAYLOAD_SUFFIX)) payloads.add(filename.slice(0, -PAYLOAD_SUFFIX.length))
    else if (filename.endsWith(LABELS_SUFFIX)) labels.add(filename.slice(0, -LABELS_SUFFIX.length))
  }

  const names = [...payloads].filter((n) => labels.has(n)).sort()
  return {
    names,
    missingLabels: [...payloads].filter((n) => !labels.has(n)).sort(),
    orphanedLabels: [...labels].filter((n) => !payloads.has(n)).sort(),
  }
}
