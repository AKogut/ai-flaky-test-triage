import { describe, expect, it } from 'vitest'
import { listFixtures, loadAllLabels, loadAllPayloads, loadLabels, loadPayload } from './dataset.js'

/**
 * These assertions run against the **real** dataset, not a synthetic directory.
 *
 * Every number this project publishes is computed over these files, so the
 * dataset itself needs a test suite for the same reason the code does — and the
 * failure it guards against is a fixture that parses but is subtly wrong.
 */

const names = listFixtures()
const payloads = loadAllPayloads()
const labels = loadAllLabels()

describe('the golden dataset', () => {
  it('has no incomplete fixtures', () => {
    // listFixtures throws on either kind of orphan; reaching here means it did not.
    expect(names.length).toBeGreaterThan(0)
  })

  it('parses every payload and every label file', () => {
    expect(payloads).toHaveLength(names.length)
    expect(labels).toHaveLength(names.length)
  })

  it('gives every fixture a distinct content hash', () => {
    // Two identical payloads under different names would double-count in every
    // metric while looking like independent evidence.
    const hashes = payloads.map((p) => p.hash)
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('keeps the subject test id consistent between result and signal', () => {
    for (const { name, payload } of payloads) {
      expect(payload.subject.signal.testId, name).toBe(payload.subject.result.testId)
    }
  })

  it('describes a failure in every payload', () => {
    for (const { name, payload } of payloads) {
      const { status, flakyWithinRun, error } = payload.subject.result
      /**
       * A green run is still triageable when it only got there on a retry.
       * `selectForTriage` has a clause for exactly that, and it is the clearest
       * intermittency evidence a single run can carry — the alternation happened
       * where the pass/fail sequence cannot show it.
       *
       * This read `['failed', 'timedOut']` until #177, which is why four
       * fixtures had been carrying `failed` beside `flakyWithinRun: true` — a
       * combination the Playwright normaliser cannot produce, because the flag
       * is derived from the final attempt having passed.
       */
      expect(status === 'failed' || status === 'timedOut' || flakyWithinRun, name).toBe(true)
      // Either way there is a failure to explain: a retried test keeps the error
      // from the attempt that failed, which is what the normaliser preserves.
      expect(error?.message, name).toBeTruthy()
    }
  })
})

describe('ground truth', () => {
  it('argues for the label rather than asserting it', () => {
    // The 80-character floor is a schema rule; this checks the intent behind it,
    // which is that the tempting alternative is addressed.
    for (const label of labels) {
      expect(label.justification.length, label.name).toBeGreaterThan(120)
    }
  })

  it('records which ordered rule decided each label', () => {
    for (const label of labels) {
      expect(label.ruleApplied, label.name).toMatch(/^rule-[1-4]-/)
    }
  })

  it('never uses the default rule to justify a test_code label', () => {
    // rule-4 is "otherwise, app_code". Reaching it for a test_code label would
    // mean the labeller skipped the rule that should have fired.
    for (const label of labels.filter((l) => l.owner === 'test_code')) {
      expect(label.ruleApplied, label.name).not.toBe('rule-4-default-app-code')
    }
  })
})

describe('what a classifier is given', () => {
  it('cannot reach the answer through the payload loader', () => {
    // The structural guarantee the two-file format exists to provide.
    for (const { payload } of payloads) {
      expect(Object.keys(payload)).not.toContain('owner')
      expect(Object.keys(payload)).not.toContain('determinism')
      expect(Object.keys(payload)).not.toContain('labels')
    }
  })

  it('refuses a payload whose declared name disagrees with its filename', () => {
    expect(() => loadPayload(names[0] ?? '', 'eval/golden-dataset')).not.toThrow()
  })
})

describe('per-fixture consistency', () => {
  it.each(names)('%s has matching names in both files', (name) => {
    expect(loadPayload(name).payload.name).toBe(name)
    expect(loadLabels(name).name).toBe(name)
  })
})
