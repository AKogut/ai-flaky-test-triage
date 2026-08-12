import type { ClassificationInput } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import {
  BudgetExceededError,
  MODEL_CONFIG,
  SchemaViolationError,
  TokenBudget,
  type CallTelemetry,
} from './model-client.js'
import {
  TransportError,
  type ModelRequest,
  type ModelResponse,
  type Transport,
} from './transport.js'
import { triage, unverified } from './triage.js'

const VALID = {
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.6,
  reasoning: 'the diff changes the reducer the failing assertion reads',
  evidence: ['expected 3 to equal 4'],
}

/** Records what the agent sent and replies with whatever the test scripted. */
function stub(reply: unknown = VALID): Transport & { sent: ModelRequest[] } {
  const sent: ModelRequest[] = []
  return {
    sent,
    countInputTokens: () => Promise.resolve(120),
    send: (request): Promise<ModelResponse> => {
      sent.push(request)
      if (reply instanceof Error) return Promise.reject(reply)
      return Promise.resolve({
        raw: reply,
        stopReason: 'end_turn',
        model: 'claude-opus-5',
        usage: { inputTokens: 120, outputTokens: 40 },
      })
    },
  }
}

const input = (over: Partial<ClassificationInput> = {}): ClassificationInput => ({
  historyAvailable: true,
  subject: {
    result: {
      testId: 'app/board.spec.ts›renders',
      title: 'board › renders the card',
      file: 'app/board.spec.ts',
      status: 'failed',
      attempts: 2,
      flakyWithinRun: false,
      durationMs: 1234,
      annotations: [],
      error: { message: 'expected 3 to equal 4', stack: '    at app/board.ts:12:4' },
    },
    signal: {
      testId: 'app/board.spec.ts›renders',
      flakinessScore: 0.25,
      consecutiveFailures: 3,
      totalRuns: 40,
      firstSeenAt: '2026-04-02T07:31:19.000Z',
      lastPassedAt: '2026-08-06T11:14:02.000Z',
      statusHistory: 'PPPFFF',
      isNew: false,
    },
  },
  ...over,
})

const deps = (transport: Transport): Parameters<typeof triage>[1] => ({
  transport,
  system: 'You classify test failures.',
  promptVersion: 'triage.v1',
})

describe('the triage agent', () => {
  it('returns a schema-validated classification', async () => {
    const result = await triage(input(), deps(stub()))
    expect(result.classification).toEqual(VALID)
  })

  it('sends the assembled context as the user message, and the prompt as the system one', async () => {
    const transport = stub()
    await triage(input(), deps(transport))

    const request = transport.sent[0]
    expect(request?.system).toBe('You classify test failures.')
    expect(request?.prompt).toContain('MEASURED SIGNALS')
    expect(request?.prompt).toContain('[BEGIN UNTRUSTED DATA: errorMessage]')
  })

  it('records the prompt version, which is what makes a number attributable', async () => {
    const transport = stub()
    const result = await triage(input(), deps(transport))
    expect(transport.sent[0]?.promptVersion).toBe('triage.v1')
    expect(result.telemetry.promptVersion).toBe('triage.v1')
  })

  it('names the test in the label, so an error says which one failed', async () => {
    const result = await triage(input(), deps(stub()))
    expect(result.telemetry.label).toContain('app/board.spec.ts›renders')
  })

  it('returns what the model was shown, so a wrong answer can be read against it', async () => {
    const result = await triage(input(), deps(stub()))
    expect(result.bundle.facts.length).toBeGreaterThan(0)
  })

  it('passes ablation options through to the assembler', async () => {
    const transport = stub()
    await triage(input(), { ...deps(transport), context: { include: { errorStack: false } } })
    expect(transport.sent[0]?.prompt).toContain('Withheld from this run on purpose')
  })

  /**
   * The two axes are orthogonal by construction and the agent does nothing to
   * couple them. The failure this guards against is a well-meant "if it is
   * test_code it is probably intermittent" appearing here later — the collapse
   * the eval reports per axis exists to detect, which it cannot do if the code
   * enforces it.
   */
  it('returns each axis exactly as the model gave it', async () => {
    const odd = { ...VALID, owner: 'environment', determinism: 'deterministic' }
    const result = await triage(input(), deps(stub(odd)))
    expect(result.classification.owner).toBe('environment')
    expect(result.classification.determinism).toBe('deterministic')
  })
})

