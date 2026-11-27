import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AnthropicTransport, classify, TransportError } from './transport.js'

/**
 * The SDK-exception mapping, tested against real SDK errors.
 *
 * This is the part of the retry policy that rots without anything going red.
 * `model-client.test.ts` stubs the transport, so every branch there is driven
 * by a `TransportError` this file's function was supposed to produce — a new
 * SDK error class, a reordered `instanceof` chain, or a renamed status field
 * would change what gets retried while every one of those tests still passes.
 *
 * Errors are built with the SDK's own factory rather than hand-rolled objects,
 * so the test breaks if the SDK's hierarchy moves under it. That is the point.
 */

/**
 * A real SDK error for a given status.
 *
 * The headers argument is load-bearing and easy to get wrong: `generate` with
 * `undefined` headers returns an `APIConnectionError` regardless of the status,
 * because to the SDK "no headers" means no response ever arrived. Passing them
 * is what produces the status-specific subclass — the first draft of this
 * helper omitted them and every case silently became a connection error.
 */
const from = (status: number): Error =>
  Anthropic.APIError.generate(
    status,
    { error: { message: `status ${String(status)}` } },
    undefined,
    new Headers({ 'content-type': 'application/json' }),
  )

describe('classifying SDK errors', () => {
  it.each([
    [429, 'rate-limit'],
    [500, 'server'],
    [503, 'server'],
    [529, 'server'],
  ])('treats %i as %s, which is retryable', (status, kind) => {
    const classified = classify(from(status))
    expect(classified.kind).toBe(kind)
    expect(classified.retryable).toBe(true)
  })

  it.each([
    [400, 'a malformed request'],
    [401, 'a missing key'],
    [403, 'a key without permission'],
    [404, 'an unknown model'],
    [413, 'an oversized request'],
    [422, 'an unprocessable body'],
  ])('refuses to retry %i — %s', (status) => {
    const classified = classify(from(status))
    expect(classified.kind).toBe('client')
    expect(classified.retryable).toBe(false)
  })

  it('treats a response that never arrived as a retryable server fault', () => {
    // The SDK models "no headers" as no response at all. A request that died in
    // the network is exactly the case worth retrying.
    const noResponse = Anthropic.APIError.generate(500, undefined, 'socket hang up', undefined)
    expect(noResponse).toBeInstanceOf(Anthropic.APIConnectionError)
    expect(classify(noResponse).retryable).toBe(true)
  })

  it('maps a connection failure to a retryable server fault', () => {
    // Checked before the general APIError case, because in this SDK
    // APIConnectionError is a subclass — the general branch would swallow it
    // and classify a recoverable network blip as a permanent 4xx.
    const classified = classify(new Anthropic.APIConnectionError({ message: 'socket hang up' }))
    expect(classified.kind).toBe('server')
    expect(classified.retryable).toBe(true)
  })

  it('confirms the subclass relationship the ordering depends on', () => {
    // If this ever stops being true, the ordering above is no longer load-
    // bearing and the comment explaining it is misleading.
    expect(new Anthropic.APIConnectionError({ message: 'x' })).toBeInstanceOf(Anthropic.APIError)
  })

  it('carries the status through, so a failure can be diagnosed without a rerun', () => {
    expect(classify(from(429)).status).toBe(429)
    expect(classify(from(400)).status).toBe(400)
  })

  it('keeps the original error as the cause', () => {
    const original = from(500)
    expect(classify(original).cause).toBe(original)
  })

  it('passes an already-classified error through unchanged', () => {
    // Otherwise a refusal, which the transport raises itself, would be
    // re-wrapped as an unclassified client fault and lose its kind.
    const refusal = new TransportError('refusal', 'declined', 200)
    expect(classify(refusal)).toBe(refusal)
  })

  it.each([
    ['a plain Error', new Error('something went wrong')],
    ['a thrown string', 'nope'],
    ['a thrown object', { weird: true }],
  ])('treats %s as a client fault rather than retrying it', (_case, thrown) => {
    // Retrying something nobody has classified is how a bug becomes a bill.
    const classified = classify(thrown)
    expect(classified.kind).toBe('client')
    expect(classified.retryable).toBe(false)
  })

  it('keeps a message for anything it could not classify', () => {
    expect(classify(new Error('socket exploded')).message).toBe('socket exploded')
    expect(classify('nope').message).toBe('nope')
  })
})

