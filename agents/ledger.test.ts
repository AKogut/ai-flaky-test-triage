import { describe, expect, it } from 'vitest'
import {
  formatSpend,
  NO_SPEND,
  spendLine,
  spendOf,
  UsageLedger,
  type Dispatch,
  type DispatchResult,
} from './ledger.js'

/**
 * The one list every token count in the project is read from.
 *
 * What is pinned here is the rule a reader relies on: the total is what was
 * billed, whatever became of each response, and the part that bought nothing is
 * named beside it rather than taken out of it. `model-client.test.ts` checks
 * that every dispatch reaches the list; `run.test.ts` that the footer, the
 * spans and the console all print what it holds.
 */

const answered = (over: Partial<Dispatch> = {}): Dispatch => ({
  promptVersion: 'triage.v1',
  requestModel: 'claude-opus-5',
  model: 'claude-opus-5',
  result: 'answered',
  inputTokens: 1_000,
  outputTokens: 200,
  ...over,
})

/** No response arrived, so there is no model to price and nothing was billed. */
const unanswered: Dispatch = {
  promptVersion: 'triage.v1',
  requestModel: 'claude-opus-5',
  result: 'unanswered',
  inputTokens: 0,
  outputTokens: 0,
}

describe('a total', () => {
  it('is what the API billed, priced at the model that answered', () => {
    // 1,000 in at $5/M and 200 out at $25/M.
    expect(spendOf([answered()])).toEqual({
      usd: 0.01,
      inputTokens: 1_000,
      outputTokens: 200,
      unpricedModels: [],
      dispatches: 1,
      unused: { usd: 0, inputTokens: 0, outputTokens: 0, unpricedModels: [] },
    })
  })

  it.each<DispatchResult>(['rejected', 'refused', 'unreadable'])(
    'counts a %s response in the total and in what bought nothing',
    (result) => {
      const spend = spendOf([answered(), answered({ result })])
      expect(spend.usd).toBeCloseTo(0.02, 10)
      expect(spend.unused.usd).toBeCloseTo(0.01, 10)
      expect(spend.unused.inputTokens).toBe(1_000)
    },
  )

  it('counts a dispatch that got no response, and bills it nothing', () => {
    const spend = spendOf([unanswered, answered()])
    expect(spend.dispatches).toBe(2)
    expect(spend.inputTokens).toBe(1_000)
    expect(spend.unpricedModels).toEqual([])
  })

  /** A call that fell back is two models at two prices, and each response is priced as its own. */
  it('prices each response at its own model', () => {
    const spend = spendOf([
      answered({ result: 'refused' }),
      answered({ model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 0 }),
    ])
    expect(spend.usd).toBeCloseTo(0.01 + 1, 10)
  })

  /** A cost of zero for an unrecognised model is the kind of wrong number that reads as good news. */
  it('names a model it cannot price rather than costing it at zero', () => {
    const spend = spendOf([answered(), answered({ model: 'claude-unreleased-9' })])
    expect(spend.usd).toBeCloseTo(0.01, 10)
    expect(spend.inputTokens).toBe(2_000)
    expect(spend.unpricedModels).toEqual(['claude-unreleased-9'])
  })

  it('is zero everywhere when nothing was dispatched', () => {
    expect(NO_SPEND).toEqual(spendOf([]))
    expect(NO_SPEND).toMatchObject({ usd: 0, inputTokens: 0, outputTokens: 0, dispatches: 0 })
  })
})

describe('the ledger', () => {
  it('keeps every dispatch once, in the order it was written', () => {
    const ledger = new UsageLedger()
    ledger.record(answered({ result: 'rejected' }))
    ledger.record(unanswered)
    ledger.record(answered())
    expect(ledger.dispatches.map((d) => d.result)).toEqual(['rejected', 'unanswered', 'answered'])
    expect(ledger.spend).toEqual(spendOf(ledger.dispatches))
  })

  /** What the budget is charged, so it is the billed figure and nothing else. */
  it('keeps a running count of billed input tokens', () => {
    const ledger = new UsageLedger()
    ledger.record(answered({ inputTokens: 700 }))
    ledger.record(unanswered)
    ledger.record(answered({ result: 'refused', inputTokens: 50 }))
    expect(ledger.inputTokens).toBe(750)
  })

  /** Append-only means a caller cannot edit an entry after it has been counted. */
  it('copies what it is given', () => {
    const ledger = new UsageLedger()
    const entry = answered()
    ledger.record(entry)
    entry.inputTokens = 9_999_999
    expect(ledger.spend.inputTokens).toBe(1_000)
  })
})

describe('the words a cost is printed in', () => {
  it('is the dollar figure alone when every response was used and priced', () => {
    expect(formatSpend(spendOf([answered()]))).toBe('$0.0100')
  })

  it('names what bought nothing beside the total, not instead of it', () => {
    expect(formatSpend(spendOf([answered({ result: 'rejected' }), answered()]))).toBe(
      '$0.0200, $0.0100 of it on responses the run could not use',
    )
  })

  it('names a model it could not price', () => {
    expect(formatSpend(spendOf([answered({ model: 'claude-unreleased-9' })]))).toBe(
      '$0.0000, plus calls to `claude-unreleased-9`, which agents/pricing.ts has no price for',
    )
  })

  it('says a run with no model call cost nothing, in those words', () => {
    expect(spendLine(NO_SPEND)).toBe('  cost: no model call, $0.0000')
  })

  it('gives the console the tokens, the requests and the same dollar figure', () => {
    expect(spendLine(spendOf([unanswered, answered()]))).toBe(
      '  cost: 1000 input + 200 output tokens over 2 request(s), $0.0100',
    )
  })
})
