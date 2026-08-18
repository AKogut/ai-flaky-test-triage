import {
  FixSuggestionSchema,
  type Classification,
  type FixSuggestion,
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
import type { RootCauseInput } from './root-cause.js'
import type { Transport } from './transport.js'

/**
 * The fix-suggestion agent. Text, and only ever text.
 *
 * The guardrail is structural rather than procedural: there is no code path from
 * this module's output to a filesystem write. Not a policy that the orchestrator
 * declines to apply patches — a policy is a thing somebody changes — but the
 * absence of any function here that could. `patch` is a string that ends up
 * inside a fenced code block in a markdown comment, and #69 asserts that a full
 * pipeline run writes exactly one file.
 *
 * Two fields are required by `FixSuggestionSchema` rather than requested by the
 * prompt, which is the difference between a rule and a suggestion the model may
 * decline. `risks` must be non-empty, because a fix without stated risks reads
 * as more authoritative than it has earned. `testGap` is optional but heavily
 * prompted for: in a system about flaky tests, "nothing covers this path" is
 * frequently the most valuable line in the report.
 */

export interface FixSuggestionInput extends RootCauseInput {
  /** The hypothesis this suggestion acts on. */
  rootCause: RootCause
}

export interface FixSuggestionDeps {
  transport: Transport
  system: string
  promptVersion: string
  config?: ModelConfig
  budget?: TokenBudget
  context?: ContextOptions
  onTelemetry?: (telemetry: CallTelemetry) => void
  label?: string
}

export interface FixSuggestionResult {
  suggestion: FixSuggestion
  telemetry: CallTelemetry
  bundle: ContextBundle
}

/**
 * Everything a fix-suggestion call is, before anything is sent.
 *
 * Same split as the other two agents, for the same reason: the cassette
 * staleness check needs the exact request without making it.
 */
export function fixSuggestionOptions(
  input: FixSuggestionInput,
  deps: Pick<FixSuggestionDeps, 'system' | 'promptVersion' | 'context' | 'label'>,
): { options: CallOptions<FixSuggestion>; bundle: ContextBundle } {
  const bundle = assembleContext(input, deps.context ?? {})
  return {
    bundle,
    options: {
      schema: FixSuggestionSchema,
      schemaName: 'fix_suggestion',
      system: deps.system,
      prompt: [renderContext(bundle), findings(input.classification, input.rootCause)].join('\n\n'),
      promptVersion: deps.promptVersion,
      label: deps.label ?? `fix-suggestion ${input.subject.result.testId}`,
    },
  }
}

export async function suggestFix(
  input: FixSuggestionInput,
  deps: FixSuggestionDeps,
): Promise<FixSuggestionResult> {
  const { options, bundle } = fixSuggestionOptions(input, deps)

  const call: CallDeps = {
    transport: deps.transport,
    ...(deps.config !== undefined && { config: deps.config }),
    ...(deps.budget !== undefined && { budget: deps.budget }),
    ...(deps.onTelemetry !== undefined && { onTelemetry: deps.onTelemetry }),
  }

  const { value, telemetry } = await callModel(options, call)
  return { suggestion: value, telemetry, bundle }
}

/**
 * The verdict and the hypothesis, above the fence.
 *
 * Both were produced by this pipeline, so a contributor cannot forge them —
 * unlike everything inside the evidence block. The hypothesis is another model's
 * output rather than a measurement, which is why it says so: a suggestion built
 * on a wrong hypothesis should be readable as such afterwards.
 */
function findings(classification: Classification, cause: RootCause): string {
  return [
    'WHAT THIS PIPELINE HAS CONCLUDED SO FAR',
    '',
    `- classified as: ${classification.owner} / ${classification.determinism} (confidence ${classification.confidence.toFixed(2)})`,
    `- mechanism: ${cause.mechanism}`,
    `- hypothesis (another model's, not a measurement): ${cause.hypothesis}`,
    ...(cause.alternativeHypothesis === undefined
      ? []
      : [`- stated alternative: ${cause.alternativeHypothesis}`]),
    `- implicated files (verified to exist): ${cause.implicatedFiles.join(', ') || 'none'}`,
    `- implicated symbols: ${cause.implicatedSymbols.join(', ') || 'none'}`,
  ].join('\n')
}
