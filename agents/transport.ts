import Anthropic from '@anthropic-ai/sdk'
import type { JsonSchemaObject } from '@sentra/contracts'
import type { Tier } from './pricing.js'

/**
 * The one place the Anthropic SDK is constructed.
 *
 * Everything above this file talks to a `Transport`, which is what makes
 * replay (#31), sanitisation (#32), telemetry and the token budget properties
 * of the system rather than conventions. A convention holds until somebody
 * writes one call site that forgets it; a port holds because there is nothing
 * else to call. `eslint.config.js` refuses an SDK import anywhere else in
 * `agents/`, so the rule is a build failure rather than a review comment.
 */

/** Model behaviour a caller is allowed to vary. Never a model ID — that lives in config. */
export interface ModelRequest {
  model: string
  /** Caps thinking *and* response text together, so it needs room for both. */
  maxTokens: number
  effort: Effort
  system: string
  prompt: string
  /** Names the shape in the response format; surfaces in errors and telemetry. */
  schemaName: string
  jsonSchema: JsonSchemaObject
  /**
   * Which prompt file produced this.
   *
   * Carried on the request rather than only on the call options because it is
   * part of the cassette key: the same input under a reworded prompt is a
   * different question, and replaying yesterday's answer to it would be a lie
   * that looks exactly like a passing test.
   */
  promptVersion: string
  /**
   * Which of N self-consistency samples this is.
   *
   * Part of the cassette key, which is the whole reason it lives on the request.
   * Without it every sample of a fixture hashes to one cassette, replay hands
   * back the same answer five times, and the harness reports perfect stability
   * for a classifier nobody measured. A recorded distribution has to replay as a
   * distribution.
   */
  sample?: number
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelResponse {
  /** Whatever the model returned, still unvalidated. Parsing is the caller's job. */
  raw: unknown
  stopReason: string | null
  model: string
  usage: { inputTokens: number; outputTokens: number }
  /**
   * Present, as `batch`, only on a response that came back from a Message
   * Batch, so the ledger prices it at the batch rate. Never written to a
   * cassette: a recording is what the model said, and the same answer replays
   * the same way however it was paid for.
   */
  tier?: Tier
}

export interface Transport {
  send(request: ModelRequest): Promise<ModelResponse>
  /** Counted against the same model, before dispatch, so the budget is checked on facts. */
  countInputTokens(request: ModelRequest): Promise<number>
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a call failed, in the only terms the retry policy cares about.
 *
 * Collapsing these into one retryable/not flag is what produces a client that
 * burns its budget re-sending a malformed request that will never succeed. The
 * SDK already distinguishes them; this keeps the distinction rather than
 * flattening it at the boundary.
 */
export type FailureKind =
  /** 429. Retryable, but only after waiting. */
  | 'rate-limit'
  /** 5xx or a connection failure. Retryable — the request itself was fine. */
  | 'server'
  /** 4xx. The request is wrong; sending it again will produce the same 4xx. */
  | 'client'
  /** The model declined. A policy outcome, not a fault — see below. */
  | 'refusal'

/**
 * A response that arrived and was then turned into an error: what answered, and
 * what the API billed for it.
 */
export type BilledResponse = Pick<ModelResponse, 'model' | 'usage' | 'tier'>

export class TransportError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly status?: number,
    override readonly cause?: unknown,
    /**
     * Present when a response arrived before the error did — a refusal, or a
     * reply with nothing in it to parse. Both are billed like an answer, so the
     * usage ledger has to see them; without this they were the one cost no
     * figure in the project counted.
     */
    readonly response?: BilledResponse,
  ) {
    super(message)
    this.name = 'TransportError'
  }

  get retryable(): boolean {
    return this.kind === 'rate-limit' || this.kind === 'server'
  }
}

/**
 * Map an SDK exception onto the taxonomy above.
 *
 * Exported because this mapping is the part that silently rots: a new SDK
 * error class, or a reordered `instanceof` chain, changes what gets retried
 * without changing any test that stubs the transport. Tested directly against
 * constructed SDK errors instead.
 *
 * Order matters — `APIConnectionError` is checked before `APIError` because in
 * this SDK it is a subclass, and the general case would swallow it.
 */
export function classify(error: unknown): TransportError {
  if (error instanceof TransportError) return error

  if (error instanceof Anthropic.RateLimitError) {
    return new TransportError('rate-limit', error.message, 429, error)
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new TransportError('server', error.message, undefined, error)
  }
  if (error instanceof Anthropic.APIError) {
    // `status` is loosely typed on the SDK error; narrowed here rather than
    // trusted, because it decides whether the call is retried.
    const status = typeof error.status === 'number' ? error.status : 0
    const kind: FailureKind = status >= 500 || status === 0 ? 'server' : 'client'
    return new TransportError(kind, error.message, status, error)
  }

  // An unrecognised throw is treated as a client fault on purpose: retrying
  // something nobody has classified is how a bug becomes a bill.
  return new TransportError(
    'client',
    error instanceof Error ? error.message : String(error),
    undefined,
    error,
  )
}

