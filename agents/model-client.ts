import type { z } from 'zod'
import { toolSchema } from '@sentra/contracts'
import { TransportError, type Effort, type ModelRequest, type Transport } from './transport.js'

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
   */
  model: 'claude-opus-5',

  /**
   * Caps thinking *and* response text together on this model tier, where
   * thinking is on by default. A classification is a few hundred tokens; the
   * rest of this is headroom so a long deliberation cannot truncate the answer
   * it was deliberating about.
   */
  maxTokens: 8_000,

  /**
   * Left at the API default rather than guessed downward.
   *
   * Lower effort is unusually strong on this model and is the obvious cost
   * lever, but picking a level before measuring is tuning without evidence.
   * The sweep belongs to #38, where it can be run against the dataset and the
   * chosen value defended with numbers.
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
 */
export class TokenBudget {
  private used = 0

  constructor(readonly limit: number) {}

  get spent(): number {
    return this.used
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used)
  }

  /** Throws rather than returning false — a budget that can be ignored is not one. */
  reserve(tokens: number): void {
    if (tokens > this.remaining) {
      throw new BudgetExceededError(tokens, this.remaining, this.limit)
    }
    this.used += tokens
  }
}

/** Unbounded, for tests and for callers that budget elsewhere. */
export const UNLIMITED = new TokenBudget(Number.MAX_SAFE_INTEGER)

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
}

export interface CallTelemetry {
  label: string
  promptVersion: string
  model: string
  /** Every dispatch, including retries — the number that explains a cost. */
  attempts: number
  schemaViolations: number
  transientFailures: number
  inputTokens: number
  outputTokens: number
  durationMs: number
}

export interface CallResult<T> {
  value: T
  telemetry: CallTelemetry
}

/** Injected so every retry branch is reachable from a test without waiting or a network. */
export interface CallDeps {
  transport: Transport
  config?: ModelConfig
  budget?: TokenBudget
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
  onTelemetry?: (telemetry: CallTelemetry) => void
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

export async function callModel<T>(
  options: CallOptions<T>,
  deps: CallDeps,
): Promise<CallResult<T>> {
  const config = deps.config ?? MODEL_CONFIG
  const budget = deps.budget ?? UNLIMITED
  const sleep = deps.sleep ?? defaultSleep
  const random = deps.random ?? Math.random
  const now = deps.now ?? Date.now

  const started = now()
  const counters = { attempts: 0, schemaViolations: 0, transientFailures: 0 }
  const usage = { inputTokens: 0, outputTokens: 0 }

  const request: ModelRequest = {
    model: config.model,
    maxTokens: config.maxTokens,
    effort: config.effort,
    system: options.system,
    prompt: options.prompt,
    schemaName: options.schemaName,
    jsonSchema: toolSchema(options.schema),
  }

  let corrections = ''
  let lastIssues = ''

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
    budget.reserve(inputTokens)

    counters.attempts += 1
    const response = await withTransientRetry(
      () => deps.transport.send(attempt),
      config,
      counters,
      {
        sleep,
        random,
      },
    )
    usage.inputTokens += response.usage.inputTokens
    usage.outputTokens += response.usage.outputTokens

    const parsed = options.schema.safeParse(response.raw)
    if (parsed.success) {
      const telemetry: CallTelemetry = {
        label: options.label,
        promptVersion: options.promptVersion,
        model: response.model,
        ...counters,
        ...usage,
        durationMs: now() - started,
      }
      deps.onTelemetry?.(telemetry)
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
}

/**
 * Retry a transient failure with exponential backoff and full jitter.
 *
 * Full jitter rather than a fixed multiplier: a fleet that all backs off by the
 * same curve re-collides at every step, which is how one rate limit becomes a
 * synchronised herd. `random()` is injected so the schedule is assertable.
 */
async function withTransientRetry<T>(
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
