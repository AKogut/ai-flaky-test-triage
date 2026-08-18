import {
  RootCauseSchema,
  type Classification,
  type ClassificationInput,
  type RootCause,
} from '@sentra/contracts'
import {
  assembleContext,
  renderContext,
  type ContextBundle,
  type ContextOptions,
} from './context.js'
import {
  callModel,
  type CallDeps,
  type CallOptions,
  type CallTelemetry,
  type ModelConfig,
  type TokenBudget,
} from './model-client.js'
import type { Transport } from './transport.js'

/**
 * The root-cause agent: one model call, one forced schema, no loop.
 *
 * It runs on a verdict somebody else reached, which is the whole of its risk. A
 * classification is checked against a labelled dataset; a hypothesis is checked
 * against nothing, and it is read by somebody deciding where to spend an hour.
 * So two things here are refusals rather than features.
 *
 * **It does not run without a calibrated threshold.** Not a default, not a
 * guess — `null` means the agent does not run at all. The point of running only
 * above a threshold is that the verdict being elaborated on has been *shown* to
 * be right most of the time, and a guessed threshold gives that sentence nothing
 * behind it. Until #38 publishes a calibration there is no number, so there are
 * no root-cause hypotheses, which is the correct amount of confident prose to
 * emit about verdicts of unmeasured quality.
 *
 * **It drops paths the checkout does not have.** A model that names
 * `src/board/reconcile.ts` because the name fits is producing a finding-shaped
 * guess, and a reader cannot tell the difference from the report. Dropped rather
 * than rejected, and the drop is recorded, for the same reason `triage.ts`
 * reports unverified quotations rather than discarding the classification: the
 * rate is worth knowing.
 *
 * Pure, like the rest of the assembly path — the prompt and the file check both
 * arrive from the caller, so `eslint.config.js` can forbid a filesystem import
 * here and the whole path stays testable without a repository.
 */

export interface RootCauseInput extends ClassificationInput {
  /** The verdict this hypothesis elaborates on. */
  classification: Classification
  /** Source of the files the stack implicates, keyed by repository-relative path. */
  implicatedSource?: Record<string, string>
}

export interface RootCauseDeps {
  transport: Transport
  system: string
  promptVersion: string
  /**
   * Whether a path exists in the checkout.
   *
   * Injected rather than read here, so this module stays free of the filesystem
   * and a test can describe a repository without building one.
   */
  exists: (path: string) => boolean
  config?: ModelConfig
  budget?: TokenBudget
  context?: ContextOptions
  onTelemetry?: (telemetry: CallTelemetry) => void
  label?: string
}

export interface RootCauseResult {
  rootCause: RootCause
  telemetry: CallTelemetry
  /** What the model was shown, so a wrong hypothesis can be read against its evidence. */
  bundle: ContextBundle
  /**
   * Paths the model named that the checkout does not have.
   *
   * Recorded, not silently swallowed. A hallucinated path is the root-cause
   * agent's equivalent of a fabricated quotation — it reads exactly like a real
   * finding — and the honest response is to measure how often it happens.
   */
  droppedFiles: string[]
}

/**
 * Whether this failure is worth a hypothesis.
 *
 * `null` is not "use a default". It is "nobody has measured this classifier, so
 * there is no verdict quality to stand on", and the answer to that is no.
 */
export function shouldInvestigate(
  classification: Pick<Classification, 'owner' | 'confidence'>,
  threshold: number | null,
): boolean {
  if (threshold === null) return false
  return classification.owner === 'app_code' && classification.confidence >= threshold
}

/**
 * Everything a root-cause call is, before anything is sent.
 *
 * Split out for the same reason `triageOptions` is: the cassette staleness check
 * needs the exact key this agent would request without making the call, and a
 * check built on a second copy of the assembly passes about requests nobody
 * makes.
 */
export function rootCauseOptions(
  input: RootCauseInput,
  deps: Pick<RootCauseDeps, 'system' | 'promptVersion' | 'context' | 'label'>,
): { options: CallOptions<RootCause>; bundle: ContextBundle } {
  const bundle = assembleContext(input, deps.context ?? {})
  return {
    bundle,
    options: {
      schema: RootCauseSchema,
      schemaName: 'root_cause',
      system: deps.system,
      prompt: [renderContext(bundle), verdict(input.classification)].join('\n\n'),
      promptVersion: deps.promptVersion,
      label: deps.label ?? `root-cause ${input.subject.result.testId}`,
    },
  }
}

export async function rootCause(
  input: RootCauseInput,
  deps: RootCauseDeps,
): Promise<RootCauseResult> {
  const { options, bundle } = rootCauseOptions(input, deps)

  const call: CallDeps = {
    transport: deps.transport,
    ...(deps.config !== undefined && { config: deps.config }),
    ...(deps.budget !== undefined && { budget: deps.budget }),
    ...(deps.onTelemetry !== undefined && { onTelemetry: deps.onTelemetry }),
  }

  const { value, telemetry } = await callModel(options, call)
  const { kept, dropped } = verifyFiles(value.implicatedFiles, deps.exists)

  return {
    rootCause: { ...value, implicatedFiles: kept },
    telemetry,
    bundle,
    droppedFiles: dropped,
  }
}

/**
 * The verdict, stated as a measured signal rather than fenced as evidence.
 *
 * The pipeline computed it, so a contributor cannot forge it — the same
 * reasoning that puts the flakiness score above the fence in `context.ts`. It is
 * appended after the bundle rather than woven into it because `assembleContext`
 * is shared with triage, where there is no verdict yet.
 */
function verdict(classification: Classification): string {
  return [
    'THE VERDICT YOU ARE ELABORATING ON',
    '',
    `- owner: ${classification.owner}`,
    `- determinism: ${classification.determinism}`,
    `- confidence: ${classification.confidence.toFixed(2)}`,
    `- reasoning: ${classification.reasoning}`,
  ].join('\n')
}

/**
 * Split named paths into those the checkout has and those it does not.
 *
 * Exported because the drop rate is a number somebody will want, and because a
 * check that only runs inside a model call is a check nobody can test cheaply.
 */
export function verifyFiles(
  named: readonly string[],
  exists: (path: string) => boolean,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  for (const path of named) (exists(path) ? kept : dropped).push(path)
  return { kept, dropped }
}
