import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BatchIncompleteError,
  BatchPlanMismatchError,
  BatchResultsTransport,
  BatchStillRunningError,
  billedUsd,
  collectBatch,
  customIdOf,
  fileStore,
  planDigest,
  POLL,
  type BatchRunDeps,
  type BatchState,
  type PlannedRequest,
  type StateStore,
} from './batch.js'
import { cassetteKey } from './cassettes.js'
import {
  TransportError,
  type BatchEntry,
  type BatchOutcome,
  type BatchResult,
  type BatchStatus,
  type BatchTransport,
  type ModelRequest,
  type ModelResponse,
  type Transport,
} from './transport.js'

/**
 * Submitting, waiting for and collecting a Message Batch, with a fake batch
 * API and a fake clock — no key, no network, no wait.
 *
 * What is pinned is what a person running an expensive batch relies on: it is
 * never paid for twice, every result lands on the request it answers whatever
 * order it arrives in, and a request the API did not answer is named rather
 * than dropped.
 */

const request = (n: number, sample = 0): ModelRequest => ({
  model: 'claude-opus-5-5',
  maxTokens: 8_000,
  effort: 'high',
  system: 'classify',
  prompt: `failure number ${String(n)}`,
  schemaName: 'classification',
  jsonSchema: { type: 'object' },
  promptVersion: 'triage.v1',
  sample,
})

const plan: PlannedRequest[] = [0, 1, 2, 3].map((n) => ({
  label: `fixture-${String(n)} #0`,
  request: request(n),
}))

/** An answer that says which request it answers, so a misplaced result is visible. */
const answerTo = (r: ModelRequest): ModelResponse => ({
  raw: { prompt: r.prompt },
  stopReason: 'end_turn',
  model: r.model,
  usage: { inputTokens: 1_000, outputTokens: 200 },
  tier: 'batch',
})

type Script = (entry: BatchEntry, batch: number) => BatchOutcome

const succeed: Script = (entry) => ({ type: 'succeeded', response: answerTo(entry.request) })

function fakeApi(
  script: Script = succeed,
  options: { pollsBeforeEnd?: number; pollFailures?: number } = {},
): BatchTransport & {
  submitted: BatchEntry[][]
  polls: string[]
  onResults: (() => void) | undefined
} {
  const submitted: BatchEntry[][] = []
  const polls: string[] = []
  const entries = new Map<string, { batch: number; entries: BatchEntry[] }>()
  let failures = options.pollFailures ?? 0
  const api = {
    submitted,
    polls,
    onResults: undefined as (() => void) | undefined,
    submitBatch(batch: readonly BatchEntry[]): Promise<BatchStatus> {
      submitted.push([...batch])
      const id = `msgbatch_${String(submitted.length)}`
      entries.set(id, { batch: submitted.length - 1, entries: [...batch] })
      return Promise.resolve(status(id, 'in_progress', batch.length))
    },
    retrieveBatch(id: string): Promise<BatchStatus> {
      polls.push(id)
      if (failures > 0) {
        failures -= 1
        return Promise.reject(new TransportError('server', 'overloaded'))
      }
      const ended = polls.filter((p) => p === id).length > (options.pollsBeforeEnd ?? 0)
      return Promise.resolve(
        status(id, ended ? 'ended' : 'in_progress', entries.get(id)?.entries.length ?? 4),
      )
    },
    async *batchResults(id: string): AsyncGenerator<BatchResult> {
      api.onResults?.()
      const known = entries.get(id) ?? { batch: 0, entries: plan.map(entryOf) }
      // Reversed: the API documents results in any order, and a runner that
      // matched by position would put every answer on the wrong request.
      for (const entry of [...known.entries].reverse()) {
        yield await Promise.resolve({
          customId: entry.customId,
          outcome: script(entry, known.batch),
        })
      }
    },
  }
  return api
}

const entryOf = (p: PlannedRequest): BatchEntry => ({
  customId: customIdOf(p.request),
  request: p.request,
})

const status = (id: string, processing: BatchStatus['processing'], n: number): BatchStatus => ({
  id,
  processing,
  counts: {
    processing: processing === 'ended' ? 0 : n,
    succeeded: processing === 'ended' ? n : 0,
    errored: 0,
    canceled: 0,
    expired: 0,
  },
  expiresAt: '2026-11-28T10:00:00Z',
})

function memoryStore(initial: BatchState | null = null): StateStore & {
  state: BatchState | null
} {
  const store = {
    path: '.sentra/batch-test.json',
    state: initial,
    read: () => store.state,
    write: (state: BatchState) => {
      store.state = state
    },
    clear: () => {
      store.state = null
    },
  }
  return store
}

