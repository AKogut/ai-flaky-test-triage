import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bucket, FixtureLabels } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { checkComposition, checkLeakage, runHygiene } from './hygiene.js'
import { loadPayload } from './dataset.js'

const real = loadPayload('create-task-returns-ok-instead-of-created').payload

/** A payload with one string replaced, so each case differs in exactly one place. */
const withText = (path: 'scenario' | 'title', text: string) =>
  path === 'scenario'
    ? { ...real, scenario: text }
    : { ...real, subject: { ...real.subject, result: { ...real.subject.result, title: text } } }

describe('checkLeakage', () => {
  it('passes the real dataset', () => {
    expect(checkLeakage('create-task-returns-ok-instead-of-created', real)).toEqual([])
  })

  it.each([
    ['app_code', 'The app_code is at fault here in this scenario description.'],
    ['flaky', 'A flaky reorder assertion that disagrees with the rendered order.'],
    ['intermittent', 'An intermittent failure when two updates overlap on the board.'],
    ['stale', 'A stale expectation left behind by the toolbar redesign work.'],
    ['ground truth', 'The ground truth here is that the product is at fault.'],
  ])('catches %s in the scenario', (_term, text) => {
    expect(checkLeakage('probe', withText('scenario', text))).not.toEqual([])
  })

  it('catches a leaked term in a test title', () => {
    const findings = checkLeakage('probe', withText('title', 'board › survives a race on reorder'))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('title')
  })

  it('catches a leaked term in the filename', () => {
    expect(checkLeakage('reorder-is-flaky-under-load', real)[0]?.message).toContain('filename')
  })

  it('does not fire on "stack trace", which contains "race"', () => {
    // An unbounded /race/ matches every stack trace in the dataset. A check that
    // fires on everything gets switched off, which is worse than not having it.
    expect(
      checkLeakage('probe', withText('scenario', 'The stack trace embraces the caller.')),
    ).toEqual([])
  })

  it('does not fire on the schema key names', () => {
    // flakinessScore and flakyWithinRun are part of the format, not something a
    // fixture author chose. Only string values are scanned.
    expect(JSON.stringify(real)).toContain('flakinessScore')
    expect(checkLeakage('probe', real)).toEqual([])
  })

  it('names the path so a finding can be acted on', () => {
    const findings = checkLeakage('probe', withText('scenario', 'A flaky thing happens.'))
    expect(findings[0]?.message).toMatch(/^scenario contains/)
  })
})

describe('checkComposition', () => {
  const labels = (counts: Partial<Record<Bucket, number>>): FixtureLabels[] =>
    Object.entries(counts).flatMap(([bucket, n]) =>
      Array.from({ length: n ?? 0 }, (_, i) => ({
        name: `${bucket}-${String(i)}`,
        owner: 'app_code' as const,
        determinism: 'intermittent' as const,
        justification: 'x'.repeat(200),
        ruleApplied: 'rule-4-default-app-code' as const,
        provenance: 'synthetic' as const,
        bucket: bucket as Bucket,
        lowConfidenceGroundTruth: false,
      })),
    )

  it('reports a share for every bucket, including empty ones', () => {
    const { composition } = checkComposition(labels({ 'hard-quadrant': 4 }))
    expect(composition).toHaveLength(6)
    expect(composition.find((c) => c.bucket === 'cross-file-state-leak')?.count).toBe(0)
  })

  it('does not enforce below the target dataset size', () => {
    // A half-built dataset is not out of composition, it is unfinished. Failing
    // on it would train everyone to ignore the check while it is being built.
    expect(checkComposition(labels({ 'hard-quadrant': 59 })).compositionEnforced).toBe(false)
  })

  it('enforces once the dataset is large enough for shares to mean anything', () => {
    expect(checkComposition(labels({ 'hard-quadrant': 60 })).compositionEnforced).toBe(true)
  })

  it('computes drift against the documented target', () => {
    const { composition } = checkComposition(labels({ 'hard-quadrant': 10, straightforward: 10 }))
    const hard = composition.find((c) => c.bucket === 'hard-quadrant')
    expect(hard?.share).toBeCloseTo(0.5, 5)
    expect(hard?.drift).toBeCloseTo(0.3, 5)
  })
})

describe('runHygiene against a directory', () => {
  const fixtureDir = (files: Record<string, unknown>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sentra-hygiene-'))
    for (const [file, body] of Object.entries(files)) {
      writeFileSync(join(dir, file), JSON.stringify(body))
    }
    return dir
  }

  const labels = (name: string, justification = 'x'.repeat(200)) => ({
    name,
    owner: 'app_code',
    determinism: 'deterministic',
    justification,
    ruleApplied: 'rule-4-default-app-code',
    provenance: 'synthetic',
    bucket: 'straightforward',
    lowConfidenceGroundTruth: false,
  })

  it('reports a payload with no labels', () => {
    const dir = fixtureDir({ 'probe.run.json': { ...real, name: 'probe' } })
    expect(runHygiene(dir).errors[0]?.message).toContain('no .labels.json')
  })

  it('reports labels with no payload', () => {
    const dir = fixtureDir({ 'probe.labels.json': labels('probe') })
    expect(runHygiene(dir).errors[0]?.message).toContain('no .run.json')
  })

  it('warns about a justification that parses but does not argue', () => {
    const dir = fixtureDir({
      'probe.run.json': { ...real, name: 'probe' },
      'probe.labels.json': labels('probe', 'x'.repeat(90)),
    })
    const report = runHygiene(dir)
    expect(report.errors).toEqual([])
    expect(report.warnings[0]?.message).toContain('90 characters')
  })

  it('does not warn about a justification that makes an argument', () => {
    const dir = fixtureDir({
      'probe.run.json': { ...real, name: 'probe' },
      'probe.labels.json': labels('probe'),
    })
    expect(runHygiene(dir).warnings).toEqual([])
  })
})

describe('the committed dataset', () => {
  const report = runHygiene()

  it('has no leakage or pairing problems', () => {
    expect(report.errors).toEqual([])
  })

  it('has no thin justifications', () => {
    expect(report.warnings).toEqual([])
  })

  it('is still below the size where composition is enforced', () => {
    // When this flips, the drift check starts failing the build — which is the
    // point at which the remaining buckets have to be filled in.
    expect(report.compositionEnforced).toBe(false)
    expect(report.fixtures).toBe(35)
  })
})
