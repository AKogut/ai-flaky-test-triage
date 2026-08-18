import type { Classification } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { SchemaViolationError } from './model-client.js'
import type { ModelRequest, ModelResponse, Transport } from './transport.js'
import {
  rootCause,
  rootCauseOptions,
  shouldInvestigate,
  verifyFiles,
  type RootCauseInput,
} from './root-cause.js'

/**
 * The root-cause agent, which is mostly a study in what it refuses to do.
 *
 * A classification is scored against a labelled dataset. A hypothesis is scored
 * against nothing, and it is read by somebody deciding where to spend an hour —
 * so the assertions that matter here are the ones about not running, and about
 * not passing on a path the model invented.
 */

const VALID = {
  hypothesis:
    'The reconciliation applies whichever response arrives last, so a slower first request overwrites the newer state.',
  implicatedFiles: ['app/board.ts'],
  implicatedSymbols: ['reconcile'],
  mechanism: 'race',
  confidence: 0.8,
}

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

const classification = (over: Partial<Classification> = {}): Classification => ({
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.82,
  reasoning: 'the diff changes the reducer the failing assertion reads',
  evidence: ['expected 3 to equal 4'],
  ...over,
})

const input = (over: Partial<RootCauseInput> = {}): RootCauseInput => ({
  historyAvailable: true,
  classification: classification(),
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

const deps = (
  transport: Transport,
  exists: (path: string) => boolean = () => true,
): Parameters<typeof rootCause>[1] => ({
  transport,
  exists,
  system: 'You explain why a test failed.',
  promptVersion: 'root-cause.v1',
})

describe('whether to investigate at all', () => {
  /**
   * `null` is not "use a default". The point of a threshold is that the verdict
   * being elaborated on has been *shown* to be right most of the time; a guessed
   * one leaves that sentence with nothing behind it.
   */
  it('does not run without a calibrated threshold, however confident the verdict', () => {
    expect(shouldInvestigate({ owner: 'app_code', confidence: 0.99 }, null)).toBe(false)
  })

  it('runs on application code at or above the threshold', () => {
    expect(shouldInvestigate({ owner: 'app_code', confidence: 0.7 }, 0.7)).toBe(true)
    expect(shouldInvestigate({ owner: 'app_code', confidence: 0.9 }, 0.7)).toBe(true)
  })

  it('does not run below it', () => {
    expect(shouldInvestigate({ owner: 'app_code', confidence: 0.69 }, 0.7)).toBe(false)
  })

  /** A test-code or environment failure has no application root cause to find. */
  it.each(['test_code', 'environment'] as const)(
    'does not run for %s at any confidence',
    (owner) => {
      expect(shouldInvestigate({ owner, confidence: 1 }, 0.1)).toBe(false)
    },
  )
})

describe('the call it makes', () => {
  it('returns a schema-validated hypothesis', async () => {
    const result = await rootCause(input(), deps(stub()))
    expect(result.rootCause).toMatchObject({ mechanism: 'race', confidence: 0.8 })
  })

  it('sends the prompt as the system message and the evidence as the user one', async () => {
    const transport = stub()
    await rootCause(input(), deps(transport))
    expect(transport.sent[0]?.system).toBe('You explain why a test failed.')
    expect(transport.sent[0]?.prompt).toContain('expected 3 to equal 4')
  })

  /**
   * Above the fence, with the other numbers the pipeline computed. A verdict
   * rendered as evidence would sit in the same block as strings a contributor
   * controls, which is where a forged one would go.
   */
  it('states the verdict it is elaborating on, as a measured signal', async () => {
    const transport = stub()
    await rootCause(input(), deps(transport))
    const prompt = transport.sent[0]?.prompt ?? ''
    expect(prompt).toContain('THE VERDICT YOU ARE ELABORATING ON')
    expect(prompt).toContain('owner: app_code')
    expect(prompt).toContain('confidence: 0.82')
    expect(prompt.indexOf('END UNTRUSTED DATA')).toBeLessThan(
      prompt.indexOf('THE VERDICT YOU ARE ELABORATING ON'),
    )
  })

  it('names the call site after the test, so a failure says which one', () => {
    const { options } = rootCauseOptions(input(), {
      system: 's',
      promptVersion: 'root-cause.v1',
    })
    expect(options.label).toBe('root-cause app/board.spec.ts›renders')
    expect(options.schemaName).toBe('root_cause')
  })

  /**
   * The same split `triageOptions` exists for: the cassette staleness check
   * needs the exact request without making it, and a check built on a second
   * copy of the assembly passes about requests nobody makes.
   */
  it('assembles the same request whether or not it is sent', async () => {
    const transport = stub()
    await rootCause(input(), deps(transport))
    const { options } = rootCauseOptions(input(), {
      system: 'You explain why a test failed.',
      promptVersion: 'root-cause.v1',
    })
    expect(transport.sent[0]?.prompt).toBe(options.prompt)
  })
})

describe('paths the checkout does not have', () => {
  /**
   * A model that names `src/board/reconcile.ts` because the name fits is
   * producing a finding-shaped guess, and a reader cannot tell it from a real
   * one.
   */
  it('drops them from the hypothesis', async () => {
    const result = await rootCause(
      input(),
      deps(
        stub({ ...VALID, implicatedFiles: ['app/board.ts', 'src/imagined.ts'] }),
        (path) => path === 'app/board.ts',
      ),
    )
    expect(result.rootCause.implicatedFiles).toEqual(['app/board.ts'])
  })

  /** Recorded rather than swallowed: the rate is the thing worth knowing. */
  it('records what it dropped', async () => {
    const result = await rootCause(
      input(),
      deps(
        stub({ ...VALID, implicatedFiles: ['app/board.ts', 'src/imagined.ts'] }),
        (path) => path === 'app/board.ts',
      ),
    )
    expect(result.droppedFiles).toEqual(['src/imagined.ts'])
  })

  it('keeps the hypothesis when every path was invented, and says so', async () => {
    const result = await rootCause(
      input(),
      deps(stub({ ...VALID, implicatedFiles: ['nope.ts'] }), () => false),
    )
    expect(result.rootCause.implicatedFiles).toEqual([])
    expect(result.droppedFiles).toEqual(['nope.ts'])
    expect(result.rootCause.hypothesis).toContain('reconciliation')
  })

  it('reports nothing dropped when the model stayed honest', async () => {
    expect((await rootCause(input(), deps(stub()))).droppedFiles).toEqual([])
  })

  it('splits a list without needing a model call', () => {
    expect(verifyFiles(['a', 'b', 'c'], (p) => p !== 'b')).toEqual({
      kept: ['a', 'c'],
      dropped: ['b'],
    })
  })
})

describe('the alternative a low confidence requires', () => {
  /**
   * Enforced by the schema rather than by the prompt, which is the difference
   * between a rule and a request. A single confident-sounding explanation is the
   * most dangerous thing this system emits; below 0.7 the runner-up has to be
   * stated.
   */
  it('rejects a hypothesis below 0.7 with no alternative', async () => {
    await expect(rootCause(input(), deps(stub({ ...VALID, confidence: 0.5 })))).rejects.toThrow(
      SchemaViolationError,
    )
  })

  it('accepts the same hypothesis once the alternative is there', async () => {
    const result = await rootCause(
      input(),
      deps(
        stub({
          ...VALID,
          confidence: 0.5,
          alternativeHypothesis: 'The spec closes the editor before the save settles.',
        }),
      ),
    )
    expect(result.rootCause.alternativeHypothesis).toContain('closes the editor')
  })

  it('does not demand one at or above 0.7', async () => {
    const result = await rootCause(input(), deps(stub({ ...VALID, confidence: 0.7 })))
    expect(result.rootCause.alternativeHypothesis).toBeUndefined()
  })
})
