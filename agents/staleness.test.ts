import { describe, expect, it } from 'vitest'
import { cassetteKey, type Cassette } from './cassettes.js'
import { compare, isStale, render, type Expectation } from './staleness.js'
import type { ModelRequest } from './transport.js'

const CURRENT = { promptVersion: 'triage.v1', model: 'claude-opus-5' }

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: CURRENT.model,
  maxTokens: 8000,
  effort: 'high',
  system: 'you classify failures',
  prompt: 'a failure',
  schemaName: 'classification',
  jsonSchema: { type: 'object', properties: {} },
  promptVersion: CURRENT.promptVersion,
  ...over,
})

const expect_ = (over: Partial<ModelRequest> = {}, source = 'eval a'): Expectation => ({
  source,
  request: request(over),
})

const recorded = (over: Partial<ModelRequest> = {}): Cassette => {
  const built = request(over)
  return {
    key: cassetteKey(built),
    promptVersion: built.promptVersion,
    model: built.model,
    recordedAt: '2026-08-12',
    sample: built.sample ?? 0,
    request: {
      effort: built.effort,
      maxTokens: built.maxTokens,
      schemaName: built.schemaName,
      schemaDigest: 'abc',
      system: [built.system],
      prompt: [built.prompt],
    },
    inputTokens: 100,
    response: {
      raw: {},
      stopReason: 'end_turn',
      model: built.model,
      usage: { inputTokens: 100, outputTokens: 10 },
    },
  }
}

describe('comparing what is asked for against what is recorded', () => {
  it('is happy when they match', () => {
    const report = compare([expect_()], [recorded()], CURRENT)
    expect(isStale(report)).toBe(false)
    expect(report).toMatchObject({ expected: 1, onDisk: 1 })
  })

  it('reports a request with nothing recorded for it', () => {
    const report = compare([expect_({ prompt: 'a different failure' })], [recorded()], CURRENT)
    expect(report.missing).toHaveLength(1)
    expect(report.missing[0]?.source).toBe('eval a')
  })

  /**
   * The expected shape after a version bump or a model change: explainable, and
   * fixed by re-recording.
   */
  it('calls a recording from an older prompt version stale', () => {
    const report = compare([expect_()], [recorded({ promptVersion: 'triage.v0' })], CURRENT)
    expect(report.stale.map((row) => row.promptVersion)).toEqual(['triage.v0'])
    expect(report.orphaned).toEqual([])
  })

  it('calls a recording from another model stale too', () => {
    const report = compare([expect_()], [recorded({ model: 'claude-sonnet-5' })], CURRENT)
    expect(report.stale.map((row) => row.model)).toEqual(['claude-sonnet-5'])
  })

  /**
   * The alarming one. Same version, same model, different content means the
   * prompt text or the assembled context moved without the version being
   * bumped — so any published number attributed to that version describes text
   * that no longer exists.
   */
  it('separates an unrequested recording at the current version as orphaned', () => {
    const report = compare([expect_()], [recorded({ prompt: 'a question nobody asks' })], CURRENT)
    expect(report.orphaned).toHaveLength(1)
    expect(report.stale).toEqual([])
    // And the request that *is* wanted has nothing recorded for it.
    expect(report.missing).toHaveLength(1)
  })

  it('treats each sample index as its own request', () => {
    const report = compare(
      [expect_({ sample: 0 }), expect_({ sample: 1 })],
      [recorded({ sample: 0 })],
      CURRENT,
    )
    expect(report.expected).toBe(2)
    expect(report.missing).toHaveLength(1)
  })

  it('counts a duplicated expectation once', () => {
    const report = compare([expect_(), expect_({}, 'demo a')], [recorded()], CURRENT)
    expect(report.expected).toBe(1)
    expect(isStale(report)).toBe(false)
  })

  it('is quiet when nothing is expected and nothing is recorded', () => {
    const report = compare([], [], CURRENT)
    expect(isStale(report)).toBe(false)
    expect(render(report)).toContain('Nothing to check')
  })

  it('orders its findings, so the message does not churn between runs', () => {
    const report = compare(
      [expect_({ prompt: 'b' }, 'eval b'), expect_({ prompt: 'a' }, 'eval a')],
      [],
      CURRENT,
    )
    expect(report.missing.map((row) => row.source)).toEqual(['eval a', 'eval b'])
  })
})

describe('the message', () => {
  it('names the command that fixes it, whatever went wrong', () => {
    for (const report of [
      compare([expect_()], [], CURRENT),
      compare([], [recorded({ promptVersion: 'triage.v0' })], CURRENT),
      compare([], [recorded({ prompt: 'x' })], CURRENT),
    ]) {
      expect(render(report)).toContain('npm run cassettes:record')
    }
  })

  it('reports the three kinds separately', () => {
    const report = compare(
      [expect_({ prompt: 'wanted' })],
      [recorded({ promptVersion: 'triage.v0' }), recorded({ prompt: 'unwanted' })],
      CURRENT,
    )
    const text = render(report)
    expect(text).toContain('Missing')
    expect(text).toContain('Stale')
    expect(text).toContain('Orphaned')
  })

  it('says why an orphan is worth reading twice', () => {
    const report = compare([], [recorded({ prompt: 'x' })], CURRENT)
    expect(render(report)).toContain('without the version')
  })

  it('truncates a long list rather than printing a hundred lines', () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      expect_({ prompt: `failure ${String(index)}` }),
    )
    const text = render(compare(many, [recorded()], CURRENT))
    expect(text).toContain('… and 15 more')
  })

  it('says so plainly when everything is current', () => {
    expect(render(compare([expect_()], [recorded()], CURRENT))).toContain('present and current')
  })
})
