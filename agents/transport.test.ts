import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { classify, TransportError } from './transport.js'

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
const from = (status: number): unknown =>
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
