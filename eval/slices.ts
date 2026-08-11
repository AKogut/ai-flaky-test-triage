import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * Splitting the golden dataset into a development slice and a held-out slice.
 *
 * Iterating prompts against every fixture fits them to it. After twenty
 * revisions the number measures how hard the author tried, not how well the
 * classifier generalises. A held-out slice is the cheapest defence, and it only
 * works if two things hold: the split never moves, and the discipline is
 * enforced by tooling rather than memory.
 *
 * ## The split rule, and why it is this one
 *
 * A fixture's slice is a pure function of its name. Nothing about the rest of
 * the dataset enters into it, so adding, removing or renaming any other fixture
 * cannot move it — which is the property that matters most, because a fixture
 * silently changing slice invalidates every held-out number ever published, and
 * does so without any visible failure.
 *
 * The rule: take the first 32 bits of `sha256(name)`, divide by 2^32 for a
 * uniform value in [0, 1), and hold out anything below `HOLDOUT_SHARE`.
 *
 * That construction was fixed before its result was known, and it is worth
 * saying why in a file about not fooling yourself. Two plausible variants exist
 * — this one, and the slightly biased `hash % 100 < 20` — and on the current 33
 * fixtures they give **different splits**: 11 held out here, 6 there. Picking
 * between them after seeing that would be choosing a test set by how flattering
 * it looks. This one is used because dividing by 2^32 is unbiased and `% 100` is
 * not; the outcome is reported, not selected.
 *
 * ## Stratification is best-effort, and currently poor
 *
 * The acceptance criteria ask for a stratified split *and* for adding a fixture
 * never to move an existing one. At small n those cannot both hold. Any rule
 * that guarantees per-bucket counts has to look at the other fixtures in the
 * bucket, and then inserting one reshuffles the boundary. Any rule that depends
 * only on the fixture is a Bernoulli draw, whose per-bucket counts vary.
 *
 * Stability wins, because its failure is silent and permanent while poor
 * stratification is visible and self-correcting. A bucket of four has a 41%
 * chance of receiving no held-out fixture at all at a 20% share — nothing about
 * the hash causes that, and nothing about a better hash fixes it. It shrinks as
 * the dataset grows towards the 60 fixtures docs/eval-methodology.md targets.
 *
 * The realised composition is therefore reported rather than assumed, and
 * `emptyHoldoutBuckets` names the buckets the held-out slice currently says
 * nothing about.
 */

export const HOLDOUT_SHARE = 0.2

export type Slice = 'dev' | 'holdout'
/** What `--slice` accepts. `all` is both, and counts as consulting the held-out set. */
export type SliceSelector = Slice | 'all'

/**
 * A stable uniform value in [0, 1) derived from the fixture name.
 *
 * Exported so the split rule itself is testable, rather than only its
 * consequences. A change here re-slices the dataset and invalidates every
 * published held-out number, so it is pinned by a test against known values.
 */
export function uniformOf(name: string): number {
  return createHash('sha256').update(name).digest().readUInt32BE(0) / 2 ** 32
}

export function sliceOf(name: string): Slice {
  return uniformOf(name) < HOLDOUT_SHARE ? 'holdout' : 'dev'
}

export function inSlice(name: string, selector: SliceSelector): boolean {
  return selector === 'all' || sliceOf(name) === selector
}

/**
 * True when running this selector means looking at held-out fixtures.
 *
 * A type predicate, so `--slice=all` cannot be forgotten at the call site. It is
 * the loophole worth closing: scoring everything reads the held-out fixtures
 * just as surely as asking for them by name, and a version of this that only
 * caught `holdout` would let the discipline be bypassed by choosing the more
 * innocuous-sounding flag.
 */
export function consultsHoldout(
  selector: SliceSelector,
): selector is Exclude<SliceSelector, 'dev'> {
  return selector !== 'dev'
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface SliceComposition {
  bucket: string
  total: number
  dev: number
  holdout: number
}

export function sliceComposition(
  fixtures: readonly { name: string; bucket: string }[],
): SliceComposition[] {
  const byBucket = new Map<string, SliceComposition>()

  for (const { name, bucket } of fixtures) {
    const row = byBucket.get(bucket) ?? { bucket, total: 0, dev: 0, holdout: 0 }
    row.total += 1
    row[sliceOf(name)] += 1
    byBucket.set(bucket, row)
  }

  return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket))
}

