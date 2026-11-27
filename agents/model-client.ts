import type { z } from 'zod'
import { toolSchema } from '@sentra/contracts'
import { spendOf, UsageLedger, type Dispatch } from './ledger.js'
import { SpendCapExceededError } from './spend-cap.js'
import {
  TransportError,
  type Effort,
  type ModelRequest,
  type ModelResponse,
  type Transport,
} from './transport.js'

/**
 * The single wrapper every model call goes through.
 *
 * One interception point is what makes replay, sanitisation, telemetry and the
 * budget possible at all. If any agent can build its own request, each of those
 * becomes a convention that holds until the first call site forgets it.
 *
 * Three behaviours here are worth stating, because getting any of them wrong
 * produces a system that looks fine and quietly misbehaves.
 *
 * **Retries are classified, not counted.** A schema violation is retryable and
 * the model needs to see its own error to correct it. A rate limit is retryable
 * after waiting. A malformed request is not retryable at all. Collapsing these
 * into `retry(3)` builds something that spends its budget re-sending requests
 * that will never succeed.
 *
 * **The budget is checked before dispatch, against a real count.** Estimating
 * tokens with a character heuristic is how a budget silently stops binding;
 * `countInputTokens` asks the same model that will serve the request.
 *
 * **Every dispatch is written to the usage ledger, once.** This is the only
 * place a token count enters the system; the budget, the spans, the report
 * footer and the evaluation all read it from there (`agents/ledger.ts`).
 *
 * **The model ID is never written at a call site.** It lives in `MODEL_CONFIG`,
 * so "which model produced this number" has one answer per commit rather than
 * one per file.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ModelConfig {
  model: string
  maxTokens: number
  effort: Effort
  /** How many times a schema violation may be re-sent with the error attached. */
  schemaRetries: number
  /** How many times a rate limit or server fault may be retried. */
  transientRetries: number
  /** First backoff step, in milliseconds. Doubles per attempt, with full jitter. */
  backoffBaseMs: number
  backoffCapMs: number
}

/**
 * One place for every knob that changes what a published number means.
 *
 * Changing anything here changes the classifier, so it belongs in a reviewable
 * commit next to the eval numbers it moves — never in a call site.
 */
export const MODEL_CONFIG: ModelConfig = {
  /**
   * Pinned deliberately. `.github/dependabot.yml` ignores the SDK for the same
   * reason: a model change moves every metric in `eval/report.md`, so it is
   * made on purpose with an eval run attached, not absorbed by a dependency
   * bump.
   *
   * Moved from `claude-opus-5` before the first scored run (#38), which is the
   * one moment a model change costs nothing: no agent number had been
   * published, so none is invalidated. The request shape — structured output
   * and an explicit effort, no forced tool choice, no sampling parameters — is
   * accepted unchanged by both models.
   */
  model: 'claude-opus-5-5',

  /**
   * Caps thinking *and* response text together on this model tier, where
   * thinking is on by default. A classification is a few hundred tokens; the
   * rest of this is headroom so a long deliberation cannot truncate the answer
   * it was deliberating about.
   */
  maxTokens: 8_000,

  /**
   * Set explicitly, because on this model the API default is `medium`, one
   * level below what the classifier was designed against.
   *
   * Lower effort is the obvious cost lever, but picking a level before
   * measuring is tuning without evidence. The sweep belongs to #38, where it
   * can be run against the dataset and the chosen value defended with numbers.
   */
  effort: 'high',

  schemaRetries: 2,
  transientRetries: 3,
  backoffBaseMs: 500,
  backoffCapMs: 8_000,
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  constructor(
    readonly requested: number,
    readonly remaining: number,
    readonly limit: number,
  ) {
    super(
      `this call needs ${String(requested)} input tokens and ${String(remaining)} remain of a ${String(limit)} budget`,
    )
    this.name = 'BudgetExceededError'
  }
}

/**
 * A hard ceiling on input tokens across a run.
 *
 * Checked before dispatch rather than tallied afterwards. A budget that only
 * reports what was spent is an invoice.
 *
 * **It admits on the count and is charged what was billed.** A dispatch is let
 * through when its `count_tokens` figure fits in what remains. Once it settles,
 * the hold is released and the budget is charged from the usage ledger instead
 * — the input tokens the API reported, which is the number the footer and the
 * spans show. So the budget and the bill cannot disagree, and a dispatch that
 * got no response costs the budget nothing, as it cost nothing.
 *
 * The holds are what keep concurrent calls honest: two calls admitted at once
 * each see the other's count, not a ledger neither has written to yet.
 */
