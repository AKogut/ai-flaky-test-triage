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
  countTokens?: (params: unknown) => Promise<unknown>
}): Anthropic =>
  ({
    messages: {
      create: over.create ?? (() => Promise.resolve(reply([textBlock('{}')]))),
      countTokens: over.countTokens ?? (() => Promise.resolve({ input_tokens: 42 })),
    },
  }) as unknown as Anthropic

const textBlock = (text: string) => ({ type: 'text', text })
const thinkingBlock = (thinking: string) => ({ type: 'thinking', thinking })

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

  it('says fallback is off when it is, so the message explains the situation', async () => {
    const refused = () => Promise.resolve(reply([], { stop_reason: 'refusal', stop_details: null }))

    const off = new AnthropicTransport({ client: stubClient({ create: refused }) })
    await expect(off.send(request)).rejects.toThrow(/fallback is disabled/)

    const on = new AnthropicTransport({
      client: stubClient({ create: refused }),
      allowModelFallback: true,
    })
    await expect(on.send(request)).rejects.not.toThrow(/fallback is disabled/)
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