describe('what the caller can override', () => {
  it('takes a model configuration', async () => {
    const transport = stub()
    await triage(input(), {
      ...deps(transport),
      config: { ...MODEL_CONFIG, model: 'claude-haiku-4-5', maxTokens: 1000 },
    })
    expect(transport.sent[0]?.model).toBe('claude-haiku-4-5')
    expect(transport.sent[0]?.maxTokens).toBe(1000)
  })

  it('reports telemetry to a caller that asked for it', async () => {
    const seen: CallTelemetry[] = []
    await triage(input(), { ...deps(stub()), onTelemetry: (t) => seen.push(t) })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.promptVersion).toBe('triage.v1')
  })
})

describe('typed failures', () => {
  it('surfaces a schema violation as a typed error', async () => {
    const nonsense = { owner: 'whatever', determinism: 'sometimes' }
    await expect(triage(input(), deps(stub(nonsense)))).rejects.toBeInstanceOf(SchemaViolationError)
  })

  it('surfaces a refusal without retrying it', async () => {
    const transport = stub(new TransportError('refusal', 'the model declined'))
    await expect(triage(input(), deps(transport))).rejects.toBeInstanceOf(TransportError)
    expect(transport.sent).toHaveLength(1)
  })

  it('stops on the budget rather than spending past it', async () => {
    const budget = new TokenBudget(10)
    await expect(triage(input(), { ...deps(stub()), budget })).rejects.toBeInstanceOf(
      BudgetExceededError,
    )
  })
})

// ---------------------------------------------------------------------------
// Evidence verification
// ---------------------------------------------------------------------------

/**
 * A fabricated quotation is the most damaging thing this agent can produce,
 * because it reads exactly like the ones that are real. The number has to mean
 * "invented" rather than "reformatted", or nobody will act on it.
 */
describe('verifying quoted evidence', () => {
  const shown =
    'MEASURED SIGNALS\n\n- status: failed\n\nexpected 3\nto equal 4\n    at board.ts:1:1'

  it('accepts a quotation that is in the input', () => {
    expect(unverified(['at board.ts:1:1'], shown)).toEqual([])
  })

  it('accepts one the model re-wrapped', () => {
    expect(unverified(['expected 3 to equal 4'], shown)).toEqual([])
  })

  it.each(['...', '…'])('accepts an elision written with %s', (dots) => {
    expect(unverified([`expected 3 ${dots} board.ts:1:1`], shown)).toEqual([])
  })

  it('requires the elided segments in order', () => {
    expect(unverified(['board.ts:1:1 ... expected 3'], shown)).toHaveLength(1)
  })

  it('reports a quotation that is not there', () => {
    expect(unverified(['expected 7 to equal 9'], shown)).toEqual(['expected 7 to equal 9'])
  })

  it('reports an empty quotation rather than accepting it', () => {
    expect(unverified(['   '], shown)).toEqual(['   '])
  })

  it('reports only the invented ones', () => {
    expect(unverified(['expected 3', 'invented entirely'], shown)).toEqual(['invented entirely'])
  })

  it('runs on every classification, not on request', async () => {
    const fabricating = { ...VALID, evidence: ['a line nobody wrote'] }
    const result = await triage(input(), deps(stub(fabricating)))
    expect(result.unverifiedEvidence).toEqual(['a line nobody wrote'])
  })

  /**
   * Reported rather than rejected: throwing away an otherwise usable
   * classification would hide the rate, and the rate is the thing worth knowing.
   */
  it('does not reject a classification for it', async () => {
    const fabricating = { ...VALID, evidence: ['a line nobody wrote'] }
    const result = await triage(input(), deps(stub(fabricating)))
    expect(result.classification.owner).toBe('app_code')
  })
})
