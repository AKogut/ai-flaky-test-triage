import { z } from 'zod'
import type { MeasuredAccuracy } from './report.js'

/**
 * Which accuracy figure, if any, the report may quote for the classifier that ran.
 *
 * The footer exists so that a verdict in a pull-request comment is not read as
 * ground truth. That only works if the number in it is the number for what
 * actually ran: quoting the model's score under a baseline report, or a score
 * recorded under a prompt that has since been replaced, is worse than quoting
 * nothing, because it is the one line a reader takes on trust.
 *
 * So the match is strict and every doubt resolves to silence. A missing file,
 * one that does not parse, one recorded for the other classifier or for another
 * prompt version — each leaves the footer saying the classifier is unscored,
 * which is true of the classifier that ran as far as this run can tell.
 *
 * Pure: the caller reads the file and passes its contents in.
 */

/** Written by `npm run eval`; read relative to the working directory. */
export const METRICS_FILE = 'eval/metrics.json'

/**
 * The part of the snapshot the footer needs.
 *
 * A mirror of `MetricsSnapshotSchema` in `eval/gate.ts`, not an import of it:
 * `eval` depends on `agents`, so importing back would be a cycle. Narrower on
 * purpose — the gate is the validator for the format, and this only has to be
 * sure of the five fields it quotes. Unknown keys are ignored rather than
 * refused, so a field added to the snapshot later does not silence the footer.
 */
const SnapshotSchema = z.object({
  version: z.literal(1),
  classifier: z.enum(['baseline', 'agent']),
  promptVersion: z.string().nullable().default(null),
  slice: z.string().min(1),
  n: z.number().int().positive(),
  joint: z.object({ point: z.number().min(0).max(1) }),
})

/** What ran in this job: the baseline, or the model under one triage prompt. */
export type RanClassifier =
  { classifier: 'baseline' } | { classifier: 'agent'; promptVersion: string }

/**
 * The figure for the classifier that ran, or undefined when there is none.
 *
 * `raw` is the file's contents, or null when it does not exist. Never throws:
 * a malformed metrics file is the eval job's problem to report, and turning it
 * into a failed triage run would fail a build over a footer.
 */
export function measuredAccuracy(
  raw: string | null,
  ran: RanClassifier,
): MeasuredAccuracy | undefined {
  if (raw === null) return undefined

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }

  const parsed = SnapshotSchema.safeParse(json)
  if (!parsed.success) return undefined
  const snapshot = parsed.data

  if (snapshot.classifier !== ran.classifier) return undefined
  if (ran.classifier === 'agent' && snapshot.promptVersion !== ran.promptVersion) return undefined

  return {
    joint: snapshot.joint.point,
    n: snapshot.n,
    slice: snapshot.slice,
    classifier: snapshot.classifier,
    promptVersion: snapshot.promptVersion,
  }
}
