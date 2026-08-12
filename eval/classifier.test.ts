import type { ModelRequest, ModelResponse, Transport } from '@sentra/agents'
import { describe, expect, it } from 'vitest'
import { chooseClassifier, DEFAULT_TOKEN_BUDGET, tokenBudget, unreachable } from './classifier.js'
import { listFixtures, loadPayload } from './dataset.js'

const payload = (): ReturnType<typeof loadPayload>['payload'] =>
  loadPayload(listFixtures()[0] ?? '').payload

const REPLY = {
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.5,
  reasoning: 'a reason',
  evidence: ['some quoted line'],
}

function stub(): Transport & { sent: ModelRequest[] } {
  const sent: ModelRequest[] = []
  return {
    sent,
    countInputTokens: () => Promise.resolve(50),
    send: (request): Promise<ModelResponse> => {
      sent.push(request)
      return Promise.resolve({
        raw: REPLY,
        stopReason: 'end_turn',
        model: 'claude-opus-5',
        usage: { inputTokens: 50, outputTokens: 20 },
      })
    },
  }
}

const REPLAY_ENV = { SENTRA_REPLAY: '1' }

describe('the baseline', () => {
  it('classifies without a model or a prompt', async () => {
    const chosen = chooseClassifier('baseline')
    expect(chosen.context).toEqual({ promptVersion: null, mode: null })
    await expect(chosen.classify(payload())).resolves.toHaveProperty('owner')
  })

  /**
   * Null rather than a placeholder. A version written in here would land in
   * `eval/metrics.json`, and `prompts/freeze.ts` would then protect a prompt on
   * behalf of numbers no prompt produced.
   */
  it('records no prompt version, because a heuristic has none', () => {
    expect(chooseClassifier('baseline').context.promptVersion).toBeNull()
  })
})

describe('the agent', () => {
  it('loads the current prompt and reports which one it used', () => {
    const chosen = chooseClassifier('agent', { env: REPLAY_ENV, transport: stub() })
    expect(chosen.context.promptVersion).toMatch(/^triage\.v\d+$/)
    expect(chosen.context.mode).toBe('replay')
  })

  it('sends the assembled prompt through the transport', async () => {
    const transport = stub()
    const chosen = chooseClassifier('agent', { env: REPLAY_ENV, transport })
    await chosen.classify(payload())

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.system).toContain('Labelling rules')
    expect(transport.sent[0]?.prompt).toContain('MEASURED SIGNALS')
  })

  it('returns the same shape the baseline does', async () => {
    const chosen = chooseClassifier('agent', { env: REPLAY_ENV, transport: stub() })
    expect(await chosen.classify(payload())).toEqual(REPLY)
  })

  /**
   * One budget for the run, not one per fixture. A per-call ceiling is not a
   * ceiling on anything: thirty-three fixtures would each stay inside it and the
   * run would spend thirty-three times what was authorised.
   */
  it('shares one token budget across every fixture in the run', async () => {
    const transport = stub()
    const chosen = chooseClassifier('agent', { env: REPLAY_ENV, transport })
    for (const _ of [0, 1, 2]) await chosen.classify(payload())
    expect(transport.sent).toHaveLength(3)
  })

  /**
   * In replay the inner transport is unreachable rather than merely unused. This
   * is the seam where a cassette miss would otherwise become a live request from
   * a run that was supposed to be free — the SDK does not check a key until it
   * sends, so constructing a client there would work.
   */
  it('has no live transport to fall through to in replay mode', async () => {
    const chosen = chooseClassifier('agent', { env: REPLAY_ENV })
    await expect(chosen.classify(payload())).rejects.toThrow(/no cassette for/)
  })
})

/**
 * Called directly, because the whole point of this transport is that nothing
 * calls it. If replay ever did fall through, this is the difference between a
 * loud failure and a silent live request.
 */
describe('the transport replay wraps', () => {
  const request = {} as ModelRequest

  it('throws rather than counting tokens', () => {
    expect(() => unreachable().countInputTokens(request)).toThrow(/reached the network/)
  })

  it('throws rather than sending', () => {
    expect(() => unreachable().send(request)).toThrow(/reached the network/)
  })
})

describe('the token budget', () => {
  it('defaults rather than running unbounded', () => {
    expect(tokenBudget({})).toBe(DEFAULT_TOKEN_BUDGET)
    expect(tokenBudget({ SENTRA_TOKEN_BUDGET: '' })).toBe(DEFAULT_TOKEN_BUDGET)
  })

  it('takes the value from the environment', () => {
    expect(tokenBudget({ SENTRA_TOKEN_BUDGET: '5000' })).toBe(5000)
  })

  it.each(['nonsense', '0', '-5', '1.5'])('refuses "%s" rather than guessing', (raw) => {
    expect(() => tokenBudget({ SENTRA_TOKEN_BUDGET: raw })).toThrow(/positive whole number/)
  })
})
