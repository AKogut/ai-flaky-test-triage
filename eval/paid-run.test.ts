import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AnthropicTransport,
  CassetteTransport,
  customIdOf,
  MODEL_CONFIG,
  TransportError,
  type BatchEntry,
  type BatchResult,
  type BatchState,
  type BatchStatus,
  type BatchTransport,
  type Cassette,
  type ModelRequest,
  type ModelResponse,
  type StateStore,
  type Transport,
} from '@sentra/agents'
import type * as Agents from '@sentra/agents'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unreachable } from './classifier.js'
import {
  estimate,
  NeedsCredentialsError,
  planRun,
  prepareBatch,
  renderEstimate,
  runEstimate,
  type PaidRunDeps,
} from './paid-run.js'
import {
  costLine,
  DEFAULTS,
  evaluate,
  main,
  parseArgs,
  renderReport,
  UsageError,
} from './run-eval.js'

/**
 * The runs that cost money, run for free.
 *
 * Every model here is a fake, and so is every batch API. That is not only
 * convenience: there is no key on any machine this runs on, and a test that
 * could reach the network would be a test that could spend. So the one class
 * that builds a real client is replaced for this file with one that counts its
 * constructions and refuses to work, and the suite ends by asserting the count
 * is zero.
 */

const constructed = vi.hoisted(() => ({ count: 0 }))
vi.mock('@sentra/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof Agents>()
  return {
    ...actual,
    AnthropicTransport: class {
      constructor() {
        constructed.count += 1
        throw new Error('a test constructed the live transport')
      }
    },
  }
})

afterAll(() => {
  expect(constructed.count).toBe(0)
})

/** The guard itself, so a mock that silently stopped applying cannot pass the check above vacuously. */
it('cannot build the live transport in this file', () => {
  expect(() => new AnthropicTransport()).toThrow('a test constructed the live transport')
  constructed.count -= 1
})

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

const RECORD = { SENTRA_RECORD: '1' }
const LIVE = { SENTRA_LIVE: '1' }
const REPLAY = { SENTRA_REPLAY: '1' }

const agent = (over: Partial<typeof DEFAULTS> = {}) => ({
  ...DEFAULTS,
  classifier: 'agent' as const,
  samples: 1,
  ...over,
})

const scratch = (): string => mkdtempSync(join(tmpdir(), 'sentra-paid-'))

// ---------------------------------------------------------------------------
// A fake model, and a fake batch API in front of it
// ---------------------------------------------------------------------------

/** The one request this model answers badly, to make the run take a schema correction. */
let malformedFor: string | null = null

/**
 * A model that answers from the request alone, so the same request gets the
 * same answer however it reaches it — the property a byte-for-byte comparison
 * of two recordings needs.
 */
function answer(request: ModelRequest): ModelResponse {
  const owners = ['app_code', 'test_code', 'environment'] as const
  const pick = (request.prompt.length + (request.sample ?? 0)) % 3
  const raw =
    request.prompt === malformedFor
      ? { owner: 'nobody' }
      : {
          owner: owners[pick] ?? 'app_code',
          determinism: pick === 0 ? 'intermittent' : 'deterministic',
          confidence: 0.5 + pick / 10,
          reasoning: `prompt of ${String(request.prompt.length)} characters`,
          evidence: ['status: failed'],
        }
  return {
    raw,
    stopReason: 'end_turn',
    model: request.model,
    usage: { inputTokens: counted(request), outputTokens: 300 + (request.sample ?? 0) },
  }
}

const counted = (request: ModelRequest): number => 1_000 + (request.prompt.length % 100)

type Outcome = (entry: BatchEntry, batch: number) => BatchResult['outcome']

const succeeded: Outcome = (entry) => ({
  type: 'succeeded',
  response: { ...answer(entry.request), tier: 'batch' },
})

