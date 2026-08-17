import { ClassificationSchema, type FixturePayload } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { classifyWithBaseline } from './baseline.js'
import { loadAllPayloads, loadLabels } from './dataset.js'

const payload = (overrides: {
  message?: string
  stack?: string
  diff?: string
  consecutiveFailures?: number
  flakyWithinRun?: boolean
  historyAvailable?: boolean
  statusHistory?: string
}): FixturePayload => ({
  name: 'probe',
  scenario: 'A probe fixture built in the test to exercise one rule at a time.',
  historyAvailable: overrides.historyAvailable ?? true,
  ...(overrides.diff === undefined ? {} : { diff: overrides.diff }),
  subject: {
    result: {
      testId: 'tests/unit/a.test.ts›t',
      title: 't',
      file: 'tests/unit/a.test.ts',
      status: 'failed',
      attempts: 1,
      flakyWithinRun: overrides.flakyWithinRun ?? false,
      durationMs: 10,
      annotations: [],
      error: {
        message: overrides.message ?? 'AssertionError: expected 1 to be 2',
        ...(overrides.stack === undefined ? {} : { stack: overrides.stack }),
      },
    },
    signal: {
      testId: 'tests/unit/a.test.ts›t',
      flakinessScore: 0.1,
      consecutiveFailures: overrides.consecutiveFailures ?? 0,
      totalRuns: 20,
      firstSeenAt: '2026-06-01T00:00:00.000Z',
      lastPassedAt: '2026-08-01T00:00:00.000Z',
      statusHistory: overrides.statusHistory ?? 'PPPPF',
      isNew: false,
    },
  },
})

const productDiff = 'diff --git a/app/server/routes/tasks.ts b/app/server/routes/tasks.ts\n'
const specDiff = 'diff --git a/tests/unit/a.test.ts b/tests/unit/a.test.ts\n'

describe('owner rules, in order', () => {
  it.each([
    ['a port collision', 'Error: listen EADDRINUSE: address already in use :::3001'],
    ['a refused connection', 'Error: connect ECONNREFUSED 127.0.0.1:3001'],
    ['a missing module', "Error: Cannot find module '@sentra/contracts'"],
    ['a browser that would not start', "browserType.launch: Executable doesn't exist"],
    ['an out-of-memory kill', 'FATAL ERROR: JavaScript heap out of memory'],
  ])('classifies %s as environment', (_label, message) => {
    expect(classifyWithBaseline(payload({ message })).owner).toBe('environment')
  })

  it('prefers environment even when the commit changes product source', () => {
    // Rule order matters: a run that never reached an assertion says nothing
    // about the diff, however suspicious the diff looks.
    const result = classifyWithBaseline(
      payload({ message: 'Error: listen EADDRINUSE', diff: productDiff }),
    )
    expect(result.owner).toBe('environment')
  })

  it('classifies a product diff as app_code', () => {
    expect(classifyWithBaseline(payload({ diff: productDiff })).owner).toBe('app_code')
  })

  it.each([
    ['documentation', 'diff --git a/README.md b/README.md\n'],
    ['CI configuration', 'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n'],
    ['the wiki', 'diff --git a/wiki/Home.md b/wiki/Home.md\n'],
    ['a lockfile', 'diff --git a/package-lock.json b/package-lock.json\n'],
    ['tooling config', 'diff --git a/eslint.config.js b/eslint.config.js\n'],
  ])('does not treat a change to %s as product source (#112)', (_label, diff) => {
    const withDocs = classifyWithBaseline(payload({ diff }))
    const withNone = classifyWithBaseline(payload({}))
    expect(withDocs.reasoning).toBe(withNone.reasoning)
  })

  it('does not let a test-only diff fire the product-change rule', () => {
    // Both land on app_code — the second rule and the fallback share a label —
    // so asserting on the label alone would pass whether or not the rule fired.
    // The reasoning and the confidence are what distinguish them.
    const testOnly = classifyWithBaseline(payload({ diff: specDiff }))
    const noDiff = classifyWithBaseline(payload({}))
    expect(testOnly.reasoning).toContain('fallback')
    expect(testOnly.confidence).toBe(noDiff.confidence)
  })

  it.each([
    [
      'a locator timeout',
      "locator.click: Timeout 30000ms exceeded.\n  - waiting for getByTestId('x')",
    ],
    ['an explicit wait', 'Error: Timed out 5000ms waiting for expect(locator).toBeVisible()'],
  ])('classifies %s with no product diff as test_code', (_label, message) => {
    expect(classifyWithBaseline(payload({ message })).owner).toBe('test_code')
  })

  it('falls back to app_code when nothing matches', () => {
    expect(
      classifyWithBaseline(payload({ message: 'AssertionError: expected 1 to be 2' })).owner,
    ).toBe('app_code')
  })

  it('ranks the fallback below every rule that actually matched', () => {
    // Confidence has to come from rule specificity, or the number carries no
    // information at all — which is what #37 will measure.
    const fallback = classifyWithBaseline(payload({}))
    const matched = classifyWithBaseline(payload({ diff: productDiff }))
    expect(fallback.confidence).toBeLessThan(matched.confidence)
  })
})

