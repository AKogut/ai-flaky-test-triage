/**
 * What a run cost.
 *
 * A number the report has to carry, because "does the model earn its cost" is
 * the question the whole project is built to answer, and it cannot be answered
 * against an accuracy figure alone.
 *
 * Prices are per million tokens, in US dollars, as published for the first-party
 * Anthropic API. They are a **copy of an external fact**, which is the
 * uncomfortable part: nothing here can detect that a price changed, so the table
 * carries the date it was read and `unknownModel` is reported rather than
 * silently costed at zero. A cost of zero for an unrecognised model is the kind
 * of wrong number that reads as good news.
 */

export interface Price {
  inputPerMillion: number
  outputPerMillion: number
}

/** Read from the published pricing on 2026-08-12. */
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
}

export interface Usage {
  model: string
  inputTokens: number
  outputTokens: number
}

export interface Cost {
  usd: number
  inputTokens: number
  outputTokens: number
  /** Models with no published price here, so an unpriced run reads as unpriced. */
  unpricedModels: string[]
}

export function cost(usage: readonly Usage[]): Cost {
  const unpriced = new Set<string>()
  let usd = 0
  let inputTokens = 0
  let outputTokens = 0

  for (const call of usage) {
    inputTokens += call.inputTokens
    outputTokens += call.outputTokens

    const price = PRICES[call.model]
    if (price === undefined) {
      unpriced.add(call.model)
      continue
    }
    usd +=
      (call.inputTokens * price.inputPerMillion + call.outputTokens * price.outputPerMillion) /
      1_000_000
  }

  return { usd, inputTokens, outputTokens, unpricedModels: [...unpriced].sort() }
}

/**
 * Dollars, rounded to a place that does not imply precision it does not have.
 *
 * Four decimals: a single classification is a fraction of a cent, and rounding
 * to two would print `$0.00` beside a run that cost real money.
 */
export const formatUsd = (usd: number): string => `$${usd.toFixed(4)}`
