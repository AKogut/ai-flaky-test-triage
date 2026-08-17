import { cassetteFile, cassetteKey, type Cassette } from './cassettes.js'
import type { ModelRequest } from './transport.js'

/**
 * Do the committed cassettes still answer the questions the pipeline asks?
 *
 * This is the maintenance cost ADR-0005 accepted as its main downside, and it is
 * not a hypothetical: cassettes going stale is the **default** outcome unless
 * something checks. A prompt reworded, a model repinned, a context field added —
 * each silently invalidates every recording, and the failure surfaces as a demo
 * that stopped working for the next stranger who cloned the repository.
 *
 * The check is offline and free. It asks the agent to build the requests it
 * would send and compares their keys against the files on disk; nothing is
 * called. It compares *the agent's own* request builder rather than a copy,
 * because a check built on a second copy passes about requests nobody makes —
 * the failure it exists to prevent, relocated into itself.
 */

export interface Expectation {
  /** Where this request comes from — the eval harness, the demo — for the message. */
  source: string
  request: ModelRequest
}

export interface Missing {
  source: string
  key: string
  file: string
}

export interface Extra {
  key: string
  file: string
  promptVersion: string
  model: string
}

export interface Staleness {
  expected: number
  onDisk: number
  /** A request the pipeline would make with nothing recorded for it. Replay fails here. */
  missing: Missing[]
  /**
   * Recorded under a prompt version or a model the pipeline no longer uses.
   *
   * Explainable and expected after a version bump or a model change:
   * re-recording resolves it, and the old files are safe to delete once nothing
   * references their numbers.
   */
  stale: Extra[]
  /**
   * Recorded under the *current* version and model, and still unrequested.
   *
   * The alarming one. Same version, same model, different content means the
   * prompt text or the assembled context changed without the version being
   * bumped — which is exactly what `prompts/freeze.ts` refuses once numbers are
   * published, and what nobody notices before that.
   */
  orphaned: Extra[]
}

export function compare(
  expectations: readonly Expectation[],
  onDisk: readonly Cassette[],
  current: { promptVersion: string; model: string },
): Staleness {
  const wanted = new Map(
    expectations.map((expectation) => [cassetteKey(expectation.request), expectation]),
  )
  const recorded = new Map(onDisk.map((cassette) => [cassette.key, cassette]))

  const missing: Missing[] = []
  for (const [key, expectation] of wanted) {
    if (!recorded.has(key)) {
      missing.push({ source: expectation.source, key, file: cassetteFile(expectation.request) })
    }
  }

  const stale: Extra[] = []
  const orphaned: Extra[] = []
  for (const [key, cassette] of recorded) {
    if (wanted.has(key)) continue
    const extra: Extra = {
      key,
      file: `${cassette.promptVersion}.${key}.json`,
      promptVersion: cassette.promptVersion,
      model: cassette.model,
    }
    const sameEra =
      cassette.promptVersion === current.promptVersion && cassette.model === current.model
    ;(sameEra ? orphaned : stale).push(extra)
  }

  const byKey = (a: { key: string }, b: { key: string }): number => a.key.localeCompare(b.key)
  return {
    expected: wanted.size,
    onDisk: recorded.size,
    missing: missing.sort((a, b) => a.source.localeCompare(b.source) || byKey(a, b)),
    stale: stale.sort(byKey),
    orphaned: orphaned.sort(byKey),
  }
}

export const isStale = (report: Staleness): boolean =>
  report.missing.length > 0 || report.stale.length > 0 || report.orphaned.length > 0

export const RECORD_COMMAND = 'npm run cassettes:record'

/**
 * What went wrong and the one command that fixes it.
 *
 * Every branch ends with the same command on purpose. A maintenance check that
 * explains a problem and leaves the reader to work out the remedy is a check
 * they learn to skim.
 */
export function render(report: Staleness): string {
  if (!isStale(report)) {
    return report.expected === 0
      ? 'No cassettes are recorded yet, and none are expected. Nothing to check.'
      : `All ${String(report.expected)} expected cassette(s) are present and current.`
  }

  const lines: string[] = [
    `Committed cassettes no longer match what the pipeline would ask for.`,
    `${String(report.expected)} request(s) expected, ${String(report.onDisk)} cassette(s) on disk.`,
    '',
  ]

  if (report.missing.length > 0) {
    lines.push(
      `Missing — replay fails on these (${String(report.missing.length)}):`,
      '',
      ...report.missing.slice(0, 10).map((row) => `  ${row.file}  ${row.source}`),
      ...more(report.missing.length),
      '',
    )
  }

  if (report.stale.length > 0) {
    lines.push(
      `Stale — recorded under a prompt version or model no longer in use (${String(report.stale.length)}):`,
      '',
      ...report.stale
        .slice(0, 10)
        .map((row) => `  ${row.file}  ${row.promptVersion}, ${row.model}`),
      ...more(report.stale.length),
      '',
    )
  }

  if (report.orphaned.length > 0) {
    lines.push(
      `Orphaned — current version and model, and nothing asks for them (${String(report.orphaned.length)}):`,
      '',
      ...report.orphaned.slice(0, 10).map((row) => `  ${row.file}`),
      ...more(report.orphaned.length),
      '',
      '  These are the ones worth reading twice. Same prompt version, same model, different',
      '  content means the prompt text or the assembled context changed without the version',
      '  being bumped — so any published number attributed to that version describes text',
      '  that no longer exists.',
      '',
    )
  }

  lines.push('Re-record with:', '', `    ${RECORD_COMMAND}`, '', 'and commit what it writes.')
  return lines.join('\n')
}

const more = (total: number): string[] => (total > 10 ? [`  … and ${String(total - 10)} more`] : [])
