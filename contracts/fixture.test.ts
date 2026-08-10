import { describe, expect, it } from 'vitest'
import {
  fixtureHash,
  FixtureLabelsSchema,
  FixturePayloadSchema,
  pairFixtureFiles,
  parseFixtureLabels,
  parseFixturePayload,
} from './fixture.js'

const subject = {
  result: {
    testId: 'tests/e2e/board.spec.ts›reorder › moves a task up',
    title: 'reorder › moves a task up',
    file: 'tests/e2e/board.spec.ts',
    status: 'failed' as const,
    attempts: 1,
    flakyWithinRun: false,
    durationMs: 900,
    annotations: [],
    error: { message: 'expected order [a,b] but received [b,a]' },
  },
  signal: {
    testId: 'tests/e2e/board.spec.ts›reorder › moves a task up',
    flakinessScore: 0.42,
    consecutiveFailures: 1,
    totalRuns: 30,
    firstSeenAt: '2026-06-01T00:00:00.000Z',
    lastPassedAt: '2026-08-09T00:00:00.000Z',
    statusHistory: 'PPFPPFPPF',
    isNew: false,
  },
}

const payload = {
  name: 'reorder-race-under-load',
  scenario: 'A drag-to-reorder assertion disagrees with the rendered order after a slow response.',
  subject,
  historyAvailable: true,
}

const labels = {
  name: 'reorder-race-under-load',
  owner: 'app_code' as const,
  determinism: 'intermittent' as const,
  justification:
    'The test waits properly and asserts on settled state, so rule 2 does not apply. The failure reproduces against an unchanged spec, which points at the product rather than the test. Environment is the tempting alternative because it only fails under load, but the assertion was reached.',
  ruleApplied: 'rule-3-reproduces-against-unchanged-product' as const,
  provenance: 'synthetic' as const,
  bucket: 'hard-quadrant' as const,
}

describe('FixturePayloadSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(FixturePayloadSchema.parse(payload).name).toBe('reorder-race-under-load')
  })

  it('rejects a payload carrying a label field', () => {
    // The whole reason for two files: the answer must be one careless spread
    // away from nothing, not from the prompt.
    expect(() => FixturePayloadSchema.parse({ ...payload, owner: 'app_code' })).toThrow()
  })

  it('constrains the name to the filename alphabet', () => {
    expect(() => FixturePayloadSchema.parse({ ...payload, name: 'Not A Slug' })).toThrow()
  })

  it('round-trips through JSON unchanged', () => {
    const once = FixturePayloadSchema.parse(payload)
    expect(FixturePayloadSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })
})

describe('FixtureLabelsSchema', () => {
  it('accepts a well-argued label', () => {
    expect(FixtureLabelsSchema.parse(labels).bucket).toBe('hard-quadrant')
  })

  it('refuses a justification too short to be an argument', () => {
    // A one-line justification almost always means the label was not reasoned
    // about, and unreasoned ground truth makes every downstream number hollow.
    expect(() => FixtureLabelsSchema.parse({ ...labels, justification: 'it is a race' })).toThrow()
  })

  it('requires the rule that decided it', () => {
    const { ruleApplied: _r, ...withoutRule } = labels
    expect(() => FixtureLabelsSchema.parse(withoutRule)).toThrow()
  })

  it('defaults lowConfidenceGroundTruth to false rather than undefined', () => {
    expect(FixtureLabelsSchema.parse(labels).lowConfidenceGroundTruth).toBe(false)
  })

  it('rejects a bucket outside the documented set', () => {
    expect(() => FixtureLabelsSchema.parse({ ...labels, bucket: 'tricky' })).toThrow()
  })
})

describe('the two types cannot be conflated', () => {
  it('a labels file does not parse as a payload', () => {
    expect(() => parseFixturePayload(labels, 'x.labels.json')).toThrow(
      /not a valid fixture payload/,
    )
  })

  it('a payload does not parse as a labels file', () => {
    expect(() => parseFixtureLabels(payload, 'x.run.json')).toThrow(
      /not a valid fixture label file/,
    )
  })
})

describe('fixtureHash', () => {
  it('is stable across key order and formatting', () => {
    const reordered = { ...payload, historyAvailable: true, name: payload.name }
    expect(fixtureHash(FixturePayloadSchema.parse(reordered))).toBe(
      fixtureHash(FixturePayloadSchema.parse(payload)),
    )
  })

  it('changes when the content changes', () => {
    // A fixture quietly edited after a good result would otherwise be invisible
    // in a report that cites its hash.
    const edited = FixturePayloadSchema.parse({
      ...payload,
      subject: {
        ...subject,
        signal: { ...subject.signal, flakinessScore: 0.43 },
      },
    })
    expect(fixtureHash(edited)).not.toBe(fixtureHash(FixturePayloadSchema.parse(payload)))
  })
})

describe('pairFixtureFiles', () => {
  it('pairs matching files', () => {
    expect(pairFixtureFiles(['a.run.json', 'a.labels.json']).names).toEqual(['a'])
  })

  it('reports a payload with no labels rather than skipping it', () => {
    // Silently skipping would shrink the dataset without anyone noticing, and
    // the headline would be computed over fewer fixtures than reported.
    const paired = pairFixtureFiles(['a.run.json', 'a.labels.json', 'b.run.json'])
    expect(paired.names).toEqual(['a'])
    expect(paired.missingLabels).toEqual(['b'])
  })

  it('reports labels with no payload', () => {
    expect(pairFixtureFiles(['c.labels.json']).orphanedLabels).toEqual(['c'])
  })

  it('ignores unrelated files', () => {
    expect(pairFixtureFiles(['README.md', 'a.run.json', 'a.labels.json']).names).toEqual(['a'])
  })

  it('returns names in a stable order', () => {
    const files = ['b.run.json', 'b.labels.json', 'a.run.json', 'a.labels.json']
    expect(pairFixtureFiles(files).names).toEqual(['a', 'b'])
  })
})
