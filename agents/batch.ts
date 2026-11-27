import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { cassetteKey } from './cassettes.js'
import { priceTokens } from './pricing.js'
import {
  TransportError,
  type BatchEntry,
  type BatchOutcome,
  type BatchStatus,
  type BatchTransport,
  type ModelRequest,
  type ModelResponse,
  type Transport,
} from './transport.js'

/**
 * A run's requests as one Message Batch: submitted once, waited on, and read
 * back through the same path a synchronous run takes.
 *
 * Half the price, for a run nobody is waiting on — which an evaluation is. The
 * design follows from one requirement: **a batched run and a synchronous one
 * must be indistinguishable to everything after the transport.** So this file
 * does not parse, validate, price into the ledger or write cassettes. It
 * collects the results, keyed by `custom_id`, and hands back a `Transport` that
 * answers each request from them. The caller runs its ordinary loop over that
 * transport — `callModel`, the schema check, the ledger, the cassette decorator
 * — and a replay of what it recorded cannot tell how the answers were paid for.
 *
 * Three properties are the point of the rest:
 *
 * - **Nothing is paid for twice.** The batch id is saved the moment the batch
 *   exists. A run that is interrupted, or outlives its wait, is resumed by
 *   running it again: the saved batch is collected, not resubmitted.
 * - **Results are matched by `custom_id`, never by position.** The id is the
 *   request's cassette key, so it is deterministic, and a result names exactly
 *   the request — and the recording — it belongs to.
 * - **Nothing is dropped.** A request the API did not answer is named, with
 *   where it came from, and either resubmitted on its own or the run stops.
 */

/** One request a run would make, with where it came from for the report. */
export interface PlannedRequest {
  /** For a person reading the report: `board-render-throws-on-empty-description #3`. */
  label: string
  request: ModelRequest
}

/** The `custom_id` a request is submitted under: its cassette key, 16 hex characters. */
export const customIdOf = (request: ModelRequest): string => cassetteKey(request)

/**
 * The identity of a set of requests.
 *
 * Over the ids, so it moves when any request does: a reworded prompt, a new
 * fixture, another sample. A saved batch is only ever collected into the plan
 * that submitted it.
 */
