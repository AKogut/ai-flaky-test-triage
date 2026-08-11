import { ClassificationSchema } from '@sentra/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  BudgetExceededError,
  callModel,
  MODEL_CONFIG,
  SchemaViolationError,
  TokenBudget,
  type CallDeps,
  type ModelConfig,
} from './model-client.js'
import {
  TransportError,
  type ModelRequest,
  type ModelResponse,
  type Transport,
} from './transport.js'

/**
 * Every retry branch, exercised without a network or a wall clock.
 *
 * The transport is a port precisely so this file can produce a rate limit, a
 * 4xx, a malformed response and a refusal on demand. A retry policy whose
 * branches are only reachable against a live API is a policy nobody has
 * watched work — and the branch that matters most is the one that decides *not*
 * to retry, which never fires in a happy-path integration test.
 */

const VALID = {
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.7,
  reasoning: 'the diff changes the reducer the failing assertion reads',
  evidence: ['expected 3 to equal 4'],
}

/** A transport driven by a queued script, so a test states the sequence it wants. */
function scripted(
  steps: (ModelResponse | Error)[],
  tokensPerCall = 100,
): Transport & {
  sent: ModelRequest[]
  counted: ModelRequest[]
} {
  const sent: ModelRequest[] = []
  const counted: ModelRequest[] = []
  const queue = [...steps]

  return {
    sent,
    counted,
    countInputTokens(request) {
      counted.push(request)
      return Promise.resolve(tokensPerCall)
    },
    send(request) {
      sent.push(request)
      const step = queue.shift()
      if (step === undefined) throw new Error('the transport ran out of scripted steps')
      if (step instanceof Error) return Promise.reject(step)
      return Promise.resolve(step)
    },
  }
}

const ok = (raw: unknown = VALID): ModelResponse => ({
  raw,
  stopReason: 'end_turn',
  model: MODEL_CONFIG.model,
  usage: { inputTokens: 100, outputTokens: 40 },
})

const call = (deps: Partial<CallDeps> & { transport: Transport }) =>
  callModel(
    {
      schema: ClassificationSchema,
      schemaName: 'Classification',
      system: 'You classify test failures.',
      prompt: 'Classify this failure.',
      promptVersion: 'triage.v1',
      label: 'triage',
    },
    { sleep: () => Promise.resolve(), random: () => 0.5, now: () => 0, ...deps },
  )

describe('a successful call', () => {
  it('returns the parsed value, not the raw response', async () => {
    const { value } = await call({ transport: scripted([ok()]) })
    expect(value.owner).toBe('app_code')
    expect(value.confidence).toBe(0.7)
  })

  it('never writes a model ID at the call site', async () => {
    // The one answer to "which model produced this number" lives in config.
    const transport = scripted([ok()])
    await call({ transport })
    expect(transport.sent[0]?.model).toBe(MODEL_CONFIG.model)
  })

  it('derives the response schema from the Zod type', async () => {
    const transport = scripted([ok()])
    await call({ transport })
    const schema = transport.sent[0]?.jsonSchema
    expect(schema?.properties).toHaveProperty('owner')
    expect(schema?.required).toEqual(expect.arrayContaining(['owner', 'determinism']))
  })

  it('reports what the call cost and how many dispatches it took', async () => {
    const { telemetry } = await call({ transport: scripted([ok()]) })
    expect(telemetry).toMatchObject({
      label: 'triage',
      promptVersion: 'triage.v1',
      attempts: 1,
      schemaViolations: 0,
      transientFailures: 0,
      inputTokens: 100,
      outputTokens: 40,
    })
  })

  it('emits telemetry to the observer as well as returning it', async () => {
    const onTelemetry = vi.fn()
    await call({ transport: scripted([ok()]), onTelemetry })
    expect(onTelemetry).toHaveBeenCalledOnce()
  })
})

describe('schema violations', () => {
  it('retries and shows the model its own errors', async () => {
    // A bare "try again" re-runs the same misunderstanding at the same price.
    const transport = scripted([ok({ owner: 'app_code' }), ok()])
    const { value, telemetry } = await call({ transport })

    expect(value.owner).toBe('app_code')
    expect(telemetry.schemaViolations).toBe(1)
    expect(telemetry.attempts).toBe(2)
    expect(transport.sent[1]?.prompt).toContain('did not match the required schema')
    expect(transport.sent[1]?.prompt).toContain('determinism')
  })

  it('does not append corrections to the first attempt', async () => {
    const transport = scripted([ok()])
    await call({ transport })
    expect(transport.sent[0]?.prompt).toBe('Classify this failure.')
  })

  it('gives up after the configured number of attempts, naming the last issues', async () => {
    const transport = scripted([ok({}), ok({}), ok({})])
    await expect(call({ transport })).rejects.toThrow(SchemaViolationError)
    expect(transport.sent).toHaveLength(MODEL_CONFIG.schemaRetries + 1)
  })

  it('rejects a response that is well-formed but violates a business rule', async () => {
    // `evidence` is non-empty by schema — the requirement that makes an
    // overconfident answer visible in review rather than buried in a decimal.
    const transport = scripted([ok({ ...VALID, evidence: [] }), ok()])
    const { telemetry } = await call({ transport })
    expect(telemetry.schemaViolations).toBe(1)
  })
})