// ---------------------------------------------------------------------------
// Message Batches
// ---------------------------------------------------------------------------

/**
 * The same requests, sent as one Message Batch at half the price.
 *
 * A port beside `Transport` rather than more methods on it, because nothing
 * that classifies needs it: the agents only ever call `send`. A batched run
 * submits through this, then reads the results back through a `Transport`
 * (`agents/batch.ts`), so parsing, the schema check, the ledger and cassette
 * recording stay the code a synchronous run goes through.
 */
export interface BatchTransport {
  submitBatch(entries: readonly BatchEntry[]): Promise<BatchStatus>
  /** Idempotent, and free: the polling call. */
  retrieveBatch(id: string): Promise<BatchStatus>
  /** Only meaningful once `processing` is `ended`. In any order — match on `customId`. */
  batchResults(id: string): AsyncIterable<BatchResult>
}

export interface BatchEntry {
  /**
   * What the result comes back under. `^[a-zA-Z0-9_-]{1,64}$`, unique within a
   * batch, and the only thing a result is matched on: the API documents that
   * results arrive in any order, so a position means nothing.
   */
  customId: string
  request: ModelRequest
}

export interface BatchStatus {
  id: string
  processing: 'in_progress' | 'canceling' | 'ended'
  /** Every request counts as `processing` until the whole batch ends. */
  counts: {
    processing: number
    succeeded: number
    errored: number
    canceled: number
    expired: number
  }
  /** When the API stops trying: 24 hours after the batch was created. */
  expiresAt: string
}

/**
 * What became of one request in a batch, in the terms a synchronous send ends in.
 *
 * The API's four result types, with its `succeeded` split in two: a refusal and
 * a reply with nothing to parse both arrive as `succeeded`, and both are errors
 * the synchronous path throws.
 */
export type BatchOutcome =
  /** What `send` would have returned. */
  | { type: 'succeeded'; response: ModelResponse }
  /** Billed, then turned into the error `send` would have thrown. `error.response` is the bill. */
  | { type: 'unusable'; error: TransportError }
  /** The API could not process it. Not billed. `error.retryable` says whether resubmitting can help. */
  | { type: 'errored'; error: TransportError }
  /** Never reached the model, so never billed. */
  | { type: 'canceled' }
  | { type: 'expired' }

export interface BatchResult {
  customId: string
  outcome: BatchOutcome
}

// ---------------------------------------------------------------------------
// The real transport
// ---------------------------------------------------------------------------

/**
 * The beta that lets one request name what happens after a refusal.
 *
 * `-2026-07-01` rather than `-2026-06-01` because only this one accepts the
 * `'default'` form, which routes by refusal category on the server. Naming a
 * fallback model here instead would be a second model ID living outside
 * `MODEL_CONFIG`, and one that goes stale when that model is retired.
 */
const SERVER_SIDE_FALLBACK = 'server-side-fallback-2026-07-01'

export interface AnthropicTransportOptions {
  client?: Anthropic
  /**
   * Whether a policy refusal may be served by a different model.
   *
   * On, the request goes to the beta endpoint with `fallbacks: 'default'`: when
   * the pinned model declines, the API re-runs the same request on the model it
   * routes that refusal category to, inside the same call. The response then
   * names the model that answered, and so does everything built from it —
   * telemetry, the span, the cost line.
   *
   * Off by default, and the reason is specific to this project rather than
   * general caution: every number published here names the model that produced
   * it. A silent substitution part-way through an evaluation would make the
   * headline a blend of two models while the report still claims one, which is
   * exactly the kind of quiet dishonesty the whole harness exists to prevent.
   * Off, the request is exactly the plain `messages.create` call it always was.
   *
   * On for the PR-comment path, where an answer from a fallback model beats no
   * answer at all. Never for `npm run eval`.
   */
  allowModelFallback?: boolean
}

export class AnthropicTransport implements Transport, BatchTransport {
  private readonly client: Anthropic

  constructor(private readonly options: AnthropicTransportOptions = {}) {
    // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // or an `ant auth login` profile — so an absent env var does not mean
    // absent credentials, and the client must not assert on one.
    this.client = options.client ?? new Anthropic()
  }