describe('determinism rule', () => {
  it('calls an unbroken failure streak deterministic', () => {
    expect(
      classifyWithBaseline(payload({ consecutiveFailures: 3, statusHistory: 'PPPFFF' }))
        .determinism,
    ).toBe('deterministic')
  })

  it('calls a single failure intermittent', () => {
    expect(classifyWithBaseline(payload({ consecutiveFailures: 1 })).determinism).toBe(
      'intermittent',
    )
  })

  it('calls a within-run recovery intermittent however long the streak', () => {
    // A pass on retry is direct evidence; history is circumstantial.
    expect(
      classifyWithBaseline(payload({ consecutiveFailures: 5, flakyWithinRun: true })).determinism,
    ).toBe('intermittent')
  })

  it('lowers confidence when there is no history to draw on', () => {
    const withHistory = classifyWithBaseline(payload({ consecutiveFailures: 3 }))
    const without = classifyWithBaseline(
      payload({ consecutiveFailures: 3, historyAvailable: false }),
    )
    expect(without.confidence).toBeLessThan(withHistory.confidence)
  })
})

describe('output contract', () => {
  it('emits a schema-valid Classification', () => {
    expect(() => ClassificationSchema.parse(classifyWithBaseline(payload({})))).not.toThrow()
  })

  it('quotes evidence for both axes', () => {
    const result = classifyWithBaseline(payload({ diff: productDiff, consecutiveFailures: 3 }))
    expect(result.evidence.some((e) => e.includes('diff touches'))).toBe(true)
    expect(result.evidence.some((e) => e.includes('history'))).toBe(true)
  })

  it('says something a human would read on a fork pull request', () => {
    // ADR-0007: with no API key this is the only classifier the pipeline has.
    const result = classifyWithBaseline(payload({ diff: productDiff }))
    expect(result.reasoning).toContain('app_code')
    expect(result.reasoning.length).toBeGreaterThan(40)
  })

  it('is deterministic', () => {
    const once = classifyWithBaseline(payload({ diff: productDiff }))
    expect(classifyWithBaseline(payload({ diff: productDiff }))).toEqual(once)
  })

  it('truncates an enormous error rather than overflowing the reasoning cap', () => {
    const result = classifyWithBaseline(payload({ message: 'x'.repeat(5000) }))
    expect(() => ClassificationSchema.parse(result)).not.toThrow()
  })
})