describe('transient failures', () => {
  const rateLimit = () => new TransportError('rate-limit', 'slow down', 429)
  const server = () => new TransportError('server', 'upstream fell over', 503)

  it('retries a rate limit', async () => {
    const { telemetry } = await call({ transport: scripted([rateLimit(), ok()]) })
    expect(telemetry.transientFailures).toBe(1)
  })

  it('retries a server fault', async () => {
    const { telemetry } = await call({ transport: scripted([server(), ok()]) })
    expect(telemetry.transientFailures).toBe(1)
  })

  it('backs off exponentially, with jitter', async () => {
    // Full jitter rather than a fixed curve: a fleet that all backs off
    // identically re-collides at every step, turning one rate limit into a herd.
    const sleep = vi.fn((_ms: number) => Promise.resolve())
    await call({
      transport: scripted([rateLimit(), rateLimit(), rateLimit(), ok()]),
      sleep,
      random: () => 1,
    })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000])
  })

  it('caps the backoff rather than growing without bound', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve())
    const config: ModelConfig = { ...MODEL_CONFIG, backoffBaseMs: 5000, backoffCapMs: 6000 }
    await call({
      transport: scripted([rateLimit(), rateLimit(), ok()]),
      config,
      sleep,
      random: () => 1,
    })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 6000])
  })

  it('scales the wait by the jitter draw', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve())
    await call({ transport: scripted([rateLimit(), ok()]), sleep, random: () => 0.25 })
    expect(sleep).toHaveBeenCalledWith(125)
  })

  it('gives up after the configured number of attempts', async () => {
    const transport = scripted([server(), server(), server(), server()])
    await expect(call({ transport })).rejects.toThrow(/upstream fell over/)
    expect(transport.sent).toHaveLength(MODEL_CONFIG.transientRetries + 1)
  })
})

describe('failures that must not be retried', () => {
  it('does not retry a malformed request', async () => {
    // The branch that matters most, and the one a happy-path integration test
    // never reaches: re-sending a 4xx produces the same 4xx at the same cost.
    const transport = scripted([new TransportError('client', 'bad request', 400)])
    await expect(call({ transport })).rejects.toThrow(/bad request/)
    expect(transport.sent).toHaveLength(1)
  })

  it('does not retry a refusal', async () => {
    // A refusal is a decision, not a fault. Asking again spends budget to be
    // told the same thing.
    const transport = scripted([new TransportError('refusal', 'the model declined', 200)])
    await expect(call({ transport })).rejects.toThrow(/declined/)
    expect(transport.sent).toHaveLength(1)
  })

  it('does not retry something it cannot classify', async () => {
    // Retrying an unrecognised throw is how a bug becomes a bill.
    const transport = scripted([new TypeError('cannot read properties of undefined')])
    await expect(call({ transport })).rejects.toThrow(TypeError)
    expect(transport.sent).toHaveLength(1)
  })
})

describe('the token budget', () => {
  it('is checked before dispatch, not tallied after', async () => {
    // A budget that only reports what was spent is an invoice.
    const transport = scripted([ok()], 500)
    const budget = new TokenBudget(100)
    await expect(call({ transport, budget })).rejects.toThrow(BudgetExceededError)
    expect(transport.sent).toHaveLength(0)
  })

  it('counts against the model rather than estimating from characters', async () => {
    const transport = scripted([ok()])
    await call({ transport, budget: new TokenBudget(1000) })
    expect(transport.counted).toHaveLength(1)
  })

  it('spends down across calls', async () => {
    const budget = new TokenBudget(250)
    await call({ transport: scripted([ok()]), budget })
    expect(budget.spent).toBe(100)
    expect(budget.remaining).toBe(150)
  })

  it('re-checks before a schema retry, since the corrected prompt is longer', async () => {
    // Checking once against the first attempt is not a budget.
    const transport = scripted([ok({}), ok()], 60)
    const budget = new TokenBudget(100)
    await expect(call({ transport, budget })).rejects.toThrow(BudgetExceededError)
    expect(transport.sent).toHaveLength(1)
  })

  it('names both the request and what was left', async () => {
    const budget = new TokenBudget(30)
    const error = await call({ transport: scripted([ok()]), budget }).catch((e: unknown) => e)
    expect((error as Error).message).toContain('100 input tokens')
    expect((error as Error).message).toContain('30 remain')
  })
})

describe('MODEL_CONFIG', () => {
  it('pins a model rather than tracking whatever is newest', () => {
    // A model change moves every number in eval/report.md, so it happens in a
    // reviewable commit with an eval run attached — never via a dependency bump.
    expect(MODEL_CONFIG.model).toBe('claude-opus-5')
  })

  it('leaves room for thinking and the answer together', () => {
    // max_tokens caps both on this model tier; a tight budget truncates the
    // answer the model was deliberating about.
    expect(MODEL_CONFIG.maxTokens).toBeGreaterThanOrEqual(4000)
  })

  it('sends no sampling parameters, which this model rejects', async () => {
    const transport = scripted([ok()])
    await call({ transport })
    expect(transport.sent[0]).not.toHaveProperty('temperature')
    expect(transport.sent[0]).not.toHaveProperty('topP')
  })
})