function fakeApi(outcome: Outcome = succeeded): Transport &
  BatchTransport & {
    sent: ModelRequest[]
    counts: number
    submitted: BatchEntry[][]
    running: boolean
  } {
  const submitted: BatchEntry[][] = []
  const sent: ModelRequest[] = []
  const api = {
    sent,
    submitted,
    counts: 0,
    /** Whether a poll finds the batch still going. */
    running: false,
    countInputTokens: (request: ModelRequest) => {
      api.counts += 1
      return Promise.resolve(counted(request))
    },
    send: (request: ModelRequest) => {
      sent.push(request)
      return Promise.resolve(answer(request))
    },
    submitBatch: (entries: readonly BatchEntry[]): Promise<BatchStatus> => {
      submitted.push([...entries])
      return Promise.resolve(status(`msgbatch_${String(submitted.length)}`, 'in_progress'))
    },
    retrieveBatch: (id: string) =>
      Promise.resolve(status(id, api.running ? 'in_progress' : 'ended')),
    async *batchResults(id: string): AsyncGenerator<BatchResult> {
      const index = Number(id.replace('msgbatch_', '')) - 1
      // Shuffled: results come back in any order, and are matched by custom_id.
      const entries = [...(submitted[index] ?? [])]
      const shuffled = [
        ...entries.filter((_, i) => i % 2 === 1),
        ...entries.filter((_, i) => i % 2 === 0),
      ]
      for (const entry of shuffled) {
        yield await Promise.resolve({ customId: entry.customId, outcome: outcome(entry, index) })
      }
    },
  }
  return api
}

const status = (id: string, processing: BatchStatus['processing']): BatchStatus => ({
  id,
  processing,
  counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
  expiresAt: '2026-11-28T10:00:00Z',
})