describe('TransportError', () => {
  it.each([
    ['rate-limit', true],
    ['server', true],
    ['client', false],
    ['refusal', false],
  ] as const)('%s is retryable: %s', (kind, retryable) => {
    expect(new TransportError(kind, 'x').retryable).toBe(retryable)
  })

  it('does not treat a refusal as a fault to retry', () => {
    // A refusal is a decision. Asking again spends budget to be told the same
    // thing, and on an evaluation run it would do so 33 times.
    expect(new TransportError('refusal', 'declined', 200).retryable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AnthropicTransport
// ---------------------------------------------------------------------------

/**
 * A stand-in for the SDK client.
 *
 * The transport takes its client by injection precisely so this exists: the
 * response-shape handling below — skipping thinking blocks, catching a refusal
 * before touching content — is the code most likely to be wrong and least
 * likely to be exercised, because reaching it for real costs money and a
 * network.
 */
const stubClient = (over: {
  create?: (params: unknown) => Promise<unknown>
  betaCreate?: (params: unknown) => Promise<unknown>
  countTokens?: (params: unknown) => Promise<unknown>
  batches?: {
    create?: (params: unknown, options?: unknown) => Promise<unknown>
    retrieve?: (id: string) => Promise<unknown>
    results?: (id: string) => Promise<AsyncIterable<unknown>>
  }
}): Anthropic =>
  ({
    messages: {
      create: over.create ?? (() => Promise.resolve(reply([textBlock('{}')]))),
      countTokens: over.countTokens ?? (() => Promise.resolve({ input_tokens: 42 })),
      // Fails loudly by default, like the beta endpoint: a test that submits a
      // batch without saying so has found a path nobody meant to pay for.
      batches: {
        create: over.batches?.create ?? (() => Promise.reject(new Error('no batch was expected'))),
        retrieve:
          over.batches?.retrieve ?? (() => Promise.reject(new Error('no batch was expected'))),
        results:
          over.batches?.results ?? (() => Promise.reject(new Error('no batch was expected'))),
      },
    },
    beta: {
      messages: {
        // Fails loudly by default: a test that reaches the beta endpoint
        // without saying so has found a path the plain call was meant to keep.
        create:
          over.betaCreate ??
          (() => Promise.reject(new Error('the beta endpoint was not expected'))),
      },
    },
  }) as unknown as Anthropic

const textBlock = (text: string) => ({ type: 'text', text })
const thinkingBlock = (thinking: string) => ({ type: 'thinking', thinking })
/** Checked against the SDK's own type, so the fixture moves if the pinned SDK's shape does. */
const fallbackBlock = (from: string, to: string) =>
  ({
    type: 'fallback',
    from: { model: from },
    to: { model: to },
    trigger: { type: 'refusal', category: 'cyber' },
  }) satisfies Anthropic.Beta.BetaFallbackBlock

const reply = (content: unknown[], over: Record<string, unknown> = {}) => ({
  content,
  stop_reason: 'end_turn',
  stop_details: null,
  model: 'claude-opus-5',
  usage: { input_tokens: 120, output_tokens: 34 },
  ...over,
})

const request = {
  model: 'claude-opus-5',
  maxTokens: 8000,
  effort: 'high' as const,
  system: 'classify',
  prompt: 'this failure',
  schemaName: 'Classification',
  jsonSchema: { type: 'object' as const },
  promptVersion: 'triage.v1',
}

describe('AnthropicTransport', () => {
  it('returns the parsed JSON, usage and served model', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({
        create: () => Promise.resolve(reply([textBlock('{"owner":"app_code"}')])),
      }),
    })
    const response = await transport.send(request)

    expect(response.raw).toEqual({ owner: 'app_code' })
    expect(response.model).toBe('claude-opus-5')
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 34 })
  })

  it('skips thinking blocks instead of gluing them to the JSON', async () => {
    // Thinking is on by default on this tier. Concatenating every block yields
    // a string that is not JSON, which would surface as a schema violation and
    // be *retried* — spending real budget on a bug in the parser.
    const transport = new AnthropicTransport({
      client: stubClient({
        create: () =>
          Promise.resolve(
            reply([thinkingBlock('Let me weigh the diff…'), textBlock('{"owner":"test_code"}')]),
          ),
      }),
    })
    await expect(transport.send(request)).resolves.toMatchObject({ raw: { owner: 'test_code' } })
  })

  it('joins several text blocks before parsing', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({
        create: () => Promise.resolve(reply([textBlock('{"owner":'), textBlock('"app_code"}')])),
      }),
    })
    await expect(transport.send(request)).resolves.toMatchObject({ raw: { owner: 'app_code' } })
  })

  it('raises a refusal before touching the content array', async () => {
    // A refused response is a successful HTTP 200 whose content is empty or
    // partial. Reading content[0] first turns a policy outcome into an
    // undefined-property crash that says nothing about what happened.
    const transport = new AnthropicTransport({
      client: stubClient({
        create: () =>
          Promise.resolve(
            reply([], {
              stop_reason: 'refusal',
              stop_details: { type: 'refusal', category: 'cyber' },
            }),
          ),
      }),
    })

    const error = (await transport.send(request).catch((e: unknown) => e)) as TransportError
    expect(error).toBeInstanceOf(TransportError)
    expect(error.kind).toBe('refusal')
    expect(error.retryable).toBe(false)
    expect(error.cause).toMatchObject({ category: 'cyber' })
  })

  /**
   * A refusal is a 200 the API bills like an answer. Thrown away here, its
   * tokens reached no figure anywhere — the budget, the spans, the footer and
   * the evaluation all missed it — so the error carries what was billed.
   */
  it('carries what a refusal was billed, and which model refused', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({
        create: () =>
          Promise.resolve(
            reply([], { stop_reason: 'refusal', usage: { input_tokens: 900, output_tokens: 3 } }),
          ),
      }),
    })
    const error = (await transport.send(request).catch((e: unknown) => e)) as TransportError
    expect(error.response).toEqual({
      model: 'claude-opus-5',
      usage: { inputTokens: 900, outputTokens: 3 },
    })
  })

  it.each([
    ['no text block', [thinkingBlock('…')]],
    ['not JSON', [textBlock('I think app_code.')]],
  ])('carries what an unreadable reply was billed: %s', async (_name, content) => {
    const transport = new AnthropicTransport({
      client: stubClient({ create: () => Promise.resolve(reply(content)) }),
    })
    const error = (await transport.send(request).catch((e: unknown) => e)) as TransportError
    expect(error.kind).toBe('server')
    expect(error.response?.usage).toEqual({ inputTokens: 120, outputTokens: 34 })
  })

  it('carries no response for a failure that never got one', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({ create: () => Promise.reject(from(429)) }),
    })
    const error = (await transport.send(request).catch((e: unknown) => e)) as TransportError
    expect(error.response).toBeUndefined()
  })

  it('says whether a fallback was asked for, so the message explains the situation', async () => {
    const refused = () => Promise.resolve(reply([], { stop_reason: 'refusal', stop_details: null }))

    const off = new AnthropicTransport({ client: stubClient({ create: refused }) })
    await expect(off.send(request)).rejects.toThrow(/model fallback is off/)

    const on = new AnthropicTransport({
      client: stubClient({ betaCreate: refused }),
      allowModelFallback: true,
    })
    await expect(on.send(request)).rejects.toThrow(/no fallback model answered/)
  })

  it('treats a response with no text as a retryable fault, not a crash', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({ create: () => Promise.resolve(reply([thinkingBlock('…')])) }),
    })
    const error = (await transport.send(request).catch((e: unknown) => e)) as TransportError
    expect(error.kind).toBe('server')
    expect(error.message).toContain('no text block')
  })

  it('quotes what it got when the response is not JSON', async () => {
    // Structured output should make this impossible. If it happens anyway, the
    // message has to carry the evidence — otherwise diagnosing it needs a rerun
    // against a live model.
    const transport = new AnthropicTransport({
      client: stubClient({
        create: () => Promise.resolve(reply([textBlock('I think app_code.')])),
      }),
    })
    await expect(transport.send(request)).rejects.toThrow(/was not JSON: I think app_code\./)
  })

  it('classifies a failure from the SDK rather than letting it escape raw', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({ create: () => Promise.reject(from(429)) }),
    })
    const error = (await transport.send(request).catch((e: unknown) => e)) as TransportError
    expect(error).toBeInstanceOf(TransportError)
    expect(error.kind).toBe('rate-limit')
  })

  it('counts tokens against the same model that will serve the request', async () => {
    const countTokens = vi.fn((_params: unknown) => Promise.resolve({ input_tokens: 4242 }))
    const transport = new AnthropicTransport({ client: stubClient({ countTokens }) })

    await expect(transport.countInputTokens(request)).resolves.toBe(4242)
    expect(countTokens).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-5', system: 'classify' }),
    )
  })

  /**
   * A count taken on a different body from the one sent is a count of a
   * different request. The response format used to be left out, so whatever
   * it adds was found only on the bill — by the budget, and by any estimate
   * built on the counts.
   */
  it('counts the body it sends, structured-output format included, less max_tokens', async () => {
    const countTokens = vi.fn((_params: unknown) => Promise.resolve({ input_tokens: 1 }))
    const create = vi.fn((_params: unknown) => Promise.resolve(reply([textBlock('{}')])))
    const transport = new AnthropicTransport({ client: stubClient({ countTokens, create }) })

    await transport.countInputTokens(request)
    await transport.send(request)

    const { max_tokens: _maxTokens, ...sent } = create.mock.calls[0]?.[0] as Record<string, unknown>
    expect(countTokens.mock.calls[0]?.[0]).toStrictEqual(sent)
  })

  it('classifies a counting failure too, so the budget check retries like a send', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({ countTokens: () => Promise.reject(from(500)) }),
    })
    const error = (await transport
      .countInputTokens(request)
      .catch((e: unknown) => e)) as TransportError
    expect(error.kind).toBe('server')
    expect(error.retryable).toBe(true)
  })

  it('sends no sampling parameter, which this model rejects with a 400', async () => {
    const create = vi.fn((_params: unknown) => Promise.resolve(reply([textBlock('{}')])))
    await new AnthropicTransport({ client: stubClient({ create }) }).send(request)

    const sent = create.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'budget_tokens']) {
      expect(sent).not.toHaveProperty(forbidden)
    }
  })

  it('asks for structured output derived from the schema it was given', async () => {
    const create = vi.fn((_params: unknown) => Promise.resolve(reply([textBlock('{}')])))
    await new AnthropicTransport({ client: stubClient({ create }) }).send(request)

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      max_tokens: 8000,
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: { type: 'object' } },
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Model fallback
// ---------------------------------------------------------------------------

/**
 * What a fallback changes on the wire, and what it must leave alone.
 *
 * None of this has met the live API — the project has no key — so the shapes
 * below are the ones the pinned SDK types, and the assertions are about the
 * request this file sends and how it reads a response of that shape.
 */
describe('AnthropicTransport with model fallback', () => {
  /**
   * The request body as it was before fallback existed, key order included.
   *
   * Pinned as a string because the claim is "byte-for-byte unchanged", and an
   * object comparison would let a reordered key through.
   */
  const PLAIN_BODY =
    '{"model":"claude-opus-5","max_tokens":8000,"system":"classify",' +
    '"messages":[{"role":"user","content":"this failure"}],' +
    '"output_config":{"effort":"high","format":{"type":"json_schema","schema":{"type":"object"}}}}'

  const plainParams = JSON.parse(PLAIN_BODY) as Record<string, unknown>

  it('leaves the request exactly as it was when fallback is off', async () => {
    // The evaluation path constructs the transport with no options. Off has to
    // mean the plain endpoint and the plain body — not the beta endpoint with
    // the fallback left out, which is a different request to the API and to
    // anyone reading a recorded run.
    const create = vi.fn((_params: unknown) => Promise.resolve(reply([textBlock('{}')])))
    const betaCreate = vi.fn((_params: unknown) => Promise.resolve(reply([textBlock('{}')])))
    await new AnthropicTransport({ client: stubClient({ create, betaCreate }) }).send(request)

    expect(betaCreate).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]).toHaveLength(1)
    const sent = create.mock.calls[0]?.[0]
    // Strict equality catches a key present as `undefined`, which the string
    // comparison would not see.
    expect(sent).toStrictEqual(plainParams)
    expect(JSON.stringify(sent)).toBe(PLAIN_BODY)
  })

  it('sends the same request to the beta endpoint, plus the header and fallbacks, when on', async () => {
    const create = vi.fn((_params: unknown) => Promise.resolve(reply([textBlock('{}')])))
    const betaCreate = vi.fn((_params: unknown) => Promise.resolve(reply([textBlock('{}')])))
    await new AnthropicTransport({
      client: stubClient({ create, betaCreate }),
      allowModelFallback: true,
    }).send(request)

    expect(create).not.toHaveBeenCalled()
    expect(betaCreate).toHaveBeenCalledTimes(1)
    // Everything the plain call sends, unchanged — effort and the JSON schema
    // format included — plus exactly two fields. `'default'` rather than a
    // named model, so the fallback is routed by refusal category and no
    // second model ID lives outside MODEL_CONFIG.
    expect(betaCreate.mock.calls[0]?.[0]).toStrictEqual({
      ...plainParams,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
  })

  it.each([
    [
      'after the pinned model declined',
      [
        fallbackBlock('claude-opus-5-5', 'claude-opus-4-8'),
        thinkingBlock('…'),
        textBlock('{"owner":"test_code"}'),
      ],
    ],
    [
      // Once a conversation has fallen back, the API serves later turns from the
      // fallback model directly for a while. Those carry no `fallback` block, so
      // the block cannot be what decides which model is reported.
      'on a turn routed straight to the fallback, with no block to mark it',
      [textBlock('{"owner":"test_code"}')],
    ],
  ])('names the model that answered %s', async (_case, content) => {
    const transport = new AnthropicTransport({
      client: stubClient({
        betaCreate: () =>
          Promise.resolve(
            reply(content, {
              model: 'claude-opus-4-8',
              usage: {
                input_tokens: 130,
                output_tokens: 40,
                iterations: [
                  {
                    type: 'message',
                    model: 'claude-opus-5-5',
                    input_tokens: 120,
                    output_tokens: 0,
                  },
                  {
                    type: 'fallback_message',
                    model: 'claude-opus-4-8',
                    input_tokens: 130,
                    output_tokens: 40,
                  },
                ],
              },
            }),
          ),
      }),
      allowModelFallback: true,
    })
    const response = await transport.send({ ...request, model: 'claude-opus-5-5' })

    // The served model, not the requested one: this is what telemetry, the
    // span and the cost line are built from.
    expect(response.model).toBe('claude-opus-4-8')
    expect(response.raw).toEqual({ owner: 'test_code' })
    expect(response.usage).toEqual({ inputTokens: 130, outputTokens: 40 })
  })

  it('raises the same refusal when the whole chain declines', async () => {
    // A fallback model can refuse too. The final `stop_reason` is the chain's
    // answer, and it has to land exactly where a refusal without fallback does:
    // a non-retryable TransportError, not a parse of whatever content came back.
    const transport = new AnthropicTransport({
      client: stubClient({
        betaCreate: () =>
          Promise.resolve(
            reply([fallbackBlock('claude-opus-5-5', 'claude-opus-4-8')], {
              model: 'claude-opus-4-8',
              stop_reason: 'refusal',
              stop_details: { type: 'refusal', category: 'cyber' },
            }),
          ),
      }),
      allowModelFallback: true,
    })

    const error = (await transport
      .send({ ...request, model: 'claude-opus-5-5' })
      .catch((e: unknown) => e)) as TransportError
    expect(error).toBeInstanceOf(TransportError)
    expect(error.kind).toBe('refusal')
    expect(error.retryable).toBe(false)
    expect(error.status).toBe(200)
    expect(error.cause).toMatchObject({ category: 'cyber' })
  })

  it('classifies a failure from the beta endpoint like one from the plain endpoint', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({ betaCreate: () => Promise.reject(from(529)) }),
      allowModelFallback: true,
    })
    const error = (await transport.send(request).catch((e: unknown) => e)) as TransportError
    expect(error).toBeInstanceOf(TransportError)
    expect(error.kind).toBe('server')
    expect(error.retryable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Message Batches
// ---------------------------------------------------------------------------

/**
 * Shapes from the pinned SDK's `resources/messages/batches.d.ts`, checked with
 * `satisfies` so a fixture breaks when the SDK's shape moves. None of this has
 * met the live API — there is no key — so these pin what this file sends and
 * how it reads a response of the declared shape.
 */
const counts = { processing: 0, succeeded: 2, errored: 0, canceled: 0, expired: 0 }
const messageBatch = (over: Partial<Anthropic.Messages.MessageBatch> = {}) =>
  ({
    id: 'msgbatch_01',
    archived_at: null,
    cancel_initiated_at: null,
    created_at: '2026-11-27T10:00:00Z',
    ended_at: null,
    expires_at: '2026-11-28T10:00:00Z',
    processing_status: 'in_progress',
    request_counts: counts,
    results_url: null,
    type: 'message_batch',
    ...over,
  }) satisfies Anthropic.Messages.MessageBatch

const batchMessage = (content: unknown[], over: Record<string, unknown> = {}) =>
  reply(content, {
    usage: { input_tokens: 120, output_tokens: 34, service_tier: 'batch' },
    ...over,
  })

async function* lines(...items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield await Promise.resolve(item)
}

const drain = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

const erroredLine = (customId: string, type: Anthropic.ErrorType, message: string) =>
  ({
    custom_id: customId,
    result: {
      type: 'errored',
      error: { type: 'error', request_id: null, error: { type, message } },
    },
  }) as const

describe('AnthropicTransport with Message Batches', () => {
  it('submits each request under its custom_id with the body a synchronous send carries', async () => {
    const create = vi.fn((_params: unknown) => Promise.resolve(reply([textBlock('{}')])))
    const batchCreate = vi.fn((_params: unknown, _options?: unknown) =>
      Promise.resolve(messageBatch()),
    )
    const transport = new AnthropicTransport({
      client: stubClient({ create, batches: { create: batchCreate } }),
    })

    await transport.send(request)
    const status = await transport.submitBatch([
      { customId: 'a1b2c3d4e5f6a7b8', request },
      { customId: 'b2c3d4e5f6a7b8c9', request: { ...request, sample: 1 } },
    ])

    const synchronous = create.mock.calls[0]?.[0]
    const body = batchCreate.mock.calls[0]?.[0] as Anthropic.Messages.BatchCreateParams
    expect(body.requests.map((r) => r.custom_id)).toEqual(['a1b2c3d4e5f6a7b8', 'b2c3d4e5f6a7b8c9'])
    // Byte for byte, effort and the JSON schema format included: the batch is
    // the same question at a different price, never a different question.
    expect(JSON.stringify(body.requests[0]?.params)).toBe(JSON.stringify(synchronous))
    expect(body.requests[0]?.params).not.toHaveProperty('fallbacks')
    expect(status).toEqual({
      id: 'msgbatch_01',
      processing: 'in_progress',
      counts,
      expiresAt: '2026-11-28T10:00:00Z',
    })
  })

  /**
   * A create that failed in transit may still have created the batch. The
   * SDK's own retry would then submit — and bill — a second one.
   */
  it('submits once, with the SDK retry off', async () => {
    const batchCreate = vi.fn((_params: unknown, _options?: unknown) =>
      Promise.resolve(messageBatch()),
    )
    await new AnthropicTransport({
      client: stubClient({ batches: { create: batchCreate } }),
    }).submitBatch([{ customId: 'a', request }])
    expect(batchCreate.mock.calls[0]?.[1]).toEqual({ maxRetries: 0 })
  })

  it('refuses to batch on a transport built to fall back, which the Batches API rejects', async () => {
    const batchCreate = vi.fn(() => Promise.resolve(messageBatch()))
    const transport = new AnthropicTransport({
      client: stubClient({ batches: { create: batchCreate } }),
      allowModelFallback: true,
    })
    await expect(transport.submitBatch([{ customId: 'a', request }])).rejects.toThrow(/fallbacks/)
    expect(batchCreate).not.toHaveBeenCalled()
  })

  it('classifies a failed submission like any other failure', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({ batches: { create: () => Promise.reject(from(400)) } }),
    })
    const error = (await transport
      .submitBatch([{ customId: 'a', request }])
      .catch((e: unknown) => e)) as TransportError
    expect(error).toBeInstanceOf(TransportError)
    expect(error.kind).toBe('client')
  })

  it('polls a batch into the status the runner reads, and classifies a failed poll', async () => {
    const ended = new AnthropicTransport({
      client: stubClient({
        batches: { retrieve: () => Promise.resolve(messageBatch({ processing_status: 'ended' })) },
      }),
    })
    await expect(ended.retrieveBatch('msgbatch_01')).resolves.toMatchObject({
      id: 'msgbatch_01',
      processing: 'ended',
    })

    const failing = new AnthropicTransport({
      client: stubClient({ batches: { retrieve: () => Promise.reject(from(529)) } }),
    })
    const error = (await failing
      .retrieveBatch('msgbatch_01')
      .catch((e: unknown) => e)) as TransportError
    expect(error.retryable).toBe(true)
  })

  it('reads every result type, in the order the API streams them', async () => {
    const results = [
      {
        custom_id: 'second',
        result: { type: 'succeeded', message: batchMessage([textBlock('{"owner":"app_code"}')]) },
      },
      {
        custom_id: 'refused',
        result: {
          type: 'succeeded',
          message: batchMessage([], {
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber' },
          }),
        },
      },
      erroredLine('overloaded', 'overloaded_error', 'Overloaded'),
      erroredLine('limited', 'rate_limit_error', 'slow down'),
      erroredLine('invalid', 'invalid_request_error', 'bad schema'),
      { custom_id: 'canceled', result: { type: 'canceled' } },
      { custom_id: 'first', result: { type: 'expired' } },
    ]

    const transport = new AnthropicTransport({
      client: stubClient({ batches: { results: () => Promise.resolve(lines(...results)) } }),
    })
    const read = await drain(transport.batchResults('msgbatch_01'))

    // Passed on in stream order, keyed: matching is the caller's job, by id.
    expect(read.map((r) => r.customId)).toEqual([
      'second',
      'refused',
      'overloaded',
      'limited',
      'invalid',
      'canceled',
      'first',
    ])
    const [answered, refused, overloaded, limited, invalid, canceled, expired] = read.map(
      (r) => r.outcome,
    )

    expect(answered).toEqual({
      type: 'succeeded',
      response: {
        raw: { owner: 'app_code' },
        stopReason: 'end_turn',
        model: 'claude-opus-5',
        usage: { inputTokens: 120, outputTokens: 34 },
        tier: 'batch',
      },
    })

    // A refusal inside a `succeeded` result is the same error a synchronous
    // refusal is, carrying what it was billed — at the batch rate.
    expect(refused?.type).toBe('unusable')
    const error = refused?.type === 'unusable' ? refused.error : undefined
    expect(error?.kind).toBe('refusal')
    expect(error?.retryable).toBe(false)
    expect(error?.message).toMatch(/cannot fall back/)
    expect(error?.response).toEqual({
      model: 'claude-opus-5',
      usage: { inputTokens: 120, outputTokens: 34 },
      tier: 'batch',
    })

    // Errored results keep the distinction the retry policy draws: an
    // overload or a rate limit can be resubmitted, a malformed request cannot.
    expect(overloaded?.type === 'errored' && overloaded.error.kind).toBe('server')
    expect(limited?.type === 'errored' && limited.error.kind).toBe('rate-limit')
    expect(invalid?.type === 'errored' && invalid.error.retryable).toBe(false)
    expect(invalid?.type === 'errored' && invalid.error.message).toBe(
      'invalid_request_error: bad schema',
    )
    expect(canceled).toEqual({ type: 'canceled' })
    expect(expired).toEqual({ type: 'expired' })
  })

  it('reads an unreadable batch reply as the retryable fault a synchronous one is', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({
        batches: {
          results: () =>
            Promise.resolve(
              lines({
                custom_id: 'a',
                result: { type: 'succeeded', message: batchMessage([thinkingBlock('…')]) },
              }),
            ),
        },
      }),
    })
    const [result] = await drain(transport.batchResults('msgbatch_01'))
    expect(result?.outcome.type).toBe('unusable')
    const error = result?.outcome.type === 'unusable' ? result.outcome.error : undefined
    expect(error?.kind).toBe('server')
    expect(error?.response?.tier).toBe('batch')
  })

  /** A batch result that leaves `service_tier` empty still came from the batch endpoint. */
  it('prices a batch result at the batch rate when the API leaves the tier out', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({
        batches: {
          results: () =>
            Promise.resolve(
              lines({
                custom_id: 'a',
                result: { type: 'succeeded', message: reply([textBlock('{}')]) },
              }),
            ),
        },
      }),
    })
    const [result] = await drain(transport.batchResults('msgbatch_01'))
    expect(result?.outcome.type === 'succeeded' && result.outcome.response.tier).toBe('batch')
  })

  it('leaves a synchronous reply exactly as it was, with no tier on it', async () => {
    const transport = new AnthropicTransport({
      client: stubClient({ create: () => Promise.resolve(reply([textBlock('{}')])) }),
    })
    expect(await transport.send(request)).not.toHaveProperty('tier')
  })

  it('classifies a failure to fetch results, and one part-way through them', async () => {
    const gone = new AnthropicTransport({
      client: stubClient({ batches: { results: () => Promise.reject(from(404)) } }),
    })
    const missing = (await drain(gone.batchResults('gone')).catch(
      (e: unknown) => e,
    )) as TransportError
    expect(missing).toBeInstanceOf(TransportError)
    expect(missing.kind).toBe('client')

    async function* broken(): AsyncGenerator<unknown> {
      yield await Promise.resolve({ custom_id: 'a', result: { type: 'expired' } })
      throw from(500)
    }
    const cut = new AnthropicTransport({
      client: stubClient({ batches: { results: () => Promise.resolve(broken()) } }),
    })
    const error = (await drain(cut.batchResults('cut')).catch((e: unknown) => e)) as TransportError
    expect(error).toBeInstanceOf(TransportError)
    expect(error.kind).toBe('server')
  })
})
