import { describe, expect, it } from 'vitest'
import {
  HISTORY_SCHEMA_VERSION,
  HistoryUnreadableError,
  emptyHistory,
  parseHistory,
  type History,
} from './history.js'

/**
 * The history document, checked at the boundary where it comes back off disk.
 *
 * Nothing reviews this file, so the schema is the only reader that ever looks at
 * it critically. What is asserted here is mostly refusal: the shapes it must not
 * accept, and that each refusal says which kind of wrong it is.
 */

const testId = 'tests/e2e/board.spec.ts›shows a row'

const valid: History = {
  schemaVersion: HISTORY_SCHEMA_VERSION,
  tests: {
    [testId]: {
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      entries: [
        {
          runId: '1',
          at: '2026-08-01T00:00:00.000Z',
          status: 'passed',
          flakyWithinRun: false,
        },
      ],
    },
  },
}

const clone = (): History => JSON.parse(JSON.stringify(valid)) as History

describe('an empty history', () => {
  it('carries the current version', () => {
    expect(emptyHistory()).toEqual({ schemaVersion: HISTORY_SCHEMA_VERSION, tests: {} })
  })

  /** A shared constant would put one caller's tests into the next caller's history. */
  it('is a new object every time', () => {
    const first = emptyHistory()
    first.tests[testId] = { firstSeenAt: '2026-08-01T00:00:00.000Z', entries: [] }
    expect(emptyHistory().tests).toEqual({})
  })
})

describe('parsing a history document', () => {
  it('accepts a well-formed one', () => {
    expect(parseHistory(clone(), 'h.json')).toEqual(valid)
  })

  it('accepts one with no tests in it yet', () => {
    expect(parseHistory(emptyHistory(), 'h.json').tests).toEqual({})
  })

  /** `timedOut` and `skipped` reaching disk is what keeps them available to the scoring. */
  it('keeps every status the reporters can produce', () => {
    const document = clone()
    document.tests[testId]?.entries.push(
      { runId: '2', at: '2026-08-02T00:00:00.000Z', status: 'failed', flakyWithinRun: false },
      { runId: '3', at: '2026-08-03T00:00:00.000Z', status: 'timedOut', flakyWithinRun: false },
      { runId: '4', at: '2026-08-04T00:00:00.000Z', status: 'skipped', flakyWithinRun: false },
    )
    expect(parseHistory(document, 'h.json').tests[testId]?.entries).toHaveLength(4)
  })
})

describe('refusing a document it cannot use', () => {
  /**
   * The version is read before the shape. A rollback reading a newer file would
   * otherwise be told its fields are unrecognised, which reads like corruption
   * and sends whoever is on the pipeline looking in the wrong place.
   */
  it('names both versions when they disagree', () => {
    const future = { ...clone(), schemaVersion: HISTORY_SCHEMA_VERSION + 1 }
    try {
      parseHistory(future, '.flakemetry/history.json')
      expect.unreachable('a version mismatch must not parse')
    } catch (error) {
      expect(error).toBeInstanceOf(HistoryUnreadableError)
      expect((error as HistoryUnreadableError).reason).toBe('version')
      expect((error as Error).message).toContain(String(HISTORY_SCHEMA_VERSION + 1))
      expect((error as Error).message).toContain(String(HISTORY_SCHEMA_VERSION))
    }
  })

  it('reports a malformed document as invalid rather than as a version problem', () => {
    const broken = { schemaVersion: HISTORY_SCHEMA_VERSION, tests: { x: { entries: [] } } }
    try {
      parseHistory(broken, 'h.json')
      expect.unreachable('a record with no firstSeenAt must not parse')
    } catch (error) {
      expect((error as HistoryUnreadableError).reason).toBe('invalid')
      expect((error as Error).message).toContain('firstSeenAt')
    }
  })

  /** An unversioned file is somebody else's JSON, not an older history. */
  it('rejects a document with no version at all', () => {
    expect(() => parseHistory({ tests: {} }, 'h.json')).toThrow(HistoryUnreadableError)
  })

  it('rejects a field nobody declared, because the writer and the reader are the same program', () => {
    const extra = { ...clone(), notes: 'hand-edited' }
    expect(() => parseHistory(extra, 'h.json')).toThrow(HistoryUnreadableError)
  })

  it('rejects a status string that is not a status', () => {
    const document = clone()
    document.tests[testId]?.entries.push({
      runId: '2',
      at: '2026-08-02T00:00:00.000Z',
      status: 'flaky' as never,
      flakyWithinRun: false,
    })
    expect(() => parseHistory(document, 'h.json')).toThrow(HistoryUnreadableError)
  })

  /**
   * Long lists of Zod issues are how a legible error becomes a wall nobody
   * reads. Five, then a count.
   */
  it('shows the first few problems and says how many more there are', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ runId: String(i) }))
    const many = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      tests: { x: { firstSeenAt: '2026-08-01T00:00:00.000Z', entries } },
    }
    try {
      parseHistory(many, 'h.json')
      expect.unreachable('entries missing every field but runId must not parse')
    } catch (error) {
      expect((error as Error).message).toContain('… and')
      expect((error as Error).message).toContain('more')
    }
  })
})

describe('the message a broken history produces', () => {
  const message = new HistoryUnreadableError('.flakemetry/history.json', 'unparsable', 'why')
    .message

  it('names the file', () => {
    expect(message).toContain('.flakemetry/history.json')
  })

  /** Whoever reads this is mid-incident and needs the next command, not a diagnosis. */
  it('gives the command that recovers, and what recovering costs', () => {
    expect(message).toContain('rm .flakemetry/history.json')
    expect(message).toContain('cache, not a source of truth')
    expect(message).toContain('every test reads as new')
  })
})