  /**
   * Counted on the body `send` dispatches, less `max_tokens`.
   *
   * `output_config` included, which `MessageCountTokensParams` accepts. The
   * count used to leave the response format out, so whatever it adds to a
   * request's input was found out only from the bill — by the budget, and by
   * any estimate built on these counts. Counting the same body as is sent is
   * the only way the two can be expected to agree.
   */
  async countInputTokens(request: ModelRequest): Promise<number> {
    const { model, system, messages, output_config } = plainParams(request)
    try {
      const counted = await this.client.messages.countTokens({
        model,
        system,
        messages,
        output_config,
      } satisfies Anthropic.MessageCountTokensParams)
      return counted.input_tokens
    } catch (error) {
      throw classify(error)
    }
  }

  async send(request: ModelRequest): Promise<ModelResponse> {
    const params = plainParams(request)
    const fallback = this.options.allowModelFallback === true

    let response: Anthropic.Message | Anthropic.Beta.BetaMessage
    try {
      // Two endpoints rather than the beta one for both, so that switching
      // fallback off leaves nothing of it in the request: no beta header, no
      // extra field, no beta endpoint for the evaluation run to depend on.
      response = fallback
        ? await this.client.beta.messages.create({
            ...params,
            betas: [SERVER_SIDE_FALLBACK],
            fallbacks: 'default',
          })
        : await this.client.messages.create(params)
    } catch (error) {
      throw classify(error)
    }

    return interpret(response, fallback ? 'fallback' : 'plain')
  }

  /**
   * Every entry as one Message Batch: the body `send` dispatches with fallback
   * off, under the entry's `custom_id`.
   *
   * Refused outright on a transport built to fall back. The Batches API rejects
   * `fallbacks` with a validation error, so the only options are a request
   * without it — a different promise from the one the caller was given — or no
   * request, and the second costs nothing.
   */
  async submitBatch(entries: readonly BatchEntry[]): Promise<BatchStatus> {
    if (this.options.allowModelFallback === true) {
      throw new TransportError(
        'client',
        'a Message Batch cannot carry `fallbacks`; batch through a transport with model fallback off',
      )
    }
    const body = {
      requests: entries.map((entry) => ({
        custom_id: entry.customId,
        params: plainParams(entry.request),
      })),
    } satisfies Anthropic.Messages.BatchCreateParams

    try {
      // `maxRetries: 0`: a create that failed in transit may still have created
      // the batch, and the SDK's own retry would then submit — and bill — a
      // second one. A failed submission is reported instead, and nothing is
      // saved, so the caller can look before submitting again.
      return statusOf(await this.client.messages.batches.create(body, { maxRetries: 0 }))
    } catch (error) {
      throw classify(error)
    }
  }

  async retrieveBatch(id: string): Promise<BatchStatus> {
    try {
      return statusOf(await this.client.messages.batches.retrieve(id))
    } catch (error) {
      throw classify(error)
    }
  }

  /**
   * Every result of an ended batch, in whatever order the API streams them.
   *
   * A `succeeded` message is read exactly as `send` reads a synchronous reply —
   * the refusal check before content is touched, thinking and fallback blocks
   * skipped, the JSON parsed — so nothing downstream can tell a batch answer
   * from a synchronous one except the rate it was billed at.
   */
  async *batchResults(id: string): AsyncGenerator<BatchResult> {
    let lines: AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>
    try {
      lines = await this.client.messages.batches.results(id)
    } catch (error) {
      throw classify(error)
    }
    try {
      for await (const line of lines) {
        yield { customId: line.custom_id, outcome: outcomeOf(line.result) }
      }
    } catch (error) {
      throw classify(error)
    }
  }
}

/**
 * The request body, built once for every endpoint that takes one.
 *
 * The synchronous call, the token count and each request in a batch all read
 * it, so "a batch sends what the synchronous path sends" is true by
 * construction rather than by two copies agreeing.
 */
function plainParams(request: ModelRequest) {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: 'user' as const, content: request.prompt }],
    output_config: {
      effort: request.effort,
      // `schemaName` is deliberately not sent — JSONOutputFormat carries
      // only `type` and `schema`. It is kept on the request for telemetry
      // and error messages, where naming the expected shape is what makes
      // a violation readable.
      format: {
        type: 'json_schema' as const,
        schema: request.jsonSchema as unknown as Record<string, unknown>,
      },
    },
  } satisfies Anthropic.MessageCreateParamsNonStreaming
}

/** Which endpoint a message came back from, which decides what a refusal from it means. */
type Route = 'plain' | 'fallback' | 'batch'

const REFUSED: Record<Route, string> = {
  plain: 'the model declined to classify this input (model fallback is off for this transport)',
  fallback: 'the model declined to classify this input, and no fallback model answered',
  batch:
    'the model declined to classify this input (a Message Batch cannot fall back to another model)',
}

/**
 * A message, read the way the pipeline reads every reply.
 *
 * Shared by the synchronous call and the batch results, which is the point: a
 * refusal inside a `succeeded` batch result is still a refusal, and it has to
 * reach the caller as the same error carrying the same billed usage.
 */
