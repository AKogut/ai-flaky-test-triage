import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { main } from '../../agents/run.js'
import type { ModelRequest, ModelResponse, Transport } from '../../agents/transport.js'

/**
 * `agents/run.ts`, end to end, against committed fixtures.
 *
 * The unit tests cover each agent. This covers the wiring between them, which is
 * where the interesting bugs live — ordering, budget accounting, threshold
 * gating, partial failure — and it is the whole of M7's exit criterion.
 *
 * **No network, no key, no cost.** Not by policy but by construction: the
 * transport handed in throws on any call it was not scripted for, and a second
 * test hands in one that throws on *every* call, so a code path that reached out
 * would fail rather than quietly work on somebody's machine and not in CI.
 *
 * It is not cassette replay. #70 asks for replay mode, and replay needs recorded
 * cassettes, which need live model calls that this environment cannot make —
 * see the note at the end of the pull request. Everything replay would buy here
 * except the recorded responses themselves is bought by a scripted transport:
 * determinism, zero cost, and a run that cannot touch the network.
 */

vi.setConfig({ testTimeout: 15_000 })

const root = new URL('../..', import.meta.url).pathname
const fixture = (name: string): string =>
  readFileSync(join(root, `tests/fixtures/pipeline/${name}.analysis.json`), 'utf8')

const CLASSIFICATION = {
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.91,
  reasoning: 'the diff changes the reducer the failing assertion reads',
  evidence: ['expected 1 to equal 2'],
}

/** Answers triage; refuses anything else, so an unexpected call is a failure and not a default. */
const scripted = (
  reply: unknown = CLASSIFICATION,
  fail?: (n: number) => Error | undefined,
): Transport & { calls: number } => {
  const transport = {
    calls: 0,
    countInputTokens: () => Promise.resolve(1_000),
    send: (request: ModelRequest): Promise<ModelResponse> => {
      transport.calls += 1
      const failure = fail?.(transport.calls)
      if (failure !== undefined) return Promise.reject(failure)
      if (request.schemaName !== 'classification') {
        return Promise.reject(new Error(`unscripted call: ${request.schemaName}`))
      }
      return Promise.resolve({
        raw: reply,
        stopReason: 'end_turn' as const,
        model: 'claude-opus-5',
        usage: { inputTokens: 1_000, outputTokens: 200 },
      })
    },
  }
  return transport
}

interface Run {
  code: number
  report: string | undefined
  files: string[]
  calls: number
}

const run = async (
  name: string,
  over: { transport?: Transport & { calls: number }; argv?: string[] } = {},
): Promise<Run> => {
  const transport = over.transport ?? scripted()
  const written: Record<string, string> = {}
  const code = await main(over.argv ?? [], {
    env: { ANTHROPIC_API_KEY: 'test' },
    read: (p) => (p === 'analysis.json' ? fixture(name) : ''),
    exists: (p) => p === 'analysis.json',
    write: (p, contents) => {
      written[p] = contents
    },
    log: () => undefined,
    cassetteCount: () => 0,
    transport,
  })
  return { code, report: written['report.md'], files: Object.keys(written), calls: transport.calls }
}

describe('a run with nothing wrong', () => {
  it('makes no calls, writes no file, and exits 0', async () => {
    const result = await run('green')
    expect(result).toMatchObject({ code: 0, calls: 0, files: [] })
    expect(result.report).toBeUndefined()
  })
})

describe('a run with one failure', () => {
  it('classifies exactly the failure, not the passing test beside it', async () => {
    const result = await run('one-failure')
    expect(result.code).toBe(0)
    expect(result.calls).toBe(1)
    expect(result.report).toContain('board › case 1')
    expect(result.report).not.toContain('board › case 2')
  })

  it('reports the quadrant it was told', async () => {
    expect((await run('one-failure')).report).toContain('**app_code+intermittent** 1')
  })

  it('writes exactly one file', async () => {
    expect((await run('one-failure')).files).toEqual(['report.md'])
  })

  it('carries the header, the table and the footer', async () => {
    const report = (await run('one-failure')).report ?? ''
    expect(report).toContain('## Flaky-test triage')
    expect(report).toContain('| Test | Quadrant | Confidence | Reason |')
    expect(report).toContain('has not been scored yet')
  })
})

describe('a run with many failures', () => {
  /**
   * Eleven, not the nine that failed. `selectForTriage` also picks a test that
   * passed while it is still alternating with a live failure streak — which is
   * the point of the clause, and a fixture that avoided it would be testing a
   * narrower pipeline than the real one.
   */
  it('classifies every one of them', async () => {
    const result = await run('many-failures')
    expect(result.code).toBe(0)
    expect(result.calls).toBe(11)
    expect(result.report).toContain('**app_code+intermittent** 11')
  })

  /**
   * Deterministic ordering regardless of completion order, which is what makes a
   * report worth reading twice. Two runs of the same fixture are byte-identical.
   */
  it('produces the same document twice', async () => {
    const [a, b] = await Promise.all([run('many-failures'), run('many-failures')])
    expect(a.report).toBe(b.report)
  })
})

describe('a run that exhausts its budget', () => {
  it('still writes a report, and says which tests were never reached', async () => {
    const result = await run('many-failures', { argv: ['--budget', '3000'] })
    expect(result.code).toBe(0)
    expect(result.report).toContain('unclassified')
    expect(result.report).toContain('never reached')
  })

  it('stops calling once the budget refuses', async () => {
    const result = await run('many-failures', { argv: ['--budget', '3000'] })
    expect(result.calls).toBeLessThan(9)
  })
})

describe('a run where a call fails part-way through', () => {
  /**
   * The pipeline analyses CI failures; being unavailable exactly when CI is
   * unhealthy would be a poor joke.
   */
  it('delivers every other classification and one honest gap', async () => {
    const result = await run('many-failures', {
      transport: scripted(CLASSIFICATION, (n) =>
        n === 4 ? new Error('429 rate limited') : undefined,
      ),
    })
    expect(result.code).toBe(0)
    expect(result.report).toContain('429 rate limited')
    expect(result.report).toContain('**app_code+intermittent** 10')
  })
})

describe('no network, by construction', () => {
  /**
   * Stronger than "no network call occurred": a transport that throws on every
   * call means a code path that reached out would fail here rather than working
   * quietly on somebody's machine and not in CI.
   */
  it('a transport that refuses everything still produces a report and exit 0', async () => {
    const refusing = scripted(CLASSIFICATION, () => new Error('no network in this test'))
    const result = await run('many-failures', { transport: refusing })
    expect(result.code).toBe(0)
    expect(result.files).toEqual(['report.md'])
    expect(result.report).toContain('no network in this test')
  })
})
