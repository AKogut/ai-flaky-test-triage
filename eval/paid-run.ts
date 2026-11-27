import {
  AnthropicTransport,
  BatchResultsTransport,
  CappedTransport,
  CassetteTransport,
  MODEL_CONFIG,
  SpendCap,
  UsageLedger,
  billedUsd,
  buildRequest,
  collectBatch,
  fileStore,
  formatUsd,
  listCassettes,
  priceTokens,
  resolveMode,
  spendOf,
  triageOptions,
  withTransientRetry,
  type BatchOutcome,
  type BatchTransport,
  type Cassette,
  type ModelRequest,
  type PlannedRequest,
  type StateStore,
  type Tier,
  type Transport,
} from '@sentra/agents'
import { CURRENT_PROMPT, loadPrompt } from '@sentra/prompts'
import { tokenBudget } from './classifier.js'
import { listFixtures, loadPayload } from './dataset.js'
import type { Options } from './run-eval.js'
import { inSlice } from './slices.js'
import { contextFor } from './variants.js'

/**
 * The three things a run that costs money does before it is allowed to: know
 * what it will cost, stay under what it was given, and cost half when nobody is
 * waiting for it.
 *
 * - `--estimate` counts every request the run would send with `count_tokens`,
 *   which is free, and prices it twice — at the output a recorded run actually
 *   produced, and at `max_tokens` for every request, the most it can be billed.
 *   It sends nothing to the model.
 * - `--max-usd` is a ceiling in dollars. A run whose worst case exceeds it does
 *   not start; a request that would take the ledger past it is not sent.
 * - `--batch` sends the run as one Message Batch at half the price, and reads
 *   the answers back through the same path a synchronous run takes, so
 *   everything recorded from it replays byte for byte like a synchronous
 *   recording.
 *
 * None of this exists in replay, which spends nothing. Each one refuses to run
 * there rather than pretending to, because a free run that claims to have
 * estimated or capped something has measured nothing.
 */

// ---------------------------------------------------------------------------
// What a run would send
// ---------------------------------------------------------------------------

/**
 * Every request `evaluate` would send for these options, in the order it would
 * send them, built by the agent's own request builder.
 *
 * Not a copy of how a request is assembled: `triageOptions` and `buildRequest`
 * are what `triage` and `callModel` call, with the same prompt, the same
 * context options `chooseClassifier` passes and the same config. A test runs
 * `evaluate` and checks it asks for exactly these, because a plan that drifted
 * from the run would batch requests nobody makes and leave the real ones to be
 * paid for synchronously.
 *
 * The slice is the one the run scores, so a batch never reads the held-out
 * fixtures unless `--slice` says so — and then `main` logs the consultation the
 * way it logs every other one.
 */