function interpret(
  response: Anthropic.Message | Anthropic.Beta.BetaMessage,
  route: Route,
): ModelResponse {
  const tier = tierOf(response.usage.service_tier, route)
  const billed: BilledResponse = {
    // The model that produced the message, which after a fallback is the
    // fallback's — including a turn the API routed straight to it, which
    // carries no `fallback` block to say so. Reporting `request.model` here
    // instead would be the blend-of-two-models problem in miniature.
    model: response.model,
    // Usage of the attempt that answered. A declined attempt before it is
    // reported per hop in `usage.iterations` and deliberately not added in:
    // its tokens went to another model at another price, and whether they
    // are billed at all depends on when and why it declined.
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    // Only when it is `batch`, so a synchronous reply is exactly the object
    // it was before batches existed.
    ...(tier === 'batch' && { tier }),
  }

  // Checked before `content` is touched. A refused response is a successful
  // HTTP 200 whose content array is empty or partial, so indexing it first
  // turns a policy outcome into an undefined-property crash. With fallback
  // on, a refusal that still reaches here is the final word: either every
  // model in the chain declined, or the category routes to none.
  if (response.stop_reason === 'refusal') {
    throw new TransportError('refusal', REFUSED[route], 200, response.stop_details, billed)
  }

  return {
    raw: extractJson(response.content, billed),
    stopReason: response.stop_reason,
    ...billed,
  }
}

/**
 * How a message was billed, from the API's own `usage.service_tier`.
 *
 * A batch result that leaves the field empty is still a batch result — it came
 * back from the batch endpoint, which bills nothing at the standard rate — and
 * a synchronous reply is standard unless the API says otherwise.
 */
function tierOf(serviceTier: string | null | undefined, route: Route): Tier {
  if (serviceTier === 'batch') return 'batch'
  if (route === 'batch' && (serviceTier === null || serviceTier === undefined)) return 'batch'
  return 'standard'
}

function statusOf(batch: Anthropic.Messages.MessageBatch): BatchStatus {
  return {
    id: batch.id,
    processing: batch.processing_status,
    counts: { ...batch.request_counts },
    expiresAt: batch.expires_at,
  }
}

/**
 * One batch result, in the terms a synchronous send ends in.
 *
 * `errored` maps onto the failure kinds `classify` gives an HTTP error, from
 * the error type the API reports, so whether resubmitting can help is decided
 * by the same rule that decides whether a synchronous call is retried.
 */
function outcomeOf(result: Anthropic.Messages.MessageBatchResult): BatchOutcome {
  switch (result.type) {
    case 'succeeded':
      try {
        return { type: 'succeeded', response: interpret(result.message, 'batch') }
      } catch (error) {
        // `interpret` throws only a TransportError, and always one carrying
        // the billed response: a refusal, or a reply with nothing to read.
        return { type: 'unusable', error: classify(error) }
      }
    case 'errored': {
      const { type, message } = result.error.error
      return {
        type: 'errored',
        error: new TransportError(BATCH_ERROR_KIND[type], `${type}: ${message}`),
      }
    }
    case 'canceled':
      return { type: 'canceled' }
    case 'expired':
      return { type: 'expired' }
  }
}

/** The API's error types, as the failure kinds the retry policy already understands. */
const BATCH_ERROR_KIND: Record<Anthropic.ErrorType, FailureKind> = {
  rate_limit_error: 'rate-limit',
  overloaded_error: 'server',
  api_error: 'server',
  timeout_error: 'server',
  invalid_request_error: 'client',
  authentication_error: 'client',
  permission_error: 'client',
  not_found_error: 'client',
  billing_error: 'client',
}

/**
 * The JSON the model produced, from the text blocks of the response.
 *
 * Thinking blocks are skipped rather than concatenated. With thinking on by
 * default on this model tier, gluing every block together produces a string
 * that is not JSON and fails as a schema violation — which would then be
 * *retried*, spending budget on a bug in this function.
 *
 * A `fallback` block, which marks where a declined model handed over, is
 * skipped the same way. Every text block is the answering model's: a
 * non-streaming response leaves out whatever the declined model wrote before
 * it stopped.
 *
 * Either failure carries the response's usage: the reply was billed whether or
 * not anything in it could be read.
 */
function extractJson(content: readonly { type: string }[], billed: BilledResponse): unknown {
  const text = content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')

  if (text.trim() === '') {
    throw new TransportError(
      'server',
      'the response carried no text block to parse',
      undefined,
      undefined,
      billed,
    )
  }

  try {
    return JSON.parse(text)
  } catch {
    // Structured output should make this impossible; treated as a schema
    // problem rather than a crash so the retry loop can show the model its
    // own output.
    throw new TransportError(
      'server',
      `the response was not JSON: ${text.slice(0, 200)}`,
      undefined,
      undefined,
      billed,
    )
  }
}
