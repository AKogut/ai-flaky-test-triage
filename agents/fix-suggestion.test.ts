import type { Classification, RootCause } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { SchemaViolationError } from './model-client.js'
import type { ModelRequest, ModelResponse, Transport } from './transport.js'
import { fixSuggestionOptions, suggestFix, type FixSuggestionInput } from './fix-suggestion.js'

/**
 * The fix-suggestion agent, whose strongest property is what it cannot do.
 *
 * There is no code path from this module's output to a filesystem write — not a
 * policy of declining to apply patches, which is a thing somebody changes, but
 * the absence of any function that could. #69 asserts the whole-pipeline version
 * of that claim; what is checkable here is that the module exports nothing that
 * writes, and that the schema refuses a suggestion with no stated risks.
 */

const VALID = {
  summary:
    'Serialise the reconciliation so a slower earlier response cannot overwrite newer state.',
  approach:
    'Tag each fetch with a monotonically increasing request id and discard any response whose id is not the newest. A mutex would also work and would block the interface while it held.',
  patch: '@@\n-  setRows(response.rows)\n+  if (id === latest.current) setRows(response.rows)\n',
  risks: ['Callers that relied on every response being applied will now see some discarded'],
  testGap: 'Nothing exercises two overlapping reorders, which is the only way to reach this.',
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

const classification: Classification = {
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.82,
  reasoning: 'the diff changes the reducer the failing assertion reads',
  evidence: ['expected 3 to equal 4'],
}

const cause = (over: Partial<RootCause> = {}): RootCause => ({
  hypothesis: 'The reconciliation applies whichever response arrives last.',
  implicatedFiles: ['app/board.ts'],
  implicatedSymbols: ['reconcile'],
  mechanism: 'race',
  confidence: 0.8,
  ...over,
})

const input = (over: Partial<FixSuggestionInput> = {}): FixSuggestionInput => ({
  historyAvailable: true,
  classification,
  rootCause: cause(),
  subject: {
    result: {
      testId: 'app/board.spec.ts\u203arenders',
      title: 'board \u203a renders the card',
      file: 'app/board.spec.ts',
      status: 'failed',
      attempts: 2,
      flakyWithinRun: false,
      durationMs: 1234,
      annotations: [],
      error: { message: 'expected 3 to equal 4', stack: '    at app/board.ts:12:4' },
    },
    signal: {
      testId: 'app/board.spec.ts\u203arenders',
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

const deps = (transport: Transport): Parameters<typeof suggestFix>[1] => ({
  transport,
  system: 'You propose how to fix an application defect.',
  promptVersion: 'fix-suggestion.v1',
})

describe('the suggestion it returns', () => {
  it('is schema-validated', async () => {
    const result = await suggestFix(input(), deps(stub()))
    expect(result.suggestion.summary).toContain('Serialise')
    expect(result.suggestion.risks).toHaveLength(1)
  })

  /**
   * Required by the schema, not asked for by the prompt. A fix without stated
   * risks reads as more authoritative than it has earned, and a prompt can be
   * declined.
   */
  it('is refused when it states no risks', async () => {
    await expect(suggestFix(input(), deps(stub({ ...VALID, risks: [] })))).rejects.toThrow(
      SchemaViolationError,
    )
  })

  it('is refused when it invents a field', async () => {
    await expect(
      suggestFix(input(), deps(stub({ ...VALID, applyAutomatically: true }))),
    ).rejects.toThrow(SchemaViolationError)
  })

  /** Illustrative only. Omitting it is a valid answer; inventing context lines is not. */
  it('accepts a suggestion with no patch at all', async () => {
    const { patch: _patch, ...withoutPatch } = VALID
    const result = await suggestFix(input(), deps(stub(withoutPatch)))
    expect(result.suggestion.patch).toBeUndefined()
  })

  it('carries the test gap, which is often the most useful line', async () => {
    const result = await suggestFix(input(), deps(stub()))
    expect(result.suggestion.testGap).toContain('overlapping reorders')
  })
})

describe('what it is told', () => {
  it('states the verdict and the hypothesis above the fence', async () => {
    const transport = stub()
    await suggestFix(input(), deps(transport))
    const prompt = transport.sent[0]?.prompt ?? ''
    expect(prompt).toContain('WHAT THIS PIPELINE HAS CONCLUDED SO FAR')
    expect(prompt).toContain('mechanism: race')
    expect(prompt.indexOf('END UNTRUSTED DATA')).toBeLessThan(
      prompt.indexOf('WHAT THIS PIPELINE HAS CONCLUDED SO FAR'),
    )
  })

  /**
   * Said out loud because it is not a measurement. A suggestion built on a wrong
   * hypothesis should be readable as such afterwards.
   */
  it('says the hypothesis came from a model rather than from the pipeline', async () => {
    const transport = stub()
    await suggestFix(input(), deps(transport))
    expect(transport.sent[0]?.prompt).toContain("another model's, not a measurement")
  })

  it('passes on the stated alternative when there is one', async () => {
    const transport = stub()
    await suggestFix(
      input({
        rootCause: cause({ confidence: 0.5, alternativeHypothesis: 'The spec closes too early.' }),
      }),
      deps(transport),
    )
    expect(transport.sent[0]?.prompt).toContain('stated alternative: The spec closes too early.')
  })

  it('says none rather than printing an empty list of files', async () => {
    const transport = stub()
    await suggestFix(
      input({ rootCause: cause({ implicatedFiles: [], implicatedSymbols: [] }) }),
      deps(transport),
    )
    expect(transport.sent[0]?.prompt).toContain('implicated files (verified to exist): none')
  })

  it('assembles the same request whether or not it is sent', async () => {
    const transport = stub()
    await suggestFix(input(), deps(transport))
    const { options } = fixSuggestionOptions(input(), {
      system: 'You propose how to fix an application defect.',
      promptVersion: 'fix-suggestion.v1',
    })
    expect(transport.sent[0]?.prompt).toBe(options.prompt)
    expect(options.schemaName).toBe('fix_suggestion')
    expect(options.label).toBe('fix-suggestion app/board.spec.ts\u203arenders')
  })
})

describe('the guardrail', () => {
  /**
   * Structural, not procedural. The module has no function that writes, so
   * "the orchestrator never applies patches" is not a policy anyone can change
   * their mind about.
   */
  it('exports nothing that could write a file', async () => {
    const module: Record<string, unknown> = await import('./fix-suggestion.js')
    expect(Object.keys(module).sort()).toEqual(['fixSuggestionOptions', 'suggestFix'])
  })

  it('treats the patch as a string and never as a path', async () => {
    const result = await suggestFix(input(), deps(stub()))
    expect(typeof result.suggestion.patch).toBe('string')
  })
})
