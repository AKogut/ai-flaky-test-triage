import {
  ClassificationSchema,
  type Classification,
  type ClassificationInput,
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
  type CallTelemetry,
  type ModelConfig,
  type TokenBudget,
} from './model-client.js'
import type { Transport } from './transport.js'

/**
 * The triage agent: one model call, one forced schema, no loop.
 *
 * It is deliberately small. Everything that decides how well it performs lives
 * somewhere else and is separately testable — the evidence in `context.ts`, the
 * wording in `prompts/triage.v1.md`, the retry policy in `model-client.ts`. What
 * is left here is the wiring, plus the one check that has nowhere else to live:
 * whether the model's quoted evidence is actually in its input.
 *
 * Pure, like the rest of the assembly path. The prompt arrives as a string
 * because reading it is the caller's job — `eslint.config.js` fails the build on
 * a filesystem import here, which is what keeps the whole path unit-testable
 * without a repository.
 *
 * **v1 is expected to be mediocre.** That is the point of having built the
 * harness first: its numbers are the baseline for v2, recorded rather than
 * iterated away, and the version that produced them is frozen the moment they
 * are published.
 */

export interface TriageDeps {
  transport: Transport
  /** The assembled system prompt. Loaded by the caller — see `@sentra/prompts`. */
  system: string
  /** Recorded in telemetry, in the cassette key, and beside the numbers in eval/report.md. */
  promptVersion: string
  config?: ModelConfig
  budget?: TokenBudget
  context?: ContextOptions
  onTelemetry?: (telemetry: CallTelemetry) => void
  /** Names the call site in errors and spans; defaults to the test under triage. */
  label?: string
}

export interface TriageResult {
  classification: Classification
  telemetry: CallTelemetry
  /** What the model was shown, so a wrong answer can be read against its evidence. */
  bundle: ContextBundle
  /**
   * Quoted fragments that are not in the input.
   *
   * Reported rather than rejected. A fabricated quotation is the most damaging
   * thing this agent can produce — it reads exactly like the ones that are real
   * — but the honest response to one is to measure how often it happens, not to
   * throw away an otherwise usable classification and hide the rate. #38 reports
   * it beside the accuracy figures.
   */
  unverifiedEvidence: string[]
}

export async function triage(input: ClassificationInput, deps: TriageDeps): Promise<TriageResult> {
  const bundle = assembleContext(input, deps.context ?? {})
  const prompt = renderContext(bundle)

  const call: CallDeps = {
    transport: deps.transport,
    ...(deps.config !== undefined && { config: deps.config }),
    ...(deps.budget !== undefined && { budget: deps.budget }),
    ...(deps.onTelemetry !== undefined && { onTelemetry: deps.onTelemetry }),
  }

  const { value, telemetry } = await callModel(
    {
      schema: ClassificationSchema,
      schemaName: 'classification',
      system: deps.system,
      prompt,
      promptVersion: deps.promptVersion,
      label: deps.label ?? `triage ${input.subject.result.testId}`,
    },
    call,
  )

  return {
    classification: value,
    telemetry,
    bundle,
    unverifiedEvidence: unverified(value.evidence, prompt),
  }
}

/**
 * Which quotations are not in what the model was shown.
 *
 * Whitespace is normalised on both sides before comparing. A model that
 * re-wraps a stack frame or collapses the blank line inside an assertion diff
 * has still quoted the input, and calling that a fabrication would make the
 * measurement useless — the number has to mean "invented", not "reformatted".
 *
 * Elisions are honoured for the same reason: `expected 3 … to equal 4` is a
 * quotation with the middle dropped, which is a normal thing to do with a long
 * frame and a dishonest thing to call a hallucination. Each segment is required
 * to appear, in order.
 */
export function unverified(quotes: readonly string[], shown: string): string[] {
  const haystack = flatten(shown)
  return quotes.filter((quote) => !contains(haystack, quote))
}

function contains(haystack: string, quote: string): boolean {
  const segments = flatten(quote)
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')

  if (segments.length === 0) return false

  let from = 0
  for (const segment of segments) {
    const at = haystack.indexOf(segment, from)
    if (at === -1) return false
    from = at + segment.length
  }
  return true
}

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim()
