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

/**
 * How a response was billed.
 *
 * `batch` is the Message Batches API, which bills every input and output token
 * at half the standard price. Nothing else changes between the two: same model,
 * same request, same answer — so the tier is a fact about the invoice, never
 * about the classifier.
 */
export type Tier = 'standard' | 'batch'

export interface Price {
  inputPerMillion: number
  outputPerMillion: number
  /** The Message Batches price. Copied row by row rather than derived, like the rest. */
  batchInputPerMillion: number
  batchOutputPerMillion: number
}

/**
 * Read from the published pricing on 2026-11-23. The batch columns, and the
 * standard columns again, were checked against the same page on 2026-11-27
 * (https://platform.claude.com/docs/en/about-claude/pricing, "Batch processing":
 * "a 50 percent discount on both input and output tokens").
 *
 * The batch prices are copied from that page's own batch table rather than
 * computed as half of the standard ones. The discount is 50% for every row
 * today, and `pricing.test.ts` says so, but a table that derived them would
 * keep printing half the moment one model's batch price stopped being half.
 *
 * `claude-sonnet-5` was $3/$15 here: its launch price of $2/$10 was announced
 * as introductory, and the increase it was due to revert to was cancelled.
 */
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5-5': {
    inputPerMillion: 4,
    outputPerMillion: 20,
    batchInputPerMillion: 2,
    batchOutputPerMillion: 10,
  },
  'claude-opus-5': {
    inputPerMillion: 5,
    outputPerMillion: 25,
    batchInputPerMillion: 2.5,
    batchOutputPerMillion: 12.5,
  },
  'claude-opus-4-8': {
    inputPerMillion: 5,
    outputPerMillion: 25,
    batchInputPerMillion: 2.5,
    batchOutputPerMillion: 12.5,
  },
  'claude-sonnet-5': {
    inputPerMillion: 2,
    outputPerMillion: 10,
    batchInputPerMillion: 1,
    batchOutputPerMillion: 5,
  },
  'claude-haiku-4-5': {
    inputPerMillion: 1,
    outputPerMillion: 5,
    batchInputPerMillion: 0.5,
    batchOutputPerMillion: 2.5,
  },
}

export interface Usage {
  model: string
  inputTokens: number
  outputTokens: number
  /** Absent is `standard`, so every entry written before batches existed means what it did. */
  tier?: Tier
}

export interface Cost {
  usd: number
  inputTokens: number
  outputTokens: number
  /** Models with no published price here, so an unpriced run reads as unpriced. */
  unpricedModels: string[]
}

/**
 * Dollars for one request's tokens at one tier, or null for a model with no price.
 *
 * Null rather than zero for the reason the module comment gives. It is also what
 * the spending cap and the estimate price a request they have not sent yet with,
 * so a cap can never admit a request it has no way to bound.
 */
export function priceTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
  tier: Tier = 'standard',
): number | null {
  const price = PRICES[model]
  if (price === undefined) return null
  const [input, output] =
    tier === 'batch'
      ? [price.batchInputPerMillion, price.batchOutputPerMillion]
      : [price.inputPerMillion, price.outputPerMillion]
  return (inputTokens * input + outputTokens * output) / 1_000_000
}

export function cost(usage: readonly Usage[]): Cost {
  const unpriced = new Set<string>()
  let usd = 0
  let inputTokens = 0
  let outputTokens = 0

  for (const call of usage) {
    inputTokens += call.inputTokens
    outputTokens += call.outputTokens

    const priced = priceTokens(call.model, call.inputTokens, call.outputTokens, call.tier)
    if (priced === null) {
      unpriced.add(call.model)
      continue
    }
    usd += priced
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
