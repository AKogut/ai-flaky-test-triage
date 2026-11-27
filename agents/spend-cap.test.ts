import { ClassificationSchema } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { UsageLedger } from './ledger.js'
import { callModel, MODEL_CONFIG, TokenBudget, type CallRecord } from './model-client.js'
import { CappedTransport, SpendCap, SpendCapExceededError, worstCaseUsd } from './spend-cap.js'
import type { ModelRequest, ModelResponse, Transport } from './transport.js'

/**
 * The dollar ceiling, without a network.
 *
 * What is pinned is the promise the flag makes: a request whose worst case
 * would take what has been spent past the cap is not sent — not sent and then
 * regretted — and what has been spent is read from the ledger, never tallied
 * a second time.
 */

const VALID = {
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.7,
  reasoning: 'the diff changes the reducer the failing assertion reads',
  evidence: ['expected 3 to equal 4'],
}

const request: ModelRequest = {
  model: 'claude-opus-5-5',
  maxTokens: 8_000,
  effort: 'high',
  system: 'classify',
  prompt: 'this failure',
  schemaName: 'classification',
  jsonSchema: { type: 'object' },
  promptVersion: 'triage.v1',
}

/** Answers with `raw`, billed `usage`, and remembers every request that reached it. */
function live(
  raw: unknown = VALID,
  usage = { inputTokens: 1_000, outputTokens: 8_000 },
): Transport & { sent: ModelRequest[]; counted: number } {
  const sent: ModelRequest[] = []
  const transport = {
    sent,
    counted: 0,
    countInputTokens: () => {
      transport.counted += 1
      return Promise.resolve(1_000)
    },
    send: (r: ModelRequest): Promise<ModelResponse> => {
      sent.push(r)
      return Promise.resolve({ raw, stopReason: 'end_turn', model: r.model, usage })
    },
  }
  return transport
}

// One request at its worst: 1,000 in at $4/M and 8,000 out at $20/M.
const WORST = 0.004 + 0.16

describe('the spending cap', () => {
  it('prices a request at its counted input and every output token it may produce', () => {
    expect(worstCaseUsd(request, 1_000)).toBeCloseTo(WORST, 10)
    expect(worstCaseUsd({ ...request, model: 'claude-future-9' }, 1_000)).toBeNull()
  })

  it('admits what fits and refuses what would pass it, before anything is sent', () => {
    let spent = 0
    const cap = new SpendCap(1, () => spent)
    cap.admit('one', 0.6)()
    spent = 0.6
    expect(() => cap.admit('two', 0.5)).toThrow(SpendCapExceededError)
    expect(() => cap.admit('two', 0.5)).toThrow(
      /could cost up to \$0\.5000.*\$0\.6000 of the \$1\.0000 cap/,
    )
    expect(() => cap.admit('three', 0.4)).not.toThrow()
  })

  /** Two requests admitted at once each see the other, as the token budget's holds do. */
  it('holds what an admitted request could cost until it is released, once', () => {
    const cap = new SpendCap(1, () => 0)
    const release = cap.admit('first', 0.7)
    expect(cap.remaining).toBeCloseTo(0.3, 10)
    expect(() => cap.admit('second', 0.5)).toThrow(SpendCapExceededError)
    release()
    release()
    expect(cap.remaining).toBe(1)
  })

  it('refuses a model it cannot price rather than admitting it for nothing', () => {
    const cap = new SpendCap(100, () => 0)
    expect(() => cap.admit('a request to claude-future-9', null)).toThrow(/no price/)
  })
})

describe('a capped transport', () => {
  it('sends a request that fits, and reuses the count callModel already made', async () => {
    const inner = live()
    const capped = new CappedTransport(inner, new SpendCap(1, () => 0))
    await capped.countInputTokens(request)
    await capped.send(request)
    expect(inner.sent).toHaveLength(1)
    expect(inner.counted).toBe(1)
  })

  it('counts a request it was never asked to count before admitting it', async () => {
    const inner = live()
    await new CappedTransport(inner, new SpendCap(1, () => 0)).send(request)
    expect(inner.counted).toBe(1)
  })

  it('does not send a request whose worst case does not fit', async () => {
    const inner = live()
    const capped = new CappedTransport(inner, new SpendCap(WORST / 2, () => 0))
    await expect(capped.send(request)).rejects.toThrow(SpendCapExceededError)
    expect(inner.sent).toEqual([])
  })

  /**
   * The stop that matters in practice: a schema retry the estimate could not
   * foresee. Every response here is rejected and corrected, each at its worst
   * case, until the ledger has no room for another — and the bill never passes
   * the cap.
   */
  it('stops dispatching when the ledger would pass the cap, and the bill stays under it', async () => {
    const ledger = new UsageLedger()
    const inner = live({ owner: 'not-an-owner' })
    const cap = new SpendCap(2.5 * WORST, () => ledger.spend.usd)
    const calls: CallRecord[] = []

    const error = await callModel(
      {
        schema: ClassificationSchema,
        schemaName: 'classification',
        system: 'classify',
        prompt: 'this failure',
        promptVersion: 'triage.v1',
        label: 'triage a test',
      },
      {
        transport: new CappedTransport(inner, cap),
        config: { ...MODEL_CONFIG, schemaRetries: 5 },
        budget: new TokenBudget(Number.MAX_SAFE_INTEGER, ledger),
        onCall: (c) => calls.push(c),
      },
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SpendCapExceededError)
    expect(inner.sent).toHaveLength(2)
    expect(ledger.spend.usd).toBeLessThanOrEqual(cap.capUsd)
    // Refused, not sent: the ledger lists what was dispatched, and the span
    // says why the call ended the way a token-budget refusal does.
    expect(ledger.dispatches).toHaveLength(2)
    expect(calls[0]?.outcome).toBe('budget')
  })
})