export function planDigest(plan: readonly PlannedRequest[]): string {
  const ids = [...new Set(plan.map((p) => customIdOf(p.request)))].sort()
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Saved state
// ---------------------------------------------------------------------------

const StateSchema = z
  .object({
    version: z.literal(1),
    /** `planDigest` of the requests these batches were submitted for. */
    plan: z.string(),
    model: z.string(),
    promptVersion: z.string(),
    /** Every batch submitted for the plan, in order. Each later one resubmits what an earlier one did not answer. */
    batches: z.array(
      z
        .object({
          id: z.string(),
          submittedAt: z.string(),
          requests: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict()

export type BatchState = z.infer<typeof StateSchema>

export interface StateStore {
  /** Where it lives, so a message can name the file. */
  readonly path: string
  read(): BatchState | null
  write(state: BatchState): void
  clear(): void
}

/**
 * The saved state as a JSON file, written atomically.
 *
 * Atomically because the file is the only record of money already spent. A
 * write torn by a killed process would leave a batch nobody can find, and the
 * next run would submit it again.
 */
export function fileStore(path: string): StateStore {
  return {
    path,
    read: () => {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return null
      }
      const parsed = StateSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        throw new Error(
          `${path} is not a saved batch: ${parsed.error.issues[0]?.message ?? ''}. ` +
            'It records batches that were paid for, so it is not deleted automatically — ' +
            'check the batches in the Console, then remove the file by hand.',
        )
      }
      return parsed.data
    },
    write: (state) => {
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${String(process.pid)}.tmp`
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
      renameSync(temporary, path)
    },
    clear: () => {
      rmSync(path, { force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A saved batch belongs to a different set of requests than this run would make. */
export class BatchPlanMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly saved: BatchState,
  ) {
    super(
      [
        `${path} holds ${String(saved.batches.length)} batch(es) for a different set of requests ` +
          `(${saved.promptVersion} on ${saved.model}, plan ${saved.plan}):`,
        '',
        ...saved.batches.map(
          (b) => `    ${b.id}  ${String(b.requests)} request(s), ${b.submittedAt}`,
        ),
        '',
        'Those were paid for. To use them, run the code that submitted them. To abandon them',
        `and submit afresh, which pays again, delete ${path}.`,
      ].join('\n'),
    )
    this.name = 'BatchPlanMismatchError'
  }
}

/** The wall-clock ceiling arrived first. Nothing is lost: the id is saved. */
export class BatchStillRunningError extends Error {
  constructor(
    readonly path: string,
    readonly status: BatchStatus,
    readonly waitedMs: number,
  ) {
    super(
      [
        `batch ${status.id} is still ${status.processing} after ${minutes(waitedMs)} ` +
          `(${String(status.counts.processing)} request(s) not yet processed; the API gives up at ${status.expiresAt}).`,
        '',
        `Its id is saved in ${path}, so running the same command again collects it`,
        'instead of submitting it a second time.',
      ].join('\n'),
    )
    this.name = 'BatchStillRunningError'
  }
}

/** What became of a request the API did not answer, for the report. */
export interface Unanswered {
  label: string
  customId: string
  outcome: Extract<BatchOutcome, { type: 'errored' | 'canceled' | 'expired' }>
  /** Whether submitting it again can produce an answer. */
  resubmittable: boolean
}

/** Some requests have no answer, and the run cannot be scored without them. */
export class BatchIncompleteError extends Error {
  constructor(
    readonly path: string,
    readonly unanswered: readonly Unanswered[],
    readonly planned: number,
  ) {
    const fatal = unanswered.filter((u) => !u.resubmittable)
    super(
      [
        `${String(unanswered.length)} of ${String(planned)} request(s) have no answer:`,
        '',
        ...renderUnanswered(unanswered),
        '',
        ...(fatal.length > 0
          ? [
              `${String(fatal.length)} of them the API rejected, and would reject again: the request itself`,
              'is wrong. Nothing more was submitted. The answered ones stay collectable from the',
              `batch(es) saved in ${path}.`,
            ]
          : [
              'None was billed. The answered ones are kept: running the same command again',
              `collects them from the batch(es) saved in ${path} and resubmits only these.`,
            ]),
      ].join('\n'),
    )
    this.name = 'BatchIncompleteError'
  }
}

export function renderUnanswered(unanswered: readonly Unanswered[]): string[] {
  const width = Math.max(...unanswered.map((u) => u.label.length), 'request'.length)
  return [
    `  ${'request'.padEnd(width)}  ${'result'.padEnd(8)}  detail`,
    ...unanswered.map(
      (u) => `  ${u.label.padEnd(width)}  ${u.outcome.type.padEnd(8)}  ${detail(u.outcome)}`,
    ),
  ]
}

const detail = (outcome: Unanswered['outcome']): string => {
  switch (outcome.type) {
    case 'errored':
      return `${outcome.error.message}${outcome.error.retryable ? '' : ' (not retryable)'}`
    case 'canceled':
      return 'the batch was canceled before this request reached the model'
    case 'expired':
      return 'the batch reached its 24-hour limit before this request reached the model'
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface BatchRunDeps {
  transport: BatchTransport
  store: StateStore
  /** The most one run waits, all batches together, before it stops and leaves the id saved. */
  maxWaitMs: number
  /**
   * Asked before anything is submitted, with exactly what would be and what is
   * already collected: the spending cap and the token budget live with the
   * caller. Throws to refuse; returns a release, called once the submission's
   * results are collected.
   */
  admit: (
    entries: readonly BatchEntry[],
    collected: ReadonlyMap<string, BatchOutcome>,
  ) => Promise<() => void>
  model: string
  promptVersion: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

/** The first poll waits this long, each later one half as long again, up to the ceiling. */
export const POLL = { firstMs: 30_000, factor: 1.5, maxMs: 300_000 } as const

export interface Collected {
  /** Every result collected, by `custom_id`. */
  outcomes: ReadonlyMap<string, BatchOutcome>
  /** Ids of the batches the outcomes came from, oldest first. */
  batches: readonly string[]
}

/**
 * Collect an answer for every planned request, submitting at most once.
 *
 * Saved batches are collected first — waited on if they are still running —
 * because they are already paid for. What they leave unanswered and could be
 * answered is then submitted as one new batch, after `admit`. Anything still
 * without an answer after that stops the run with every such request named.
 *
 * At most one submission per run, so that a batch which keeps failing costs one
 * submission per deliberate re-run rather than looping on its own.
 */
export async function collectBatch(
  plan: readonly PlannedRequest[],
  deps: BatchRunDeps,
): Promise<Collected> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const started = now()
  const deadline = started + deps.maxWaitMs

  const digest = planDigest(plan)
  const labels = labelsById(plan)
  const requests = uniqueRequests(plan)

  const saved = deps.store.read()
  if (saved !== null && saved.plan !== digest)
    throw new BatchPlanMismatchError(deps.store.path, saved)
  let state: BatchState = saved ?? {
    version: 1,
    plan: digest,
    model: deps.model,
    promptVersion: deps.promptVersion,
    batches: [],
  }

  const outcomes = new Map<string, BatchOutcome>()
  const collect = async (id: string): Promise<void> => {
    const status = await waitFor(id, deps, { sleep, now, log, started, deadline })
    log(
      `  batch ${id} ended: ${String(status.counts.succeeded)} succeeded, ${String(status.counts.errored)} errored, ` +
        `${String(status.counts.canceled)} canceled, ${String(status.counts.expired)} expired`,
    )
    try {
      for await (const { customId, outcome } of deps.transport.batchResults(id)) {
        if (!labels.has(customId)) continue
        // An answer is never replaced: a later batch only ever resubmits what
        // an earlier one left unanswered, and a usable result stays the one used.
        const held = outcomes.get(customId)
        if (held === undefined || !answered(held)) outcomes.set(customId, outcome)
      }
    } catch (error) {
      throw new TransportError(
        error instanceof TransportError ? error.kind : 'client',
        `batch ${id}, saved in ${deps.store.path}, could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}. Results are kept for 29 days; ` +
          `if they are gone, deleting ${deps.store.path} submits afresh, which pays again.`,
      )
    }
  }

  for (const batch of state.batches) {
    log(`  collecting batch ${batch.id}, saved ${batch.submittedAt}`)
    await collect(batch.id)
  }

  const missing = (): Unanswered[] => unanswered(requests, outcomes, labels)
  const before = missing()
  const fatal = before.filter((u) => !u.resubmittable)
  if (fatal.length > 0) throw new BatchIncompleteError(deps.store.path, before, requests.size)

  const outstanding = [...requests].filter(([id]) => !answered(outcomes.get(id)))
  if (outstanding.length > 0) {
    if (before.length > 0) {
      log(`\n  Resubmitting ${String(before.length)} request(s) an earlier batch did not answer:\n`)
      for (const line of renderUnanswered(before)) log(line)
      log('')
    }
    const entries: BatchEntry[] = outstanding.map(([customId, request]) => ({ customId, request }))
    const release = await deps.admit(entries, outcomes)
    try {
      const status = await deps.transport.submitBatch(entries)
      // Saved before anything else can fail. From here the batch is paid for,
      // and the file is the only thing that can find it again.
      state = {
        ...state,
        batches: [
          ...state.batches,
          { id: status.id, submittedAt: new Date(now()).toISOString(), requests: entries.length },
        ],
      }
      deps.store.write(state)
      log(
        `  submitted batch ${status.id}: ${String(entries.length)} request(s), saved in ${deps.store.path}`,
      )
      await collect(status.id)
    } finally {
      release()
    }
  }

  const after = missing()
  if (after.length > 0) throw new BatchIncompleteError(deps.store.path, after, requests.size)

  return { outcomes, batches: state.batches.map((b) => b.id) }
}

async function waitFor(
  id: string,
  deps: BatchRunDeps,
  clock: {
    sleep: (ms: number) => Promise<void>
    now: () => number
    log: (line: string) => void
    started: number
    deadline: number
  },
): Promise<BatchStatus> {
  let delay: number = POLL.firstMs
  for (;;) {
    let status: BatchStatus
    try {
      status = await deps.transport.retrieveBatch(id)
    } catch (error) {
      // Polling is free and idempotent, so a transient failure is waited out
      // rather than ending a run whose batch is still being paid for.
      if (!(error instanceof TransportError) || !error.retryable) throw error
      if (clock.deadline - clock.now() <= 0) throw error
      clock.log(`  polling batch ${id} failed (${error.message}); trying again`)
      await clock.sleep(Math.min(delay, clock.deadline - clock.now()))
      delay = Math.min(delay * POLL.factor, POLL.maxMs)
      continue
    }

    if (status.processing === 'ended') return status
    const left = clock.deadline - clock.now()
    if (left <= 0)
      throw new BatchStillRunningError(deps.store.path, status, clock.now() - clock.started)

    const total = Object.values(status.counts).reduce((sum, n) => sum + n, 0)
    clock.log(
      `  batch ${id}: ${status.processing}, ${String(total - status.counts.processing)} of ${String(total)} done, ` +
        `${minutes(clock.now() - clock.started)} elapsed`,
    )
    await clock.sleep(Math.min(delay, left))
    delay = Math.min(delay * POLL.factor, POLL.maxMs)
  }
}

const answered = (outcome: BatchOutcome | undefined): boolean =>
  outcome?.type === 'succeeded' || outcome?.type === 'unusable'

function unanswered(
  requests: ReadonlyMap<string, ModelRequest>,
  outcomes: ReadonlyMap<string, BatchOutcome>,
  labels: ReadonlyMap<string, string[]>,
): Unanswered[] {
  const rows: Unanswered[] = []
  for (const customId of requests.keys()) {
    const outcome = outcomes.get(customId)
    if (outcome === undefined || answered(outcome)) continue
    if (outcome.type !== 'errored' && outcome.type !== 'canceled' && outcome.type !== 'expired')
      continue
    for (const label of labels.get(customId) ?? [customId]) {
      rows.push({
        label,
        customId,
        outcome,
        resubmittable: outcome.type !== 'errored' || outcome.error.retryable,
      })
    }
  }
  return rows
}

/** Every label a `custom_id` stands for. Two identical requests share one result, as they share one cassette. */
function labelsById(plan: readonly PlannedRequest[]): Map<string, string[]> {
  const labels = new Map<string, string[]>()
  for (const { label, request } of plan) {
    const id = customIdOf(request)
    labels.set(id, [...(labels.get(id) ?? []), label])
  }
  return labels
}

/** One entry per `custom_id`, which the API requires to be unique within a batch. */
function uniqueRequests(plan: readonly PlannedRequest[]): Map<string, ModelRequest> {
  const requests = new Map<string, ModelRequest>()
  for (const { request } of plan) {
    const id = customIdOf(request)
    if (!requests.has(id)) requests.set(id, request)
  }
  return requests
}

/**
 * What the collected results were billed, at the batch rate.
 *
 * A refusal and an unreadable reply are billed like any answer, so both count.
 * Null when a model in the results has no price.
 */
export function billedUsd(outcomes: Iterable<BatchOutcome>): number | null {
  let usd = 0
  for (const outcome of outcomes) {
    const response =
      outcome.type === 'succeeded'
        ? outcome.response
        : outcome.type === 'unusable'
          ? outcome.error.response
          : undefined
    if (response === undefined) continue
    const priced = priceTokens(
      response.model,
      response.usage.inputTokens,
      response.usage.outputTokens,
      response.tier ?? 'standard',
    )
    if (priced === null) return null
    usd += priced
  }
  return usd
}

// ---------------------------------------------------------------------------
// Reading the results back
// ---------------------------------------------------------------------------

/**
 * A `Transport` that answers from a collected batch.
 *
 * What makes a batched run go through the synchronous path. A planned request
 * is answered from its result — or, for a refusal or an unreadable reply,
 * fails with exactly the error `send` would have thrown, carrying the bill. The
 * input-token count it reports is the billed one, as a replayed cassette's is.
 *
 * A request that is not in the batch goes to `live`: the only such request is
 * a schema correction, whose prompt carries the first answer and so could not
 * have been planned. So is a re-send of a request whose batch reply was
 * unreadable — the synchronous path re-sends that too, as a fresh request,
 * and replaying the same unreadable reply would only fail again. Both are paid
 * at the standard rate, and `live` is where the spending cap sits.
 */
export class BatchResultsTransport implements Transport {
  /** Unusable results already handed out once. A re-send of one is a new request. */
  private readonly spent = new Set<string>()

  constructor(
    private readonly outcomes: ReadonlyMap<string, BatchOutcome>,
    private readonly live: Transport,
  ) {}

  countInputTokens(request: ModelRequest): Promise<number> {
    const outcome = this.usable(request)
    if (outcome === undefined) return this.live.countInputTokens(request)
    return Promise.resolve(
      outcome.type === 'succeeded'
        ? outcome.response.usage.inputTokens
        : (outcome.error.response?.usage.inputTokens ?? 0),
    )
  }

  async send(request: ModelRequest): Promise<ModelResponse> {
    const outcome = this.usable(request)
    if (outcome === undefined) return this.live.send(request)
    if (outcome.type === 'succeeded') return outcome.response
    this.spent.add(customIdOf(request))
    throw outcome.error
  }

  private usable(
    request: ModelRequest,
  ): Extract<BatchOutcome, { type: 'succeeded' | 'unusable' }> | undefined {
    const id = customIdOf(request)
    const outcome = this.outcomes.get(id)
    if (outcome === undefined || this.spent.has(id)) return undefined
    if (outcome.type === 'succeeded' || outcome.type === 'unusable') return outcome
    // `collectBatch` returns only once every planned request has an answer, so
    // this is a caller handing over results it did not collect. Paying for the
    // request synchronously instead would be the silent fallthrough every other
    // part of this pipeline refuses.
    throw new TransportError(
      'client',
      `the batch has no answer for request ${id} (${outcome.type}); it was not collected before the run`,
    )
  }
}

const minutes = (ms: number): string => `${String(Math.round(ms / 60_000))} min`

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
