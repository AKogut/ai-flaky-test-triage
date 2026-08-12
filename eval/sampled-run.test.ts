import type { ModelRequest, ModelResponse, Transport } from '@sentra/agents'
import { describe, expect, it } from 'vitest'
import { DEFAULTS, DEFAULT_SAMPLES, evaluate, parseArgs, renderReport } from './run-eval.js'

/**
 * A sampled agent run, end to end, with no network and no cassettes.
 *
 * The unit tests around `consistency.ts` check the arithmetic. This checks the
 * thing that arithmetic is for: that a classifier which answers differently on
 * different samples produces a report saying so, and that the sample index
 * actually reaches the transport — because if it does not, every sample of a
 * fixture hashes to one cassette, replay hands back one answer five times, and
 * the harness reports perfect stability for a classifier nobody measured.
 */

const OWNERS = ['app_code', 'test_code', 'environment'] as const

/** Answers by sample index, so instability is scripted rather than hoped for. */
function flipping(byIndex: (sample: number) => string): Transport & { samples: number[] } {
  const samples: number[] = []
  return {
    samples,
    countInputTokens: () => Promise.resolve(100),
    send: (request: ModelRequest): Promise<ModelResponse> => {
      const sample = request.sample ?? 0
      samples.push(sample)
      return Promise.resolve({
        raw: {
          owner: byIndex(sample),
          determinism: 'intermittent',
          confidence: 0.5,
          reasoning: `sample ${String(sample)}`,
          evidence: ['status: failed'],
        },
        stopReason: 'end_turn',
        model: 'claude-opus-5',
        usage: { inputTokens: 100, outputTokens: 40 },
      })
    },
  }
}

const agent = { ...DEFAULTS, classifier: 'agent' as const, samples: 3 }
const replay = { SENTRA_REPLAY: '1' }

describe('a sampled run', () => {
  it('asks the transport for each sample index in turn', async () => {
    const transport = flipping(() => 'app_code')
    await evaluate(agent, { env: replay, transport })
    expect(new Set(transport.samples)).toEqual(new Set([0, 1, 2]))
  })

  it('reports perfect stability when the classifier does not move', async () => {
    const evaluation = await evaluate(agent, { env: replay, transport: flipping(() => 'app_code') })
    expect(evaluation.sampling.selfConsistency).toBe(1)
    expect(evaluation.sampling.sdJoint).toBe(0)
    expect(evaluation.sampling.unstable).toEqual([])
  })

  it('reports every fixture as unstable when it flips on every sample', async () => {
    const evaluation = await evaluate(agent, {
      env: replay,
      transport: flipping((sample) => OWNERS[sample % 3] ?? 'app_code'),
    })
    expect(evaluation.sampling.selfConsistency).toBeCloseTo(1 / 3)
    expect(evaluation.sampling.unstable).toHaveLength(evaluation.metrics.n)
  })

  it('names the fixtures that flipped, with the labels they gave', async () => {
    const evaluation = await evaluate(agent, {
      env: replay,
      transport: flipping((sample) => (sample === 1 ? 'test_code' : 'app_code')),
    })
    const report = renderReport(evaluation)
    expect(report).toContain('## Stability')
    expect(report).toContain('`app_code/intermittent ×2`')
    expect(report).toContain('`test_code/intermittent ×1`')
    expect(report).toContain('66.7%')
  })

  /**
   * The headline is the consensus; the single-run mean is what one pull-request
   * comment gets. When they differ, both are on the page — a report that showed
   * only the first would be quoting the accuracy of an ensemble nobody ships.
   */
  it('separates the consensus number from what a single run gets', async () => {
    const evaluation = await evaluate(agent, {
      env: replay,
      transport: flipping((sample) => (sample === 1 ? 'test_code' : 'app_code')),
    })
    expect(evaluation.sampling.meanJoint).toBeLessThan(evaluation.metrics.joint.point)
    expect(renderReport(evaluation)).toContain('what one comment gets')
  })

  it('costs what the tokens say it costs', async () => {
    const evaluation = await evaluate(agent, { env: replay, transport: flipping(() => 'app_code') })
    const calls = evaluation.fixtures.length * 3

    expect(evaluation.cost.inputTokens).toBe(calls * 100)
    expect(evaluation.cost.outputTokens).toBe(calls * 40)
    // 100 in at $5/M plus 40 out at $25/M is $0.0015 a call.
    expect(evaluation.cost.usd).toBeCloseTo(calls * 0.0015, 6)
    expect(renderReport(evaluation)).toContain('projected, 50-failure CI run')
  })
})

describe('how many samples a run takes by default', () => {
  it('is five for the agent, because one run cannot tell a change from noise', () => {
    expect(parseArgs(['--classifier=agent']).samples).toBe(DEFAULT_SAMPLES.agent)
    expect(DEFAULT_SAMPLES.agent).toBe(5)
  })

  it('is one for the baseline, which is a pure function', () => {
    expect(parseArgs([]).samples).toBe(1)
  })

  it('is whatever was asked for, whichever classifier', () => {
    expect(parseArgs(['--classifier=agent', '--n=2']).samples).toBe(2)
    expect(parseArgs(['--n=2', '--classifier=agent']).samples).toBe(2)
  })
})