export function planRun(options: Pick<Options, 'slice' | 'samples'>): PlannedRequest[] {
  const prompt = loadPrompt(CURRENT_PROMPT.triage)
  const context = contextFor([])
  const plan: PlannedRequest[] = []

  for (const name of listFixtures().filter((n) => inSlice(n, options.slice))) {
    const { payload } = loadPayload(name)
    for (let sample = 0; sample < options.samples; sample++) {
      const { options: call } = triageOptions(payload, {
        system: prompt.system,
        promptVersion: prompt.version,
        context,
        sample,
      })
      plan.push({ label: `${name} #${String(sample)}`, request: buildRequest(call) })
    }
  }
  return plan
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

export interface Estimate {
  requests: number
  model: string
  maxTokens: number
  /** Counted by `count_tokens`, request by request. */
  inputTokens: number
  /** Output per request in recorded runs of this prompt on this model, when there are any. */
  observed: { cassettes: number; meanOutputTokens: number } | null
  usd: Record<Tier, { expected: number | null; worst: number }>
}

export interface EstimateDeps {
  count: (request: ModelRequest) => Promise<number>
  cassettes: readonly Cassette[]
  sleep?: (ms: number) => Promise<void>
}

/**
 * What these requests cost, before any of them is sent.
 *
 * The input side is counted, not guessed: `count_tokens` on the body each
 * request would carry. The output side cannot be counted before the model
 * writes it, so it is stated as an assumption, twice. The worst case is
 * `max_tokens` for every request — thinking is on and counts as output, so
 * this is the figure the cap is held to. The expected case is the mean output
 * of the recorded runs of this prompt on this model, and is absent rather than
 * invented when there are none.
 *
 * A model with no price is an error here rather than a zero, for the reason
 * `agents/pricing.ts` gives.
 */
export async function estimate(
  requests: readonly ModelRequest[],
  deps: EstimateDeps,
): Promise<Estimate> {
  const model = requests[0]?.model ?? MODEL_CONFIG.model
  const promptVersion = requests[0]?.promptVersion ?? CURRENT_PROMPT.triage
  const sleep = deps.sleep ?? defaultSleep

  const counts: number[] = []
  for (const request of requests) {
    // Counting is rate limited like any endpoint. A 429 part-way through a
    // run's worth of counts is waited out the way a dispatch's would be.
    counts.push(
      await withTransientRetry(
        () => deps.count(request),
        MODEL_CONFIG,
        { transientFailures: 0 },
        { sleep, random: Math.random },
      ),
    )
  }

  const recorded = deps.cassettes.filter(
    (c) => c.promptVersion === promptVersion && c.model === model,
  )
  const observed =
    recorded.length === 0
      ? null
      : {
          cassettes: recorded.length,
          meanOutputTokens: Math.round(
            recorded.reduce((sum, c) => sum + c.response.usage.outputTokens, 0) / recorded.length,
          ),
        }

  const total = (tier: Tier, output: (request: ModelRequest) => number): number =>
    requests.reduce((sum, request, i) => {
      const priced = priceTokens(request.model, counts[i] ?? 0, output(request), tier)
      if (priced === null) {
        throw new Error(
          `agents/pricing.ts has no price for ${request.model}, so there is no estimate to give: ` +
            'a cost with a missing share is a floor, not a figure',
        )
      }
      return sum + priced
    }, 0)

  const at = (tier: Tier) => ({
    expected: observed === null ? null : total(tier, () => observed.meanOutputTokens),
    worst: total(tier, (request) => request.maxTokens),
  })

  return {
    requests: requests.length,
    model,
    maxTokens: requests[0]?.maxTokens ?? MODEL_CONFIG.maxTokens,
    inputTokens: counts.reduce((sum, n) => sum + n, 0),
    observed,
    usd: { standard: at('standard'), batch: at('batch') },
  }
}

export interface EstimateContext {
  /** The first line: what is being estimated. */
  heading: string
  /** What the requests are, in words: `32 fixtures × 5 samples`. */
  composition?: string
  maxUsd: number | null
  /** The run's token budget, from `SENTRA_TOKEN_BUDGET`. */
  budget: number
  /** Input tokens already billed, for a batch that resubmits part of a run. */
  alreadyBilledInput?: number
}

/** The estimate as a person reads it. Every figure the cap and the budget are held to is on it. */
export function renderEstimate(estimate: Estimate, context: EstimateContext): string {
  const { usd, observed } = estimate
  const money = (value: number | null): string => (value === null ? '—' : formatUsd(value))
  const cell = (text: string, width: number): string => text.padStart(width)

  const lines = [
    `  ${context.heading} Nothing has been sent to the model.`,
    '',
    `    requests        ${number(estimate.requests)}${context.composition === undefined ? '' : `  (${context.composition}, one request each)`}`,
    `    model           ${estimate.model}, max_tokens ${number(estimate.maxTokens)}`,
    `    input tokens    ${number(estimate.inputTokens)}, counted by count_tokens request by request`,
    observed === null
      ? `    output tokens   expected: not known — no cassette is recorded for this prompt on this model yet`
      : `    output tokens   expected: ${number(observed.meanOutputTokens)} a request, the mean over ${number(observed.cassettes)} recorded cassette(s)`,
    `                    worst case: ${number(estimate.maxTokens)} a request, every request at max_tokens (MODEL_CONFIG.maxTokens)`,
    '',
    `    ${''.padEnd(16)}${cell('expected', 12)}${cell('worst case', 14)}`,
    `    ${'synchronous'.padEnd(16)}${cell(money(usd.standard.expected), 12)}${cell(money(usd.standard.worst), 14)}`,
    `    ${'Message Batch'.padEnd(16)}${cell(money(usd.batch.expected), 12)}${cell(money(usd.batch.worst), 14)}`,
    '',
    '  Not included: a schema correction or a transient re-send. Each is an extra request at the',
    '  synchronous rate, and happens only when something goes wrong; the cap still holds it.',
  ]

  const needed = (context.alreadyBilledInput ?? 0) + estimate.inputTokens
  lines.push(
    '',
    needed <= context.budget
      ? `  Token budget: ${number(needed)} input tokens of ${number(context.budget)} (SENTRA_TOKEN_BUDGET).`
      : `  Token budget: ${number(needed)} input tokens against ${number(context.budget)} (SENTRA_TOKEN_BUDGET).\n` +
          `  The run would stop part-way; raise it to at least ${number(needed)}.`,
  )

  const cap = context.maxUsd
  if (cap !== null) {
    const verdict = (worst: number): string =>
      `${worst <= cap ? 'fits' : 'refused'} (worst case ${formatUsd(worst)})`
    lines.push(
      `  Under --max-usd=${String(cap)}: Message Batch ${verdict(usd.batch.worst)}, ` +
        `synchronous ${verdict(usd.standard.worst)}.`,
    )
  }
  return lines.join('\n')
}

const number = (n: number): string => n.toLocaleString('en-US')

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** Where a batched run keeps the ids of the batches it paid for, one file per slice. */
export const batchStatePath = (slice: Options['slice']): string => `.sentra/batch-${slice}.json`

export interface PaidRunDeps {
  env?: NodeJS.ProcessEnv
  /**
   * The live API, as both ports. The default — the one place a real client is
   * built on this path — is constructed only after the environment has been
   * judged to be a run that is meant to reach the network.
   */
  connect?: () => Transport & BatchTransport
  /** Recorded cassettes, for the expected output. */
  cassettes?: () => Cassette[]
  /** Where a recording run writes, for tests; the committed directory otherwise. */
  cassetteDir?: string
  store?: StateStore
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

/** A transport to score the run through, and the ledger a cap built on it reads. */
export interface Prepared {
  transport: Transport
  ledger: UsageLedger
  /** Called once the run has been scored. */
  settle: () => void
}

export class NeedsCredentialsError extends Error {
  constructor(flag: string, what: readonly string[]) {
    super(
      [
        `${flag} ${what[0] ?? ''}`,
        ...what.slice(1),
        '',
        'This environment resolves to replay: there are no credentials, or SENTRA_REPLAY=1',
        'is asking for no network at all.',
        '',
        'Set ANTHROPIC_API_KEY (or SENTRA_LIVE=1 for an `ant auth login` profile) and run',
        'again. There is no fallback: a figure made up offline is exactly what this replaces.',
        'Nothing was counted, sent or spent.',
      ].join('\n'),
    )
    this.name = 'NeedsCredentialsError'
  }
}

/** `npm run eval -- --classifier=agent --estimate`: the figures, and nothing sent. */
export async function runEstimate(options: Options, deps: PaidRunDeps = {}): Promise<string> {
  const env = deps.env ?? process.env
  if (resolveMode(env) === 'replay') {
    throw new NeedsCredentialsError('--estimate', [
      'counts every request with count_tokens, which is free but is still an API call.',
    ])
  }
  const live = connect(deps)
  const plan = planRun(options)
  const figures = await estimate(
    plan.map((p) => p.request),
    { count: (r) => live.countInputTokens(r), cassettes: cassettesOf(deps), ...sleepOf(deps) },
  )
  return renderEstimate(figures, {
    heading: `Estimate for --classifier=agent --slice=${options.slice} --n=${String(options.samples)}.`,
    composition: `${String(plan.length / options.samples)} fixtures × ${String(options.samples)} samples`,
    maxUsd: options.maxUsd,
    budget: tokenBudget(env),
  })
}

/**
 * A synchronous run under `--max-usd`: estimated first, refused if its worst
 * case does not fit, and capped request by request if it does.
 *
 * Null in replay, which spends nothing and has nothing to cap.
 */
export async function prepareCapped(
  options: Options,
  deps: PaidRunDeps = {},
): Promise<Prepared | null> {
  const env = deps.env ?? process.env
  const mode = resolveMode(env)
  if (mode === 'replay' || options.maxUsd === null) return null
  const log = deps.log ?? console.log

  const live = connect(deps)
  const plan = planRun(options)
  const figures = await estimate(
    plan.map((p) => p.request),
    { count: (r) => live.countInputTokens(r), cassettes: cassettesOf(deps), ...sleepOf(deps) },
  )
  const budget = tokenBudget(env)
  log(
    `\n${renderEstimate(figures, {
      heading: `Before a synchronous run under --max-usd=${String(options.maxUsd)}.`,
      composition: `${String(plan.length / options.samples)} fixtures × ${String(options.samples)} samples`,
      maxUsd: options.maxUsd,
      budget,
    })}\n`,
  )
  refuseOverBudget(figures.inputTokens, budget)

  const ledger = new UsageLedger()
  const cap = new SpendCap(options.maxUsd, () => ledger.spend.usd)
  // Admitted and released at once: this is the refusal to start. From here
  // every request is admitted on its own worst case, against what the ledger
  // says was billed — which is where a retry the estimate could not foresee
  // is stopped.
  cap.admit('this run, sent synchronously,', figures.usd.standard.worst)()

  return {
    transport: new CassetteTransport(new CappedTransport(live, cap), cassetteOptions(mode, deps)),
    ledger,
    settle: () => undefined,
  }
}

/**
 * A run as one Message Batch: collected — submitted first if nothing saved
 * answers it — and handed back as a transport the ordinary loop reads from.
 *
 * The transport is the same decorator stack a synchronous run gets — cassettes
 * on the outside, so a recording run records exactly what it would have
 * recorded — with the batch's results in place of the network, and the network,
 * capped, behind them for the requests no batch could carry.
 */
export async function prepareBatch(options: Options, deps: PaidRunDeps = {}): Promise<Prepared> {
  const env = deps.env ?? process.env
  const mode = resolveMode(env)
  if (mode === 'replay') {
    throw new NeedsCredentialsError('--batch', [
      'submits a Message Batch. A replay reads the cassettes a batch recorded exactly',
      'as it reads any others, so drop --batch to replay.',
    ])
  }
  const log = deps.log ?? console.log
  const live = connect(deps)
  const plan = planRun(options)
  const budget = tokenBudget(env)
  const ledger = new UsageLedger()
  const store = deps.store ?? fileStore(batchStatePath(options.slice))

  // What the batches have billed so far. The cap reads it with the ledger's
  // synchronous entries, and only those: the batch's own entries reach the
  // ledger as the run reads them back, and counting both would charge the
  // batch twice.
  let committed = 0
  const cap =
    options.maxUsd === null
      ? null
      : new SpendCap(options.maxUsd, () => committed + synchronousSpend(ledger))

  const collected = await collectBatch(plan, {
    transport: live,
    store,
    maxWaitMs: options.waitMinutes * 60_000,
    model: MODEL_CONFIG.model,
    promptVersion: plan[0]?.request.promptVersion ?? CURRENT_PROMPT.triage,
    admit: async (entries, already) => {
      committed = billed(already.values())
      const figures = await estimate(
        entries.map((e) => e.request),
        { count: (r) => live.countInputTokens(r), cassettes: cassettesOf(deps), ...sleepOf(deps) },
      )
      const alreadyBilledInput = billedInput(already.values())
      log(
        `\n${renderEstimate(figures, {
          heading: `Submitting ${String(entries.length)} request(s) as one Message Batch.`,
          maxUsd: options.maxUsd,
          budget,
          alreadyBilledInput,
        })}\n`,
      )
      refuseOverBudget(alreadyBilledInput + figures.inputTokens, budget)
      return cap === null
        ? () => undefined
        : cap.admit(`a batch of ${String(entries.length)} request(s)`, figures.usd.batch.worst)
    },
    log,
    ...(deps.sleep !== undefined && { sleep: deps.sleep }),
    ...(deps.now !== undefined && { now: deps.now }),
  })
  committed = billed(collected.outcomes.values())
  log(
    `  ${String(plan.length)} request(s) answered by ${String(collected.batches.length)} batch(es), ${formatUsd(committed)} billed at the batch rate.\n`,
  )

  const behind = cap === null ? live : new CappedTransport(live, cap)
  return {
    transport: new CassetteTransport(
      new BatchResultsTransport(collected.outcomes, behind),
      cassetteOptions(mode, deps),
    ),
    ledger,
    // Only once the run is scored: until then the saved ids are what lets a
    // failed scoring be re-run without paying for the batch again.
    settle: () => {
      store.clear()
    },
  }
}

/**
 * Refuse a run the token budget would stop part-way.
 *
 * Checked before anything is spent, because the budget would otherwise be
 * found out only after paying for the part of the run that fits — and for a
 * batch, after paying for all of it.
 */
function refuseOverBudget(needed: number, budget: number): void {
  if (needed <= budget) return
  throw new Error(
    `the run needs ${number(needed)} input tokens and the token budget is ${number(budget)} ` +
      `(SENTRA_TOKEN_BUDGET). It would stop part-way, after paying for what it reached. ` +
      `Raise SENTRA_TOKEN_BUDGET to at least ${number(needed)}. Nothing was sent.`,
  )
}

function billed(outcomes: Iterable<BatchOutcome>): number {
  const usd = billedUsd(outcomes)
  if (usd === null) {
    throw new Error(
      'a batch result came from a model agents/pricing.ts has no price for, so the spending ' +
        'cap cannot know what has been spent; add the price before going on',
    )
  }
  return usd
}

function billedInput(outcomes: Iterable<BatchOutcome>): number {
  let tokens = 0
  for (const outcome of outcomes) {
    if (outcome.type === 'succeeded') tokens += outcome.response.usage.inputTokens
    if (outcome.type === 'unusable') tokens += outcome.error.response?.usage.inputTokens ?? 0
  }
  return tokens
}

const synchronousSpend = (ledger: UsageLedger): number =>
  spendOf(ledger.dispatches.filter((d) => d.tier !== 'batch')).usd

const connect = (deps: PaidRunDeps): Transport & BatchTransport =>
  deps.connect === undefined ? new AnthropicTransport() : deps.connect()

const cassettesOf = (deps: PaidRunDeps): Cassette[] => (deps.cassettes ?? listCassettes)()

const sleepOf = (deps: PaidRunDeps): { sleep?: (ms: number) => Promise<void> } =>
  deps.sleep === undefined ? {} : { sleep: deps.sleep }

const cassetteOptions = (mode: 'record' | 'live', deps: PaidRunDeps) => ({
  mode,
  ...(deps.cassetteDir !== undefined && { dir: deps.cassetteDir }),
})

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
