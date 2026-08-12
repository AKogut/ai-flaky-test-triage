import type { Determinism, Owner } from '@sentra/contracts'

/**
 * Sampling the same fixture more than once, and what that buys.
 *
 * There is no temperature to pin on this model — it rejects `temperature`,
 * `top_p` and `top_k` outright — and pinning one never bought determinism
 * anyway. So variance is measured rather than suppressed. Without that, a 3pp
 * difference between two prompt versions cannot be told apart from the same
 * prompt run twice, and every prompt decision becomes a coin flip dressed as an
 * experiment.
 *
 * Self-consistency is a first-class metric, not a diagnostic. A classifier that
 * is 85% accurate and 100% stable is more useful than one that is 88% accurate
 * and flips on a third of fixtures, because the second cannot be trusted at the
 * level of a single pull-request comment — which is the only level at which
 * anybody reads it.
 *
 * The report leads with the consensus label so that every count in it — support,
 * confusion cells, quadrant recall — keeps meaning one fixture. It then states
 * the mean single-run accuracy and its spread directly beneath, because the
 * shipped pipeline classifies once. The gap between the two numbers is the cost
 * of instability, and it is on the page rather than in a footnote.
 */

export interface Prediction {
  owner: Owner
  determinism: Determinism
  confidence: number
}

export interface Consensus {
  owner: Owner
  determinism: Determinism
  /** Share of samples that agreed with the consensus pair. 1 when every sample agreed. */
  stability: number
  /** Mean confidence across samples — a single sample's number would be arbitrary. */
  confidence: number
}

/**
 * The label a majority of samples gave.
 *
 * Ties break towards the first sample rather than towards a fixed label. A fixed
 * tiebreak would make one class win every coin flip, which shows up as a real
 * bias in the confusion matrix and comes from nowhere in the classifier.
 */
export function consensus(samples: readonly Prediction[]): Consensus {
  const first = samples[0]
  if (first === undefined) throw new RangeError('a fixture needs at least one sample to score')

  const counts = new Map<string, number>()
  for (const sample of samples) {
    const key = pairKey(sample)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  let best = pairKey(first)
  for (const sample of samples) {
    const key = pairKey(sample)
    if ((counts.get(key) ?? 0) > (counts.get(best) ?? 0)) best = key
  }

  const winner = samples.find((sample) => pairKey(sample) === best) ?? first
  return {
    owner: winner.owner,
    determinism: winner.determinism,
    stability: (counts.get(best) ?? 0) / samples.length,
    confidence: samples.reduce((sum, s) => sum + s.confidence, 0) / samples.length,
  }
}

const pairKey = (prediction: Prediction): string => `${prediction.owner}/${prediction.determinism}`

/** Every distinct pair a fixture produced, most frequent first, for the flip list. */
export function labelsSeen(samples: readonly Prediction[]): string[] {
  const counts = new Map<string, number>()
  for (const sample of samples) {
    const key = pairKey(sample)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key} ×${String(count)}`)
}

// ---------------------------------------------------------------------------
// Across the dataset
// ---------------------------------------------------------------------------

export interface SampledFixture {
  name: string
  samples: Prediction[]
  actual: { owner: Owner; determinism: Determinism }
}

export interface UnstableFixture {
  name: string
  stability: number
  labels: string[]
}

export interface SamplingSummary {
  samples: number
  /**
   * Mean joint accuracy of a single run — what one pull-request comment gets.
   *
   * Reported next to the consensus headline on purpose. A reader who only sees
   * the consensus number is reading the accuracy of an ensemble nobody ships.
   */
  meanJoint: number
  /**
   * Population standard deviation across the runs, not a sample estimate.
   *
   * These N runs are the whole population of runs that happened, and with N=5 the
   * Bessel correction would inflate the spread by 12% for no reason a reader
   * could interpret.
   */
  sdJoint: number
  /** Mean per-fixture stability. The self-consistency rate the gate holds. */
  selfConsistency: number
  /** Every fixture that gave more than one answer, worst first. */
  unstable: UnstableFixture[]
}

export function summarise(fixtures: readonly SampledFixture[]): SamplingSummary {
  const samples = fixtures[0]?.samples.length ?? 1

  const perRun = Array.from({ length: samples }, (_, index) =>
    share(fixtures, (fixture) => isCorrect(fixture, index)),
  )

  const stabilities = fixtures.map((fixture) => consensus(fixture.samples).stability)

  const unstable = fixtures
    .map((fixture) => ({
      name: fixture.name,
      stability: consensus(fixture.samples).stability,
      labels: labelsSeen(fixture.samples),
    }))
    .filter((row) => row.stability < 1)
    .sort((a, b) => a.stability - b.stability || a.name.localeCompare(b.name))

  return {
    samples,
    meanJoint: mean(perRun),
    sdJoint: standardDeviation(perRun),
    selfConsistency: mean(stabilities),
    unstable,
  }
}

function isCorrect(fixture: SampledFixture, index: number): boolean {
  const sample = fixture.samples[index]
  return sample?.owner === fixture.actual.owner && sample.determinism === fixture.actual.determinism
}

const share = <T>(items: readonly T[], predicate: (item: T) => boolean): number =>
  items.length === 0 ? 0 : items.filter(predicate).length / items.length

export const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

export function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0
  const average = mean(values)
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
}