export class TokenBudget {
  private held = 0

  constructor(
    readonly limit: number,
    /** The run's ledger. Every call that draws on this budget records its dispatches here. */
    readonly ledger: UsageLedger = new UsageLedger(),
  ) {}

  /** Input tokens billed, plus what dispatches still in flight were admitted for. */
  get spent(): number {
    return this.ledger.inputTokens + this.held
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent)
  }

  /**
   * Admit a dispatch, or throw rather than returning false — a budget that can
   * be ignored is not one.
   *
   * Returns the release, to call once the dispatch is in the ledger. Calling it
   * twice releases once.
   */
  reserve(tokens: number): () => void {
    if (tokens > this.remaining) {
      throw new BudgetExceededError(tokens, this.remaining, this.limit)
    }
    this.held += tokens
    let released = false
    return () => {
      if (released) return
      released = true
      this.held -= tokens
    }
  }
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

export interface CallOptions<T> {
  schema: z.ZodType<T>
  /** Names the output shape for the model and for telemetry. */
  schemaName: string
  system: string
  prompt: string
  /** Which prompt file produced this, so a number is traceable to its wording. */
  promptVersion: string
  /** Human-readable call site, for telemetry and error messages. */
  label: string
  /** Which of N self-consistency samples this is; part of the cassette key. */
  sample?: number
}

export interface CallTelemetry {
  label: string
  promptVersion: string
  model: string
  /** Every dispatch, including retries — the number that explains a cost. */
  attempts: number
  schemaViolations: number
  transientFailures: number
  /** This call's entries in the usage ledger, summed — retries included. */
  inputTokens: number
  outputTokens: number
  durationMs: number
}

export interface CallResult<T> {
  value: T
  telemetry: CallTelemetry
}

/** How a call ended, in the five terms a span records. */
export type CallOutcome = 'ok' | 'refused' | 'schema-invalid' | 'budget' | 'error'

/**
 * One model call, however it ended — what `agents/spans.ts` builds a span from.
 *
 * `CallTelemetry` exists only for calls that succeeded: it describes an answer.
 * A span has the opposite requirement: the calls worth looking at are the ones
 * that refused, ran out of budget or never matched the schema. So this is a
 * second record rather than a widened first one. Neither is where a cost is
 * kept — both carry this call's share of the usage ledger, summed.
 *
 * It carries no `label` and no prompt. The label names the test under triage,
 * and a test title is text a contributor wrote. `error` is passed through for
 * the observer to classify by type; its message is never meant to be copied.
 */
export interface CallRecord {
  promptVersion: string
  schemaName: string
  /** What `MODEL_CONFIG` asked for. Always known. */
  requestModel: string
  /** What answered, when any response arrived at all — a refusal included. */
  responseModel?: string
  maxTokens: number
  outcome: CallOutcome
  /** Absent on success. */
  error?: unknown
  attempts: number
  schemaViolations: number
  transientFailures: number
  /**
   * This call's entries in the usage ledger, summed: every response that was
   * billed, including the ones the schema rejected, a refusal, and a reply with
   * nothing to parse.
   */
  inputTokens: number
  outputTokens: number
  /**
   * Those tokens priced by `agents/pricing.ts`, each at the price of the model
   * that answered it. Absent when a model in the call has no price, because a
   * cost of zero for an unpriced model reads as good news.
   */
  costUsd?: number
  /** Epoch milliseconds, from the same clock as `durationMs`. */
  startedAt: number
  durationMs: number
}

/** Injected so every retry branch is reachable from a test without waiting or a network. */
export interface CallDeps {
  transport: Transport
  config?: ModelConfig
  /**
   * The run's budget, and through it the run's usage ledger. Absent, a call gets
   * an unbounded budget and a ledger of its own, which nobody else reads.
   */
  budget?: TokenBudget
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
  onTelemetry?: (telemetry: CallTelemetry) => void
  /**
   * Called once per call, success or failure, after the outcome is known.
   *
   * An observer that throws is ignored. Instrumentation that can turn a
   * classification into a failed row is instrumentation that changes what it
   * measures.
   */
  onCall?: (call: CallRecord) => void
}

