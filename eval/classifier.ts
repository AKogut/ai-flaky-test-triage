import {
  AnthropicTransport,
  CassetteTransport,
  TokenBudget,
  resolveMode,
  triage,
  type Mode,
  type Transport,
} from '@sentra/agents'
import type { Classification, ClassificationInput } from '@sentra/contracts'
import { CURRENT_PROMPT, loadPrompt } from '@sentra/prompts'
import { classifyWithBaseline } from './baseline.js'

/**
 * Choosing which classifier the harness runs.
 *
 * One seam with one signature, because the whole project rests on the agent and
 * the control being scored the same way over the same input. Anything that
 * treated them differently — a wrapper here, a special case there — would put
 * the difference between them somewhere other than the classifier, and the
 * headline number is a comparison.
 *
 * The baseline is synchronous and free; the agent is neither. The seam is
 * therefore async for both, which costs the baseline nothing and keeps the two
 * paths identical everywhere else.
 */

export type Classify = (input: ClassificationInput) => Promise<Classification>

export interface ClassifierContext {
  /** Named in the report so a set of numbers is attributable to a wording. */
  promptVersion: string | null
  /** Replay, record or live. Recorded because it decides whether a run cost money. */
  mode: Mode | null
}

export interface ChosenClassifier {
  classify: Classify
  context: ClassifierContext
}

/**
 * A transport that fails loudly if anything reaches it.
 *
 * In replay the inner transport is unreachable rather than merely unused, so
 * this is what the decorator wraps when there are no credentials. Constructing a
 * real SDK client there would work — the SDK does not check a key until it sends
 * — and would turn a cassette miss into a live request from a run that was
 * supposed to be free.
 */
export const unreachable = (): Transport => ({
  countInputTokens: () => {
    throw new Error('replay mode reached the network; a cassette miss must throw instead')
  },
  send: () => {
    throw new Error('replay mode reached the network; a cassette miss must throw instead')
  },
})

export interface ClassifierDeps {
  env?: NodeJS.ProcessEnv
  /** Injected so the agent path is testable without a key, a cassette or a network. */
  transport?: Transport
}

export function chooseClassifier(
  classifier: 'baseline' | 'agent',
  deps: ClassifierDeps = {},
): ChosenClassifier {
  if (classifier === 'baseline') {
    return {
      classify: (input) => Promise.resolve(classifyWithBaseline(input)),
      context: { promptVersion: null, mode: null },
    }
  }

  const env = deps.env ?? process.env
  const mode = resolveMode(env)
  const prompt = loadPrompt(CURRENT_PROMPT.triage)
  const transport =
    deps.transport ??
    new CassetteTransport(mode === 'replay' ? unreachable() : new AnthropicTransport(), { mode })

  const budget = new TokenBudget(tokenBudget(env))

  return {
    classify: async (input) => {
      const result = await triage(input, {
        transport,
        system: prompt.system,
        promptVersion: prompt.version,
        budget,
      })
      return result.classification
    },
    context: { promptVersion: prompt.version, mode },
  }
}

/**
 * The run's token ceiling.
 *
 * A default rather than an optional limit. An evaluation over the whole dataset
 * with a mistyped prompt is exactly the run that should stop, and "no budget
 * configured" is the state in which nothing does.
 */
export const DEFAULT_TOKEN_BUDGET = 200_000

export function tokenBudget(env: NodeJS.ProcessEnv): number {
  const raw = env.SENTRA_TOKEN_BUDGET
  if (raw === undefined || raw === '') return DEFAULT_TOKEN_BUDGET

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `SENTRA_TOKEN_BUDGET is "${raw}", which is not a positive whole number of tokens. ` +
        'Unset it to use the default rather than guessing what was meant.',
    )
  }
  return parsed
}
