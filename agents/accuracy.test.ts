import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { METRICS_FILE, measuredAccuracy } from './accuracy.js'

/**
 * The footer's accuracy figure, matched to the classifier that ran.
 *
 * Every case that is not an exact match is asserted to produce nothing, because
 * the failure worth guarding against is not a missing figure — the footer says
 * so out loud — but a wrong one, which nobody reading a pull request can spot.
 */

const snapshot = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    classifier: 'baseline',
    promptVersion: null,
    slice: 'dev',
    datasetRevision: '08b6da23ebcfe892',
    n: 26,
    joint: { point: 0.34615384615384615, lower: 0.194, upper: 0.538 },
    selfConsistency: null,
    costPerFixtureUsd: null,
    ...over,
  })

const agent = (over: Record<string, unknown> = {}): string =>
  snapshot({ classifier: 'agent', promptVersion: 'triage.v1', ...over })

describe('a figure for the classifier that ran', () => {
  it('is quoted for the baseline when the baseline ran', () => {
    expect(measuredAccuracy(snapshot(), { classifier: 'baseline' })).toEqual({
      joint: 0.34615384615384615,
      n: 26,
      slice: 'dev',
      classifier: 'baseline',
      promptVersion: null,
    })
  })

  it('is quoted for the model when the same prompt version ran', () => {
    expect(
      measuredAccuracy(agent(), { classifier: 'agent', promptVersion: 'triage.v1' }),
    ).toMatchObject({ classifier: 'agent', promptVersion: 'triage.v1', joint: 0.34615384615384615 })
  })

  /**
   * The gate's schema defaults the field for snapshots older than it, and the
   * baseline is exactly the classifier those snapshots describe.
   */
  it('accepts a baseline snapshot written before promptVersion existed', () => {
    const old = JSON.parse(snapshot()) as Record<string, unknown>
    delete old.promptVersion
    expect(measuredAccuracy(JSON.stringify(old), { classifier: 'baseline' })).toMatchObject({
      promptVersion: null,
    })
  })

  /** A field added to the snapshot later must not silence the footer. */
  it('ignores fields it does not quote', () => {
    expect(
      measuredAccuracy(snapshot({ somethingNew: { a: 1 } }), { classifier: 'baseline' }),
    ).toBeDefined()
  })

  /** The committed file is the one CI reads; it has to be one this module understands. */
  it('understands the snapshot committed on this branch', () => {
    const root = new URL('..', import.meta.url).pathname
    const committed = readFileSync(join(root, METRICS_FILE), 'utf8')
    const { classifier, promptVersion } = JSON.parse(committed) as {
      classifier: 'baseline' | 'agent'
      promptVersion: string | null
    }
    const ran =
      classifier === 'agent'
        ? { classifier, promptVersion: promptVersion ?? '' }
        : { classifier: 'baseline' as const }
    expect(measuredAccuracy(committed, ran)).toBeDefined()
  })
})

describe('anything else', () => {
  /** The baseline's 35% under a model-written report would be a claim about the wrong system. */
  it('quotes nothing when the snapshot is for the other classifier', () => {
    expect(
      measuredAccuracy(snapshot(), { classifier: 'agent', promptVersion: 'triage.v1' }),
    ).toBeUndefined()
    expect(measuredAccuracy(agent(), { classifier: 'baseline' })).toBeUndefined()
  })

  /** A figure recorded under a prompt that has since been replaced describes text that no longer runs. */
  it('quotes nothing when the prompt version differs', () => {
    expect(
      measuredAccuracy(agent(), { classifier: 'agent', promptVersion: 'triage.v2' }),
    ).toBeUndefined()
    expect(
      measuredAccuracy(agent({ promptVersion: null }), {
        classifier: 'agent',
        promptVersion: 'triage.v1',
      }),
    ).toBeUndefined()
  })

  it('quotes nothing when there is no file', () => {
    expect(measuredAccuracy(null, { classifier: 'baseline' })).toBeUndefined()
  })

  it.each([
    ['empty', ''],
    ['truncated', snapshot().slice(0, 40)],
    ['not an object', '"0.35"'],
  ])('quotes nothing when the file is %s', (_name, raw) => {
    expect(measuredAccuracy(raw, { classifier: 'baseline' })).toBeUndefined()
  })

  it.each([
    ['an unknown version', { version: 2 }],
    ['an unknown classifier', { classifier: 'model' }],
    ['no joint figure', { joint: undefined }],
    ['a joint figure outside [0, 1]', { joint: { point: 1.5 } }],
    ['no fixtures', { n: 0 }],
    ['a fractional fixture count', { n: 2.5 }],
    ['an empty slice', { slice: '' }],
  ])('quotes nothing for a snapshot with %s', (_name, over) => {
    expect(measuredAccuracy(snapshot(over), { classifier: 'baseline' })).toBeUndefined()
  })
})