export class SchemaViolationError extends Error {
  constructor(
    readonly label: string,
    readonly attempts: number,
    readonly issues: string,
  ) {
    super(`${label} did not return a valid ${String(attempts)} time(s): ${issues}`)
    this.name = 'SchemaViolationError'
  }
}

/**
 * The outcome a thrown error stands for.
 *
 * A refusal is kept apart from other transport failures because it is a policy
 * decision rather than a fault, and the budget apart from both because running
 * out of allowance means the run was too big, not that anything broke.
 */
export function callOutcome(error: unknown): CallOutcome {
  if (error instanceof BudgetExceededError) return 'budget'
  if (error instanceof SpendCapExceededError) return 'budget'
  if (error instanceof SchemaViolationError) return 'schema-invalid'
  if (error instanceof TransportError && error.kind === 'refusal') return 'refused'
  return 'error'
}

/**
 * The request a call turns into, on its own.
 *
 * Exported because the cassette staleness check has to ask exactly what the
 * agent would ask. Rebuilding the request there would work until the day the two
 * drift, at which point the check would go on passing about requests nobody
 * makes — the failure it exists to prevent, relocated into itself.
 */
export function buildRequest<T>(
  options: CallOptions<T>,
  config: ModelConfig = MODEL_CONFIG,
): ModelRequest {
  return {
    model: config.model,
    maxTokens: config.maxTokens,
    effort: config.effort,
    system: options.system,
    prompt: options.prompt,
    schemaName: options.schemaName,
    jsonSchema: toolSchema(options.schema),
    promptVersion: options.promptVersion,
    ...(options.sample !== undefined && { sample: options.sample }),
  }
}

export async function callModel<T>(
  options: CallOptions<T>,
  deps: CallDeps,
): Promise<CallResult<T>> {
  const config = deps.config ?? MODEL_CONFIG
  const budget = deps.budget ?? new TokenBudget(Number.MAX_SAFE_INTEGER)
  const sleep = deps.sleep ?? defaultSleep
  const random = deps.random ?? Math.random
  const now = deps.now ?? Date.now

  const started = now()
  const counters = { attempts: 0, schemaViolations: 0, transientFailures: 0 }
  let responseModel: string | undefined

  const request = buildRequest(options, config)

  // This call's own entries, kept beside the run's ledger so the call's records
  // are sums of exactly what the ledger holds for it, never a count of their own.
  const mine: Dispatch[] = []
  const note = (dispatch: Omit<Dispatch, 'promptVersion' | 'requestModel'>): void => {
    const entry = { promptVersion: options.promptVersion, requestModel: config.model, ...dispatch }
    budget.ledger.record(entry)
    mine.push(entry)
    if (entry.model !== undefined) responseModel = entry.model
  }
  const spent = (): Pick<CallRecord, 'inputTokens' | 'outputTokens' | 'costUsd'> => {
    const spend = spendOf(mine)
    return {
      inputTokens: spend.inputTokens,
      outputTokens: spend.outputTokens,
      ...(spend.unpricedModels.length === 0 && { costUsd: spend.usd }),
    }
  }

  // Every failed send is an entry, including each transient one the retry loop
  // absorbs. Recorded here, inside the loop, because outside it only the last
  // failure would be seen.
  const send = async (attempt: ModelRequest): Promise<ModelResponse> => {
    try {
      return await deps.transport.send(attempt)
    } catch (error) {
      // A request the spending cap refused was never sent, so like one the
      // token budget refused it has no place in a list of what was dispatched.
      if (!(error instanceof SpendCapExceededError)) note(unanswered(error))
      throw error
    }
  }

  const settle = (outcome: CallOutcome, error?: unknown): void => {
    try {
      deps.onCall?.({
        promptVersion: options.promptVersion,
        schemaName: options.schemaName,
        requestModel: config.model,
        ...(responseModel !== undefined && { responseModel }),
        maxTokens: config.maxTokens,
        outcome,
        ...(error !== undefined && { error }),
        ...counters,
        ...spent(),
        startedAt: started,
        durationMs: now() - started,
      })
    } catch {
      // Deliberately swallowed — see `CallDeps.onCall`.
    }
  }

  let corrections = ''
  let lastIssues = ''

  try {
    for (let schemaAttempt = 0; schemaAttempt <= config.schemaRetries; schemaAttempt++) {
      const attempt: ModelRequest = { ...request, prompt: `${options.prompt}${corrections}` }

      // Counted every time, because a correction makes the prompt longer — a
      // budget checked once against the first attempt is not a budget.
      const inputTokens = await withTransientRetry(
        () => deps.transport.countInputTokens(attempt),
        config,
        counters,
        { sleep, random },
      )
      const release = budget.reserve(inputTokens)

      let parsed: ReturnType<typeof options.schema.safeParse>
      let response: ModelResponse
      try {
        counters.attempts += 1
        response = await withTransientRetry(() => send(attempt), config, counters, {
          sleep,
          random,
        })
        parsed = options.schema.safeParse(response.raw)
        note({
          model: response.model,
          result: parsed.success ? 'answered' : 'rejected',
          ...response.usage,
          ...(response.tier === 'batch' && { tier: response.tier }),
        })
      } finally {
        // After the entry is written, so the budget never sees the hold gone
        // and the billed figure not yet there.
        release()
      }

      if (parsed.success) {
        const { inputTokens: input, outputTokens: output } = spent()
        const telemetry: CallTelemetry = {
          label: options.label,
          promptVersion: options.promptVersion,
          model: response.model,
          ...counters,
          inputTokens: input,
          outputTokens: output,
          durationMs: now() - started,
        }
        deps.onTelemetry?.(telemetry)
        settle('ok')
        return { value: parsed.data, telemetry }
      }

      counters.schemaViolations += 1
      lastIssues = describe(parsed.error)

      // The model is shown its own failure. A bare "try again" retries the same
      // misunderstanding at the same price.
      corrections =
        `\n\nYour previous response did not match the required schema:\n${lastIssues}\n` +
        `Return a corrected response. Change only what the errors above require.`
    }

    throw new SchemaViolationError(options.label, config.schemaRetries + 1, lastIssues)
  } catch (error) {
    settle(callOutcome(error), error)
    throw error
  }
}

