import { cost, formatUsd, type Cost, type Tier, type Usage } from './pricing.js'

/**
 * Every token a run was billed for, recorded once.
 *
 * Before this existed, four parts of the pipeline each kept their own count and
 * no two agreed. The budget tallied the `count_tokens` figure it reserved; a span
 * summed the responses its call received; the report footer and the evaluation
 * summed successful calls only; and a refusal, which is an HTTP 200 the API bills
 * like any other answer, reached none of them. A run's cost depended on which
 * page you read it from.
 *
 * Now there is one list. `callModel` appends an entry for every dispatch — every
 * `Transport.send` — at the moment its outcome is known, and everything else is a
 * view of that list:
 *
 * - the token budget is charged from it (`TokenBudget.spent`);
 * - a call's span carries the sum of that call's own entries;
 * - the report footer, the console line after a run and `eval/report.md` carry
 *   the sum of all of them.
 *
 * ## The rule
 *
 * **What a reader is shown is what the API billed.** That is every response that
 * arrived with usage on it, whatever became of it next: the ones the schema
 * accepted, the ones it rejected and the run retried, a refusal, and a response
 * with nothing in it to parse. The part that bought nothing the run could use is
 * named beside the total rather than taken out of it, because a footer that
 * leaves out the retries makes a flaky prompt look cheap.
 *
 * A dispatch with no response — a rate limit, a server fault, a malformed
 * request, a cassette miss — is recorded with zero tokens. It happened, so the
 * list says so; the API does not bill a request it turned away. A call the
 * budget refused never reaches the list at all, because nothing was sent. Its
 * span says `budget`.
 *
 * Two costs are still invisible here, and `docs/limitations-and-guardrails.md`
 * says so: the declined hop of a server-side model fallback, which the API
 * reports only inside `usage.iterations`, and a request that timed out after the
 * server had processed it, which reports nothing at all.
 */

/** What became of one dispatch. */
export type DispatchResult =
  /** A response the schema accepted — the only result that bought a verdict. */
  | 'answered'
  /** A response the schema rejected. Billed, and retried with the errors attached. */
  | 'rejected'
  /** The model declined. Billed: a refusal is a 200 with usage on it. */
  | 'refused'
  /** A response with no JSON to read. Billed, and retried as a server fault. */
  | 'unreadable'
  /** No response at all. Nothing billed. */
  | 'unanswered'

export interface Dispatch {
  promptVersion: string
  /** What `MODEL_CONFIG` asked for. */
  requestModel: string
  /** What answered, and so whose price applies. Absent when nothing did. */
  model?: string
  result: DispatchResult
  /** As the API reported them. Zero when no response arrived. */
  inputTokens: number
  outputTokens: number
  /**
   * How the response was billed. Present only for `batch`: an entry without it
   * is standard, which keeps every entry written before batches existed exact.
   */
  tier?: Tier
}

/**
 * A total over some dispatches: the tokens and dollars billed, plus what of
 * that bought nothing.
 *
 * Extends `Cost` rather than wrapping it, so every reader of a total —
 * `usd`, `inputTokens`, `unpricedModels` — reads the billed figure without
 * having to know there is a second one.
 */
export interface Spend extends Cost {
  /** Dispatches recorded. Zero means no model was called at all. */
  dispatches: number
  /** The part of the total spent on responses the run could not use. */
  unused: Cost
  /** Dispatches billed at the Message Batches rate rather than the standard one. */
  batched: number
  /**
   * The same tokens at the standard rate. Equal to `usd` unless something was
   * batched, and then the figure a replay of the same responses reports — a
   * cassette records what the model said, not how the request was paid for.
   */
  atStandardRate: number
}

/** Only a dispatch that got a response is priced; an unanswered one has no model to price. */
const billed = (dispatches: readonly Dispatch[]): Usage[] =>
  dispatches.flatMap((d) =>
    d.model === undefined
      ? []
      : [
          {
            model: d.model,
            inputTokens: d.inputTokens,
            outputTokens: d.outputTokens,
            ...(d.tier !== undefined && { tier: d.tier }),
          },
        ],
  )

/** The total over any set of dispatches. Pure, so a call and a run are summed the same way. */
export function spendOf(dispatches: readonly Dispatch[]): Spend {
  const usage = billed(dispatches)
  return {
    ...cost(usage),
    dispatches: dispatches.length,
    unused: cost(billed(dispatches.filter((d) => d.result !== 'answered'))),
    batched: dispatches.filter((d) => d.tier === 'batch').length,
    atStandardRate: cost(usage.map(({ tier: _tier, ...standard }) => standard)).usd,
  }
}

/** What a run that made no model call spent. */
export const NO_SPEND: Spend = spendOf([])

/**
 * The run's list of dispatches.
 *
 * Append-only. Nothing here is ever corrected after the fact: an entry is
 * written once its outcome is known, and a later retry is a later entry.
 */
export class UsageLedger {
  private readonly recorded: Dispatch[] = []
  private input = 0

  record(dispatch: Dispatch): void {
    this.recorded.push({ ...dispatch })
    this.input += dispatch.inputTokens
  }

  get dispatches(): readonly Dispatch[] {
    return this.recorded
  }

  /** Input tokens billed so far. What the token budget is charged. */
  get inputTokens(): number {
    return this.input
  }

  get spend(): Spend {
    return spendOf(this.recorded)
  }
}

/**
 * The dollar figure, worded the same wherever it is printed.
 *
 * The footer and the console line are read by different people, and the moment
 * they phrase a cost differently somebody files a bug about the difference. The
 * two qualifications are the ones a bare number would hide: money that bought
 * nothing, and a model `pricing.ts` cannot price, whose share is missing from
 * the figure rather than zero.
 */
export function formatSpend(spend: Spend): string {
  const parts = [formatUsd(spend.usd)]
  if (spend.unused.usd > 0) {
    parts.push(`${formatUsd(spend.unused.usd)} of it on responses the run could not use`)
  }
  if (spend.unpricedModels.length > 0) {
    parts.push(
      `plus calls to ${spend.unpricedModels.map((m) => `\`${m}\``).join(', ')}, ` +
        'which agents/pricing.ts has no price for',
    )
  }
  return parts.join(', ')
}

/** The line `agents:analyze` prints after a run. */
export function spendLine(spend: Spend): string {
  if (spend.dispatches === 0) return `  cost: no model call, ${formatUsd(0)}`
  return (
    `  cost: ${String(spend.inputTokens)} input + ${String(spend.outputTokens)} output tokens ` +
    `over ${String(spend.dispatches)} request(s), ${formatSpend(spend)}`
  )
}