describe('scored against the committed dataset', () => {
  const scored = loadAllPayloads().map(({ name, payload: p }) => ({
    name,
    labels: loadLabels(name),
    payload: p,
    predicted: classifyWithBaseline(p),
  }))

  const accuracy = (pick: (s: (typeof scored)[number]) => boolean): number =>
    scored.filter(pick).length / scored.length

  it('runs over every fixture without throwing', () => {
    expect(scored.length).toBeGreaterThan(0)
  })

  it('gets every straightforward regression right', () => {
    // The sanity floor. A control that fails these is broken rather than simple.
    const easy = scored.filter((s) => s.labels.bucket === 'straightforward')
    expect(easy.length).toBeGreaterThan(0)
    for (const s of easy) expect(s.predicted.owner, s.name).toBe(s.labels.owner)
  })

  it('gets every stale-test fixture with a product diff wrong, exactly as documented', () => {
    // Not a defect. Those fixtures have a product diff, so the second rule fires
    // and calls them app_code. Patching around it would mean tuning the control
    // against the dataset it exists to control for.
    //
    // The qualifier is new and it is a real change, not a weakening. #53 added a
    // captured fixture to this bucket that has **no** diff — it was reproduced
    // locally, so there is no commit under test — and with no diff to reason
    // from the baseline falls through to its locator rule and gets the owner
    // right. It is still wrong about the fixture, on the other axis.
    const stale = scored.filter((s) => s.labels.bucket === 'stale-test')
    const withDiff = stale.filter((s) => (s.payload.diff ?? '') !== '')

    expect(withDiff.length).toBeGreaterThan(0)
    for (const s of withDiff) expect(s.predicted.owner, s.name).toBe('app_code')

    for (const s of stale.filter((s) => (s.payload.diff ?? '') === '')) {
      expect(s.predicted.owner, s.name).toBe('test_code')
      expect(s.predicted.determinism, s.name).not.toBe(s.labels.determinism)
    }
  })

  it('gets a majority of the hard quadrant wrong, which is why the dataset can discriminate', () => {
    // The acceptance criterion for #21: if the control gets most of these right,
    // the fixtures are not hard enough and the dataset cannot tell classifiers
    // apart. Recorded as a number so tuning either side shows up here.
    const hard = scored.filter((s) => s.labels.bucket === 'hard-quadrant')
    const missed = hard.filter(
      (s) =>
        s.predicted.owner !== s.labels.owner || s.predicted.determinism !== s.labels.determinism,
    )
    expect(hard.length).toBe(11)
    expect(missed.length).toBe(8)
  })

  it('does not read a documentation-only commit as a product change (#112)', () => {
    // This fixture used to come back app_code because its diff touches
    // README.md and a workflow file. Right answer, wrong reason — and the wrong
    // reason was hiding one more miss on the quadrant that matters.
    const docsOnly = scored.find((s) => s.name === 'reorder-reconciliation-overwrites-later-drag')
    expect(docsOnly?.predicted.owner).toBe('test_code')
    expect(docsOnly?.predicted.evidence.join(' ')).not.toContain('README.md')
  })

  it('is defeated by the adversarial buckets, which is what they are for (#22)', () => {
    // One of the eight is deliberately not a trap: an EADDRINUSE failure inside
    // a commit that touches the server bootstrap, where the obvious reading and
    // the correct one agree. A bucket of nothing but traps would teach the
    // opposite reflex — that anything infrastructure-shaped near a product diff
    // must be environment.
    const adversarial = scored.filter(
      (s) =>
        s.labels.bucket === 'misleading-history' || s.labels.bucket === 'environment-as-regression',
    )
    const missed = adversarial.filter(
      (s) =>
        s.predicted.owner !== s.labels.owner || s.predicted.determinism !== s.labels.determinism,
    )
    expect(adversarial.length).toBe(8)
    expect(missed.length).toBe(7)
  })

  it('reads every misleading-history fixture as unstable when it has settled', () => {
    // The determinism rule keys on a consecutive-failure streak. These have a
    // new cause that reproduces every time but only one run old, so the streak
    // is short and the months of alternation behind it are irrelevant.
    for (const s of scored.filter((s) => s.labels.bucket === 'misleading-history')) {
      expect(s.labels.determinism, s.name).toBe('deterministic')
      expect(s.predicted.determinism, s.name).toBe('intermittent')
    }
  })

  it('records the current owner-axis accuracy so a change to the rules is visible', () => {
    // 8 of 15 by construction: every straightforward fixture, no stale-test one.
    expect(accuracy((s) => s.predicted.owner === s.labels.owner)).toBeCloseTo(19 / 35, 5)
  })

  it('records the current determinism-axis accuracy', () => {
    expect(accuracy((s) => s.predicted.determinism === s.labels.determinism)).toBeCloseTo(
      27 / 35,
      5,
    )
  })
})