function memoryStore(): StateStore & { state: BatchState | null } {
  const store = {
    path: '.sentra/batch-dev.json',
    state: null as BatchState | null,
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

const deps = (api: ReturnType<typeof fakeApi>, over: PaidRunDeps = {}): PaidRunDeps => ({
  env: RECORD,
  connect: () => api,
  cassettes: () => [],
  // Never the committed directory: a recording test must not leave files in the repository.
  cassetteDir: scratch(),
  store: memoryStore(),
  sleep: () => Promise.resolve(),
  log: () => undefined,
  ...over,
})

const cassetteFiles = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((file) => [file, readFileSync(join(dir, file), 'utf8')]),
  )

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('what a run would send', () => {
  /**
   * The plan is what gets batched and what gets estimated. If it drifted from
   * what `evaluate` asks for, the batch would carry requests nobody makes and
   * the real ones would be paid for at twice the price.
   */
  it('is exactly the requests evaluate makes, in its order', async () => {
    const api = fakeApi()
    const options = agent({ samples: 2 })
    await evaluate(options, { env: REPLAY, transport: api })
    expect(planRun(options).map((p) => customIdOf(p.request))).toEqual(api.sent.map(customIdOf))
  })

  it('labels each request with its fixture and sample, for the report', () => {
    const [first] = planRun(agent({ samples: 2 }))
    expect(first?.label).toMatch(/^[a-z0-9-]+ #0$/)
  })

  it('reads only the slice it scores', () => {
    const dev = planRun(agent()).map((p) => p.label)
    const holdout = planRun(agent({ slice: 'holdout' })).map((p) => p.label)
    expect(dev.filter((label) => holdout.includes(label))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

const two: ModelRequest[] = planRun(agent())
  .slice(0, 2)
  .map((p) => p.request)

const recorded = (outputTokens: number): Cassette =>
  ({
    promptVersion: two[0]?.promptVersion ?? '',
    model: MODEL_CONFIG.model,
    response: { usage: { inputTokens: 1, outputTokens } },
  }) as unknown as Cassette

describe('the estimate', () => {
  it('counts every request and prices the worst case at max_tokens, synchronous and batched', async () => {
    const figures = await estimate(two, { count: () => Promise.resolve(1_000), cassettes: [] })

    expect(figures.requests).toBe(2)
    expect(figures.inputTokens).toBe(2_000)
    expect(figures.maxTokens).toBe(MODEL_CONFIG.maxTokens)
    // Each: 1,000 in at $4/M and 8,000 out at $20/M — then half that, batched.
    expect(figures.usd.standard.worst).toBeCloseTo(2 * 0.164, 10)
    expect(figures.usd.batch.worst).toBeCloseTo(0.164, 10)
    // No recording to take an average from, so no expected case: absent, not invented.
    expect(figures.observed).toBeNull()
    expect(figures.usd.standard.expected).toBeNull()
  })

  it('takes the expected output from what recorded runs of this prompt produced', async () => {
    const figures = await estimate(two, {
      count: () => Promise.resolve(1_000),
      cassettes: [recorded(400), recorded(600), { ...recorded(9_999), model: 'claude-opus-4-8' }],
    })
    expect(figures.observed).toEqual({ cassettes: 2, meanOutputTokens: 500 })
    // Each: 1,000 in at $4/M and 500 out at $20/M.
    expect(figures.usd.standard.expected).toBeCloseTo(2 * 0.014, 10)
    expect(figures.usd.batch.expected).toBeCloseTo(0.014, 10)
  })

  it('waits out a rate limit on count_tokens, as a dispatch would', async () => {
    let calls = 0
    const figures = await estimate(two, {
      count: () => {
        calls += 1
        return calls === 1
          ? Promise.reject(new TransportError('rate-limit', 'slow down', 429))
          : Promise.resolve(10)
      },
      cassettes: [],
      sleep: () => Promise.resolve(),
    })
    expect(figures.inputTokens).toBe(20)
  })

  it('refuses to estimate a model with no price rather than calling it free', async () => {
    const unpriced = two.map((r) => ({ ...r, model: 'claude-future-9' }))
    await expect(
      estimate(unpriced, { count: () => Promise.resolve(1), cassettes: [] }),
    ).rejects.toThrow(/no price for claude-future-9/)
  })

  it('reads as a table a person can act on', async () => {
    const figures = await estimate(two, {
      count: () => Promise.resolve(1_000),
      cassettes: [recorded(400), recorded(600)],
    })
    const text = renderEstimate(figures, {
      heading: 'Estimate for --classifier=agent --slice=dev --n=1.',
      composition: '2 fixtures × 1 samples',
      maxUsd: 0.2,
      budget: 1_500,
    })
    expect(text).toContain('Nothing has been sent to the model.')
    expect(text).toMatch(/input tokens +2,000, counted by count_tokens/)
    expect(text).toMatch(/expected: 500 a request, the mean over 2 recorded cassette/)
    expect(text).toMatch(/worst case: 8,000 a request, every request at max_tokens/)
    expect(text).toMatch(/synchronous +\$0\.0280 +\$0\.3280/)
    expect(text).toMatch(/Message Batch +\$0\.0140 +\$0\.1640/)
    expect(text).toMatch(/The run would stop part-way; raise it to at least 2,000/)
    expect(text).toMatch(
      /Under --max-usd=0\.2: Message Batch fits \(worst case \$0\.1640\), synchronous refused/,
    )
  })

  it('fails fast without credentials, with no fallback guess and no client built', async () => {
    await expect(runEstimate(agent(), { env: {} })).rejects.toBeInstanceOf(NeedsCredentialsError)
    await expect(
      runEstimate(agent(), { env: { ...REPLAY, ANTHROPIC_API_KEY: 'x' } }),
    ).rejects.toThrow(/no fallback/)
  })

  it('exits non-zero from the command line without credentials', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    const connect = vi.fn()
    expect(await main(['--classifier=agent', '--estimate'], { env: {}, connect })).toBe(1)
    expect(connect).not.toHaveBeenCalled()
    expect(errors.join('\n')).toMatch(/No estimate/)
    expect(errors.join('\n')).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('counts every planned request and sends none of them', async () => {
    const api = fakeApi()
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      lines.push(String(m))
    })
    const code = await main(['--classifier=agent', '--estimate', '--n=2'], {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      connect: () => api,
      cassettes: () => [],
    })
    expect(code).toBe(0)
    expect(api.counts).toBe(planRun(agent({ samples: 2 })).length)
    expect(api.sent).toEqual([])
    expect(api.submitted).toEqual([])
    expect(lines.join('\n')).toMatch(/Estimate for --classifier=agent --slice=dev --n=2\./)
  })
})

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

describe('a batched run', { timeout: 60_000 }, () => {
  afterEach(() => {
    malformedFor = null
  })

  /**
   * The property the whole design is for: cassettes recorded through a batch
   * are the files a synchronous recording writes, so a replay of either is the
   * same report, byte for byte. One fixture's first answer is malformed, so
   * the comparison covers a schema correction too — the request no batch can
   * carry, which goes out synchronously and is recorded the same way.
   */
  it('records exactly what a synchronous run records, and replays to the same report', async () => {
    const options = agent({ samples: 2 })
    malformedFor = planRun(options)[3]?.request.prompt ?? null

    const synchronousDir = scratch()
    const synchronous = fakeApi()
    await evaluate(options, {
      env: RECORD,
      transport: new CassetteTransport(synchronous, { mode: 'record', dir: synchronousDir }),
    })

    const batchedDir = scratch()
    const batched = fakeApi()
    const store = memoryStore()
    const prepared = await prepareBatch(options, deps(batched, { cassetteDir: batchedDir, store }))
    const evaluation = await evaluate(options, {
      env: RECORD,
      transport: prepared.transport,
      ledger: prepared.ledger,
    })
    prepared.settle()

    const planned = planRun(options).length
    // Both samples of that fixture share its prompt, so both need correcting.
    const corrections = planRun(options).filter((p) => p.request.prompt === malformedFor).length
    expect(corrections).toBe(2)
    expect(batched.submitted).toHaveLength(1)
    expect(batched.submitted[0]).toHaveLength(planned)
    // The corrections, and nothing else, went out synchronously.
    expect(batched.sent).toHaveLength(corrections)
    expect(batched.sent.every((r) => r.prompt.includes('did not match the required schema'))).toBe(
      true,
    )
    expect(synchronous.sent).toHaveLength(planned + corrections)

    expect(cassetteFiles(batchedDir)).toEqual(cassetteFiles(synchronousDir))

    const replay = async (dir: string) =>
      renderReport(
        await evaluate(options, {
          env: REPLAY,
          transport: new CassetteTransport(unreachable(), { mode: 'replay', dir }),
        }),
      )
    expect(await replay(batchedDir)).toBe(await replay(synchronousDir))

    // Paid at the batch rate, and said so; the saved id is gone once scored.
    expect(evaluation.cost.batched).toBe(planned)
    expect(evaluation.cost.dispatches).toBe(planned + corrections)
    expect(evaluation.cost.usd).toBeLessThan(evaluation.cost.atStandardRate)
    expect(renderReport(evaluation)).toContain('**Sent as a Message Batch**')
    expect(renderReport(evaluation)).toMatch(/requests at the Message Batches rate +\| +\d+ of \d+/)
    expect(costLine(evaluation)).toMatch(/of them at the Message Batches rate/)
    expect(store.state).toBeNull()
  })

  it('prices the batch at half what the same answers cost synchronously', async () => {
    const options = agent()
    const synchronous = await evaluate(options, { env: LIVE, transport: fakeApi() })
    const prepared = await prepareBatch(options, deps(fakeApi(), { env: LIVE }))
    const batched = await evaluate(options, {
      env: LIVE,
      transport: prepared.transport,
      ledger: prepared.ledger,
    })
    expect(batched.cost.usd).toBeCloseTo(synchronous.cost.usd / 2, 10)
    expect(batched.cost.atStandardRate).toBeCloseTo(synchronous.cost.usd, 10)
  })

  it('names every request the API did not answer, by fixture and sample, and writes nothing', async () => {
    const options = agent()
    const [, second, third] = planRun(options)
    const api = fakeApi((entry, batch) =>
      entry.request.prompt === second?.request.prompt
        ? { type: 'errored', error: new TransportError('server', 'overloaded_error: Overloaded') }
        : entry.request.prompt === third?.request.prompt
          ? { type: 'expired' }
          : succeeded(entry, batch),
    )
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    const out = join(scratch(), 'report.md')
    const store = memoryStore()

    expect(
      await main(['--classifier=agent', '--batch', '--n=1', `--out=${out}`], deps(api, { store })),
    ).toBe(1)

    const message = errors.join('\n')
    expect(message).toMatch(/2 of \d+ request\(s\) have no answer/)
    expect(message).toContain(second?.label ?? '?')
    expect(message).toContain(third?.label ?? '?')
    expect(existsSync(out)).toBe(false)
    // Saved, so the next run collects what was answered and resubmits only these.
    expect(store.state?.batches).toHaveLength(1)
  })

  /**
   * The resume story, from the command line. The first run outlives its wait
   * and stops with the id saved; the second collects that batch — it does not
   * submit another — and finishes the run.
   */
  it('leaves a batch it outwaited saved, and the next run collects it instead of paying again', async () => {
    const api = fakeApi()
    api.running = true
    const store = memoryStore()
    let t = 0
    const clock = {
      now: () => t,
      sleep: (ms: number) => {
        t += ms
        return Promise.resolve()
      },
    }
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    const out = join(scratch(), 'report.md')
    const argv = ['--classifier=agent', '--batch', '--n=1', '--wait=5', `--out=${out}`]

    expect(await main(argv, deps(api, { env: LIVE, store, ...clock }))).toBe(1)
    expect(errors.join('\n')).toMatch(/still in_progress after 5 min/)
    expect(errors.join('\n')).toMatch(/pass --wait=<minutes> \(this run waited 5\)/)
    expect(store.state?.batches.map((b) => b.id)).toEqual(['msgbatch_1'])
    expect(existsSync(out)).toBe(false)

    api.running = false
    expect(await main(argv, deps(api, { env: LIVE, store, ...clock }))).toBe(0)
    expect(api.submitted).toHaveLength(1)
    expect(existsSync(out)).toBe(true)
    // Scored, so the saved id has done its job.
    expect(store.state).toBeNull()
  })

  it('refuses to run in replay, where there is nothing to batch', async () => {
    await expect(prepareBatch(agent(), deps(fakeApi(), { env: REPLAY }))).rejects.toThrow(
      /drop --batch to replay/,
    )
  })
})

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

describe('--max-usd', { timeout: 60_000 }, () => {
  it('refuses to submit a batch whose worst case does not fit, and spends nothing', async () => {
    const api = fakeApi()
    const store = memoryStore()
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    const out = join(scratch(), 'report.md')

    const code = await main(
      ['--classifier=agent', '--batch', '--n=1', '--max-usd=0.5', `--out=${out}`],
      deps(api, { store }),
    )

    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/a batch of \d+ request\(s\) could cost up to \$\d+\.\d{4}/)
    expect(api.submitted).toEqual([])
    expect(store.state).toBeNull()
    expect(existsSync(out)).toBe(false)
  })

  it('submits a batch that fits', async () => {
    const api = fakeApi()
    const out = join(scratch(), 'report.md')
    const code = await main(
      ['--classifier=agent', '--batch', '--n=1', '--max-usd=100', `--out=${out}`],
      deps(api, { env: LIVE }),
    )
    expect(code).toBe(0)
    expect(api.submitted).toHaveLength(1)
    expect(readFileSync(out, 'utf8')).toContain('Sent as a Message Batch')
  })

  it('refuses to start a synchronous run whose worst case does not fit', async () => {
    const api = fakeApi()
    const out = join(scratch(), 'report.md')
    const code = await main(
      ['--classifier=agent', '--n=1', '--max-usd=0.5', `--out=${out}`],
      deps(api, { env: LIVE }),
    )
    expect(code).toBe(1)
    expect(api.sent).toEqual([])
    expect(existsSync(out)).toBe(false)
  })

  it('runs a synchronous run that fits, every request through the cap', async () => {
    const api = fakeApi()
    const out = join(scratch(), 'report.md')
    const code = await main(
      ['--classifier=agent', '--n=1', '--max-usd=100', `--out=${out}`],
      deps(api, { env: LIVE }),
    )
    expect(code).toBe(0)
    expect(api.sent).toHaveLength(planRun(agent()).length)
  })

  it('refuses a run the token budget would stop part-way, before anything is sent', async () => {
    const api = fakeApi()
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m))
    })
    const code = await main(
      ['--classifier=agent', '--batch', '--n=1', `--out=${join(scratch(), 'r.md')}`],
      deps(api, { env: { ...LIVE, SENTRA_TOKEN_BUDGET: '1000' } }),
    )
    expect(code).toBe(1)
    expect(errors.join('\n')).toMatch(/Raise SENTRA_TOKEN_BUDGET to at least/)
    expect(api.submitted).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The flags
// ---------------------------------------------------------------------------

describe('the flags', () => {
  it('parses them', () => {
    expect(
      parseArgs(['--classifier=agent', '--batch', '--max-usd=12.5', '--wait=90']),
    ).toMatchObject({ batch: true, maxUsd: 12.5, waitMinutes: 90, estimate: false })
    expect(parseArgs(['--classifier=agent', '--estimate'])).toMatchObject({ estimate: true })
    expect(parseArgs([])).toMatchObject({
      batch: false,
      estimate: false,
      maxUsd: null,
      waitMinutes: 60,
    })
  })

  it.each([
    [['--batch'], /only mean something with --classifier=agent/],
    [['--estimate'], /only mean something with --classifier=agent/],
    [['--max-usd=5'], /only mean something with --classifier=agent/],
    [['--classifier=agent', '--batch', '--gate'], /cannot be combined with --gate/],
    [['--classifier=agent', '--wait=5'], /means nothing without it/],
    [['--classifier=agent', '--max-usd=0'], /above 0/],
    [['--classifier=agent', '--max-usd=ten'], /above 0/],
    [['--classifier=agent', '--max-usd='], /above 0/],
    [['--classifier=agent', '--batch', '--wait=0'], /whole number/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError)
    expect(() => parseArgs(argv)).toThrow(message)
  })
})
