import { describe, expect, it } from 'vitest'
import { cost, formatUsd, PRICES } from './pricing.js'

describe('costing a run', () => {
  it('prices input and output separately, because they are priced separately', () => {
    const { usd } = cost([{ model: 'claude-opus-5', inputTokens: 1_000_000, outputTokens: 0 }])
    expect(usd).toBeCloseTo(5)
    expect(
      cost([{ model: 'claude-opus-5', inputTokens: 0, outputTokens: 1_000_000 }]).usd,
    ).toBeCloseTo(25)
  })

  it('sums across calls', () => {
    const spend = cost([
      { model: 'claude-opus-5', inputTokens: 100, outputTokens: 40 },
      { model: 'claude-opus-5', inputTokens: 100, outputTokens: 40 },
    ])
    expect(spend.inputTokens).toBe(200)
    expect(spend.outputTokens).toBe(80)
    expect(spend.usd).toBeCloseTo(0.003, 6)
  })

  it('costs nothing when nothing was called', () => {
    expect(cost([])).toEqual({ usd: 0, inputTokens: 0, outputTokens: 0, unpricedModels: [] })
  })

  /**
   * A zero for an unrecognised model is the kind of wrong number that reads as
   * good news, so the model is named instead. Nothing here can detect that a
   * published price changed — the table is a copy of an external fact — and this
   * is the one case it can detect.
   */
  it('names a model it has no price for rather than costing it at zero', () => {
    const spend = cost([{ model: 'claude-future-9', inputTokens: 1_000_000, outputTokens: 0 }])
    expect(spend.usd).toBe(0)
    expect(spend.unpricedModels).toEqual(['claude-future-9'])
    expect(spend.inputTokens).toBe(1_000_000)
  })

  it('names each unpriced model once, in a fixed order', () => {
    const spend = cost([
      { model: 'b-model', inputTokens: 1, outputTokens: 1 },
      { model: 'a-model', inputTokens: 1, outputTokens: 1 },
      { model: 'b-model', inputTokens: 1, outputTokens: 1 },
    ])
    expect(spend.unpricedModels).toEqual(['a-model', 'b-model'])
  })

  it('has a price for the model the pipeline pins', () => {
    expect(PRICES['claude-opus-5']).toBeDefined()
  })

  /** Two decimals would print $0.00 beside a run that cost real money. */
  it('formats to four decimals', () => {
    expect(formatUsd(0.00012)).toBe('$0.0001')
    expect(formatUsd(0.00019)).toBe('$0.0002')
    expect(formatUsd(1)).toBe('$1.0000')
  })
})