function clock() {
  const sleeps: number[] = []
  let t = Date.parse('2026-11-27T10:00:00Z')
  return {
    sleeps,
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms)
      t += ms
      return Promise.resolve()
    },
  }
}

const run = (
  api: BatchTransport,
  store: StateStore,
  over: Partial<BatchRunDeps> = {},
): Promise<Awaited<ReturnType<typeof collectBatch>>> => {
  const time = clock()
  return collectBatch(plan, {
    transport: api,
    store,
    maxWaitMs: 60 * 60_000,
    admit: () => Promise.resolve(() => undefined),
    model: 'claude-opus-5-5',
    promptVersion: 'triage.v1',
    sleep: time.sleep,
    now: time.now,
    ...over,
  })
}

const promptOf = (outcome: BatchOutcome | undefined): unknown =>
  outcome?.type === 'succeeded' ? (outcome.response.raw as { prompt: string }).prompt : undefined

describe('submitting a batch', () => {
  it('submits every planned request once, under its cassette key', async () => {
    const api = fakeApi()
    await run(api, memoryStore())

    expect(api.submitted).toHaveLength(1)
    expect(api.submitted[0]?.map((e) => e.customId)).toEqual(
      plan.map((p) => cassetteKey(p.request)),
    )
    // The API's own constraint on a custom_id.
    for (const entry of api.submitted[0] ?? [])
      expect(entry.customId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  it('saves the batch id before reading a single result', async () => {
    const api = fakeApi()
    const store = memoryStore()
    let savedWhenRead: BatchState | null = null
    api.onResults = () => {
      savedWhenRead = store.state
    }
    await run(api, store)
    expect(savedWhenRead).toMatchObject({
      plan: planDigest(plan),
      batches: [{ id: 'msgbatch_1', requests: 4 }],
    })
  })

  it('puts every result on the request it answers, whatever order they arrive in', async () => {
    const { outcomes } = await run(fakeApi(), memoryStore())
    for (const p of plan)
      expect(promptOf(outcomes.get(customIdOf(p.request)))).toBe(p.request.prompt)
  })

  it('submits one entry for two identical requests, which the API requires', async () => {
    const api = fakeApi()
    const twice = [...plan, { label: 'fixture-0 again #0', request: request(0) }]
    await collectBatch(twice, {
      transport: api,
      store: memoryStore(),
      maxWaitMs: 60_000,
      admit: () => Promise.resolve(() => undefined),
      model: 'claude-opus-5-5',
      promptVersion: 'triage.v1',
      ...clock(),
    })
    expect(api.submitted[0]).toHaveLength(4)
  })

  it('polls with a growing backoff until the batch ends', async () => {
    const time = clock()
    await run(fakeApi(succeed, { pollsBeforeEnd: 3 }), memoryStore(), time)
    expect(time.sleeps).toEqual([POLL.firstMs, POLL.firstMs * 1.5, POLL.firstMs * 1.5 * 1.5])
  })

  it('waits out a failed poll rather than abandoning a batch that is still being paid for', async () => {
    const api = fakeApi(succeed, { pollFailures: 2 })
    const { outcomes } = await run(api, memoryStore())
    expect(outcomes.size).toBe(4)
  })

  it('submits nothing, and saves nothing, when the cap or the budget refuses it', async () => {
    const api = fakeApi()
    const store = memoryStore()
    await expect(
      run(api, store, { admit: () => Promise.reject(new Error('over the cap')) }),
    ).rejects.toThrow('over the cap')
    expect(api.submitted).toEqual([])
    expect(store.state).toBeNull()
  })

  it('releases what it admitted once the results are in', async () => {
    let released = 0
    await run(fakeApi(), memoryStore(), {
      admit: () =>
        Promise.resolve(() => {
          released += 1
        }),
    })
    expect(released).toBe(1)
  })
})

describe('a run that is interrupted, or outlives its wait', () => {
  it('stops at the wall-clock ceiling with the id saved, and says how to collect it', async () => {
    const api = fakeApi(succeed, { pollsBeforeEnd: Number.POSITIVE_INFINITY })
    const store = memoryStore()
    const time = clock()

    const error = await run(api, store, { ...time, maxWaitMs: 10 * 60_000 }).catch(
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(BatchStillRunningError)
    expect(String(error)).toMatch(/running the same command again collects it/)
    expect(store.state?.batches.map((b) => b.id)).toEqual(['msgbatch_1'])
    // Never sleeps past the ceiling.
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBe(10 * 60_000)
  })

  /** The whole point of saving the id: a second run collects, it does not pay again. */
  it('resumes from a saved batch id without submitting anything', async () => {
    const api = fakeApi(succeed, { pollsBeforeEnd: 2 })
    const store = memoryStore({
      version: 1,
      plan: planDigest(plan),
      model: 'claude-opus-5-5',
      promptVersion: 'triage.v1',
      batches: [{ id: 'msgbatch_saved', submittedAt: '2026-11-27T09:00:00.000Z', requests: 4 }],
    })

    const { outcomes, batches } = await run(api, store)

    expect(api.submitted).toEqual([])
    expect(new Set(api.polls)).toEqual(new Set(['msgbatch_saved']))
    expect(batches).toEqual(['msgbatch_saved'])
    for (const p of plan)
      expect(promptOf(outcomes.get(customIdOf(p.request)))).toBe(p.request.prompt)
  })

  it('refuses a saved batch that belongs to a different set of requests', async () => {
    const api = fakeApi()
    const store = memoryStore({
      version: 1,
      plan: 'something-else',
      model: 'claude-opus-5-5',
      promptVersion: 'triage.v0',
      batches: [{ id: 'msgbatch_old', submittedAt: '2026-11-20T09:00:00.000Z', requests: 9 }],
    })
    const error = await run(api, store).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BatchPlanMismatchError)
    expect(String(error)).toMatch(/msgbatch_old/)
    expect(String(error)).toMatch(/pays again/)
    expect(api.submitted).toEqual([])
  })

  it('keeps the saved state in a file, written whole', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sentra-batch-')), 'nested', 'batch-dev.json')
    const store = fileStore(path)
    expect(store.read()).toBeNull()
    const state: BatchState = {
      version: 1,
      plan: 'abc',
      model: 'claude-opus-5-5',
      promptVersion: 'triage.v1',
      batches: [{ id: 'msgbatch_1', submittedAt: '2026-11-27T10:00:00.000Z', requests: 4 }],
    }
    store.write(state)
    expect(store.read()).toEqual(state)
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
    store.clear()
    expect(store.read()).toBeNull()
  })

  it('refuses to guess at a saved state it cannot read, since it records money spent', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sentra-batch-')), 'batch-dev.json')
    writeFileSync(path, JSON.stringify({ version: 2, batches: 'msgbatch_1' }))
    expect(() => fileStore(path).read()).toThrow(/not a saved batch.*remove the file by hand/)
  })
})

describe('requests the API did not answer', () => {
  /**
   * Errored, expired and canceled entries are billed nothing and answer
   * nothing. Each is named with where it came from, the run stops, and the
   * next run resubmits exactly those — never the ones already answered.
   */
  it('names each one, keeps the answers, and resubmits only those on the next run', async () => {
    const firstTime: Script = (entry, batch) => {
      if (batch > 0) return succeed(entry, batch)
      switch (entry.request.prompt) {
        case 'failure number 1':
          return {
            type: 'errored',
            error: new TransportError('server', 'overloaded_error: Overloaded'),
          }
        case 'failure number 2':
          return { type: 'expired' }
        case 'failure number 3':
          return { type: 'canceled' }
        default:
          return succeed(entry, batch)
      }
    }
    const api = fakeApi(firstTime)
    const store = memoryStore()

    const error = await run(api, store).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BatchIncompleteError)
    const message = String(error)
    expect(message).toMatch(/3 of 4 request\(s\) have no answer/)
    expect(message).toMatch(/fixture-1 #0 +errored +overloaded_error: Overloaded/)
    expect(message).toMatch(/fixture-2 #0 +expired/)
    expect(message).toMatch(/fixture-3 #0 +canceled/)
    expect(message).not.toMatch(/fixture-0/)
    expect(message).toMatch(/resubmits only these/)

    const log: string[] = []
    const { outcomes } = await run(api, store, { log: (line) => log.push(line) })

    expect(api.submitted).toHaveLength(2)
    expect(api.submitted[1]?.map((e) => e.request.prompt)).toEqual([
      'failure number 1',
      'failure number 2',
      'failure number 3',
    ])
    expect(log.join('\n')).toMatch(/Resubmitting 3 request\(s\)/)
    for (const p of plan)
      expect(promptOf(outcomes.get(customIdOf(p.request)))).toBe(p.request.prompt)
    expect(store.state?.batches.map((b) => b.id)).toEqual(['msgbatch_1', 'msgbatch_2'])
  })

  it('stops without resubmitting when the API rejected a request it would reject again', async () => {
    const api = fakeApi((entry, batch) =>
      entry.request.prompt === 'failure number 2'
        ? {
            type: 'errored',
            error: new TransportError('client', 'invalid_request_error: bad schema'),
          }
        : succeed(entry, batch),
    )
    const store = memoryStore()

    const first = await run(api, store).catch((e: unknown) => e)
    expect(first).toBeInstanceOf(BatchIncompleteError)
    expect(String(first)).toMatch(
      /fixture-2 #0 +errored +invalid_request_error: bad schema \(not retryable\)/,
    )
    expect(String(first)).toMatch(/would reject again/)

    await expect(run(api, store)).rejects.toBeInstanceOf(BatchIncompleteError)
    expect(api.submitted).toHaveLength(1)
  })

  /**
   * A refusal is the model's answer, billed like one. The synchronous path
   * does not retry it, so neither does this: it is collected, and the run
   * reading it back fails on it exactly where a synchronous run would.
   */
  it('collects a refusal as an answer rather than resubmitting it', async () => {
    const refusal = new TransportError('refusal', 'declined', 200, undefined, {
      model: 'claude-opus-5-5',
      usage: { inputTokens: 1_000, outputTokens: 3 },
      tier: 'batch',
    })
    const api = fakeApi((entry, batch) =>
      entry.request.prompt === 'failure number 0'
        ? { type: 'unusable', error: refusal }
        : succeed(entry, batch),
    )
    const { outcomes } = await run(api, memoryStore())
    expect(outcomes.get(customIdOf(request(0)))).toEqual({ type: 'unusable', error: refusal })
    expect(api.submitted).toHaveLength(1)
  })
})

describe('reading the results back', () => {
  const outcomes = new Map<string, BatchOutcome>([
    [customIdOf(request(0)), { type: 'succeeded', response: answerTo(request(0)) }],
    [
      customIdOf(request(1)),
      {
        type: 'unusable',
        error: new TransportError(
          'server',
          'the response carried no text block to parse',
          undefined,
          undefined,
          {
            model: 'claude-opus-5-5',
            usage: { inputTokens: 900, outputTokens: 10 },
            tier: 'batch',
          },
        ),
      },
    ],
    [customIdOf(request(2)), { type: 'expired' }],
  ])

  function liveFake(): Transport & { sent: ModelRequest[] } {
    const sent: ModelRequest[] = []
    return {
      sent,
      countInputTokens: () => Promise.resolve(77),
      send: (r) => {
        sent.push(r)
        return Promise.resolve({
          raw: { live: true },
          stopReason: 'end_turn',
          model: r.model,
          usage: { inputTokens: 77, outputTokens: 20 },
        })
      },
    }
  }

  it('answers a planned request from its result, with the billed input as its count', async () => {
    const live = liveFake()
    const transport = new BatchResultsTransport(outcomes, live)
    await expect(transport.countInputTokens(request(0))).resolves.toBe(1_000)
    await expect(transport.send(request(0))).resolves.toEqual(answerTo(request(0)))
    // Served as often as asked: two identical requests share one result.
    await expect(transport.send(request(0))).resolves.toEqual(answerTo(request(0)))
    expect(live.sent).toEqual([])
  })

  it('fails an unusable result with the error a synchronous send would throw, bill attached', async () => {
    const transport = new BatchResultsTransport(outcomes, liveFake())
    await expect(transport.countInputTokens(request(1))).resolves.toBe(900)
    const error = (await transport.send(request(1)).catch((e: unknown) => e)) as TransportError
    expect(error.kind).toBe('server')
    expect(error.response?.tier).toBe('batch')
  })

  /** The synchronous path re-sends an unreadable reply as a fresh request. So does this. */
  it('sends a re-send of an unreadable reply to the network, as a new request', async () => {
    const live = liveFake()
    const transport = new BatchResultsTransport(outcomes, live)
    await transport.send(request(1)).catch(() => undefined)
    await expect(transport.send(request(1))).resolves.toMatchObject({ raw: { live: true } })
    await expect(transport.countInputTokens(request(1))).resolves.toBe(77)
    expect(live.sent).toHaveLength(1)
  })

  /** A schema correction carries the first answer in its prompt, so no batch could have held it. */
  it('sends a request the batch never carried to the network', async () => {
    const live = liveFake()
    const transport = new BatchResultsTransport(outcomes, live)
    await expect(transport.send(request(9))).resolves.toMatchObject({ raw: { live: true } })
    await expect(transport.countInputTokens(request(9))).resolves.toBe(77)
  })

  it('refuses a planned request with no answer, rather than paying for it synchronously', async () => {
    const live = liveFake()
    const transport = new BatchResultsTransport(outcomes, live)
    await expect(transport.send(request(2))).rejects.toThrow(/has no answer/)
    expect(live.sent).toEqual([])
  })

  it('prices what the results were billed at the batch rate, refusals included', () => {
    // 1,000 in and 200 out at $2/$10, plus 900 in and 10 out.
    expect(billedUsd(outcomes.values())).toBeCloseTo(0.004 + 0.0019, 10)
    expect(
      billedUsd([
        {
          type: 'succeeded',
          response: { ...answerTo(request(0)), model: 'claude-future-9' },
        },
      ]),
    ).toBeNull()
  })
})