/**
 * The ledger entry for a send that threw.
 *
 * A refusal and an unreadable reply both arrived as responses and were billed;
 * the transport attaches what it was billed to the error. Anything else — a
 * rate limit, a server fault, a 4xx, a cassette miss — never got a response.
 */
function unanswered(error: unknown): Omit<Dispatch, 'promptVersion' | 'requestModel'> {
  const billed = error instanceof TransportError ? error.response : undefined
  if (billed === undefined) return { result: 'unanswered', inputTokens: 0, outputTokens: 0 }
  return {
    model: billed.model,
    result: error instanceof TransportError && error.kind === 'refusal' ? 'refused' : 'unreadable',
    ...billed.usage,
    ...(billed.tier === 'batch' && { tier: billed.tier }),
  }
}

/**
 * Retry a transient failure with exponential backoff and full jitter.
 *
 * Full jitter rather than a fixed multiplier: a fleet that all backs off by the
 * same curve re-collides at every step, which is how one rate limit becomes a
 * synchronised herd. `random()` is injected so the schedule is assertable.
 *
 * Exported for the one caller outside `callModel` that dispatches on its own:
 * the evaluation's cost estimate, which counts every request of a run before
 * any is sent and has to ride out a rate limit the same way.
 */
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  config: ModelConfig,
  counters: { transientFailures: number },
  deps: { sleep: (ms: number) => Promise<void>; random: () => number },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const failure = error instanceof TransportError ? error : null

      // A refusal, a 4xx, or anything unclassified goes straight up. Retrying
      // a request the server has already judged is how a budget disappears
      // without a single useful response.
      if (failure?.retryable !== true) throw error
      if (attempt >= config.transientRetries) throw error

      counters.transientFailures += 1
      const ceiling = Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** attempt)
      await deps.sleep(Math.floor(deps.random() * ceiling))
    }
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** The first few issues, with paths, so a correction prompt is actionable rather than a dump. */
function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `  ${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('\n')
}
