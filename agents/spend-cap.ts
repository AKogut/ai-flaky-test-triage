import { cassetteKey } from './cassettes.js'
import { formatUsd, priceTokens } from './pricing.js'
import type { ModelRequest, ModelResponse, Transport } from './transport.js'

/**
 * A ceiling in dollars, for the runs that cost them.
 *
 * The token budget bounds how much a run may read; it says nothing about what
 * that costs, and a run's output — thinking included, on this model tier — is
 * priced five times its input. A cap a person can set from the invoice they are
 * prepared to receive is the one that has to be in dollars.
 *
 * **It admits on the worst case.** Every request is priced before it is sent at
 * its counted input plus `max_tokens` of output, the most it can be billed, and
 * refused if that would take what has been spent past the cap. The expected
 * cost would admit more, and would be a cap that holds on average. A batch is
 * admitted the same way, as a whole, because once it is submitted nothing can
 * stop its requests from running.
 *
 * **What has been spent is read from the ledger** — the caller says how, so a
 * batched run can add the batch it already paid for to the synchronous requests
 * it is still making. It is never a second tally.
 *
 * A request to a model `agents/pricing.ts` has no price for is refused: a cap
 * that cannot price a request cannot bound it.
 */

export class SpendCapExceededError extends Error {
  constructor(
    /** What was refused, in words: "a batch of 160 requests", "a request to claude-opus-5-5". */
    readonly what: string,
    /** Its worst case, or null when the model has no price. */
    readonly worstUsd: number | null,
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(
      worstUsd === null
        ? `${what} is to a model agents/pricing.ts has no price for, so nothing bounds what it costs; ` +
            `the ${formatUsd(capUsd)} cap refuses it`
        : `${what} could cost up to ${formatUsd(worstUsd)}, and ${formatUsd(spentUsd)} of the ` +
            `${formatUsd(capUsd)} cap is already spent or committed. Nothing was sent.`,
    )
    this.name = 'SpendCapExceededError'
  }
}

export class SpendCap {
  private held = 0

  constructor(
    readonly capUsd: number,
    /** Dollars already billed or committed, read from the run's ledger. */
    private readonly spent: () => number,
  ) {}

  /** Billed or committed, plus what admitted requests still in flight could cost. */
  get committed(): number {
    return this.spent() + this.held
  }

  get remaining(): number {
    return Math.max(0, this.capUsd - this.committed)
  }

  /**
   * Admit something at its worst case, or throw. Returns the release, to call
   * once what it spent is visible to `spent` — calling it twice releases once.
   */
  admit(what: string, worstUsd: number | null): () => void {
    const committed = this.committed
    if (worstUsd === null || committed + worstUsd > this.capUsd) {
      throw new SpendCapExceededError(what, worstUsd, committed, this.capUsd)
    }
    this.held += worstUsd
    let released = false
    return () => {
      if (released) return
      released = true
      this.held -= worstUsd
    }
  }
}

/** The most a request can be billed: its counted input, and every output token it may produce. */
export const worstCaseUsd = (
  request: Pick<ModelRequest, 'model' | 'maxTokens'>,
  inputTokens: number,
): number | null => priceTokens(request.model, inputTokens, request.maxTokens, 'standard')

/**
 * The cap, around the one transport that spends money.
 *
 * A decorator on the live transport rather than a check inside `callModel`,
 * because only this layer knows a request is about to be paid for. Under it
 * nothing is cached or replayed; above it, in a batched run, most requests are
 * answered from a batch that was capped when it was submitted, and pricing
 * those again here would refuse a correction on money already spent twice.
 *
 * It reuses the count `callModel` makes before each dispatch rather than
 * counting again: the key is the cassette key, so a corrected prompt is a new
 * entry and is counted on its own.
 *
 * The hold is released when the response returns. `callModel` writes it to the
 * ledger before it can dispatch again, which is what the evaluation needs: it
 * scores fixtures one at a time. A caller that dispatched concurrently through
 * one cap would see, between the two, a response neither held nor recorded.
 */
export class CappedTransport implements Transport {
  private readonly counted = new Map<string, number>()

  constructor(
    private readonly inner: Transport,
    private readonly cap: SpendCap,
  ) {}

  async countInputTokens(request: ModelRequest): Promise<number> {
    const tokens = await this.inner.countInputTokens(request)
    this.counted.set(cassetteKey(request), tokens)
    return tokens
  }

  async send(request: ModelRequest): Promise<ModelResponse> {
    const tokens = this.counted.get(cassetteKey(request)) ?? (await this.countInputTokens(request))
    const release = this.cap.admit(`a request to ${request.model}`, worstCaseUsd(request, tokens))
    try {
      return await this.inner.send(request)
    } finally {
      release()
    }
  }
}