/**
 * Buckets with fixtures but none held out.
 *
 * Not an error. It is the honest statement that held-out results say nothing at
 * all about those buckets, which a reader would otherwise have to work out by
 * comparing two tables.
 */
export function emptyHoldoutBuckets(composition: readonly SliceComposition[]): string[] {
  return composition.filter((c) => c.total > 0 && c.holdout === 0).map((c) => c.bucket)
}

// ---------------------------------------------------------------------------
// The held-out usage log
// ---------------------------------------------------------------------------

/**
 * How often the held-out slice may be scored before the warning fires.
 *
 * A held-out set consulted on every change is a development set with extra
 * steps. Three times a month is loose enough not to obstruct real work and
 * tight enough that habitual use becomes visible.
 */
export const OVERUSE_LIMIT = 3
export const OVERUSE_WINDOW_DAYS = 30

/**
 * The log counts runs, not insights, and over-counts on purpose.
 *
 * Regenerating the held-out report after a formatting change teaches nobody
 * anything, and in a strict sense should not spend budget. But the tool cannot
 * tell that from a real consultation, and any flag meaning "this one does not
 * count" is a flag for never counting. Erring towards over-counting costs an
 * occasional early warning; erring the other way costs the entire mechanism.
 */

export const HOLDOUT_LOG = 'eval/holdout-log.json'

const HoldoutRunSchema = z
  .object({
    /** ISO date, day precision. The hour a held-out set was scored is not interesting. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    datasetRevision: z.string(),
    slice: z.enum(['holdout', 'all']),
    n: z.number().int().nonnegative(),
    jointAccuracy: z.number().min(0).max(1),
  })
  .strict()
export type HoldoutRun = z.infer<typeof HoldoutRunSchema>

const HoldoutLogSchema = z.object({ runs: z.array(HoldoutRunSchema) }).strict()

/**
 * Committed, so the record cannot be quietly reset.
 *
 * A log kept outside version control would make the overuse warning advisory in
 * the worst way — silently absent on a fresh clone, and clearable by deleting a
 * file nobody reviews.
 */
export function readHoldoutLog(path: string = HOLDOUT_LOG): HoldoutRun[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  const parsed = HoldoutLogSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`${path} is not a valid held-out log: ${parsed.error.issues[0]?.message ?? ''}`)
  }
  return parsed.data.runs
}

export function appendHoldoutRun(run: HoldoutRun, path: string = HOLDOUT_LOG): HoldoutRun[] {
  const runs = [...readHoldoutLog(path), HoldoutRunSchema.parse(run)]
  writeFileSync(path, `${JSON.stringify({ runs }, null, 2)}\n`)
  return runs
}

/** `YYYY-MM-DD` of the most recent evaluation, or null if the slice is untouched. */
export function lastEvaluated(runs: readonly HoldoutRun[]): string | null {
  return runs.reduce<string | null>(
    (latest, run) => (latest === null || run.date > latest ? run.date : latest),
    null,
  )
}

export interface Overuse {
  within: number
  limit: number
  windowDays: number
  overused: boolean
}

export function overuse(runs: readonly HoldoutRun[], today: Date): Overuse {
  const cutoff = new Date(today)
  cutoff.setUTCDate(cutoff.getUTCDate() - OVERUSE_WINDOW_DAYS)
  const from = isoDate(cutoff)

  const within = runs.filter((run) => run.date >= from).length
  return {
    within,
    limit: OVERUSE_LIMIT,
    windowDays: OVERUSE_WINDOW_DAYS,
    overused: within > OVERUSE_LIMIT,
  }
}

export const isoDate = (date: Date): string => date.toISOString().slice(0, 10)

export function overuseWarning(state: Overuse): string | null {
  if (!state.overused) return null
  return [
    `The held-out slice has been scored ${String(state.within)} times in the last ${String(state.windowDays)} days,`,
    `against a limit of ${String(state.limit)}. Past that point it is a development set with extra`,
    'steps: every look leaks a little of it into the next prompt revision, and the number it',
    'produces stops being the independent check it exists to be.',
    '',
    'Iterate against --slice=dev. The held-out slice is for confirming a result, not finding one.',
  ].join('\n')
}
