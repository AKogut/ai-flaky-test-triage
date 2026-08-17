import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFixtures, loadLabels } from './dataset.js'
import {
  appendHoldoutRun,
  consultsHoldout,
  emptyHoldoutBuckets,
  HOLDOUT_LOG,
  HOLDOUT_SHARE,
  inSlice,
  isoDate,
  lastEvaluated,
  overuse,
  overuseWarning,
  OVERUSE_LIMIT,
  readHoldoutLog,
  sliceComposition,
  sliceOf,
  uniformOf,
  type HoldoutRun,
} from './slices.js'

describe('the split rule', () => {
  it('pins the hash construction', () => {
    // Changing this re-slices the dataset and invalidates every held-out number
    // ever published. It should be impossible to do accidentally, so the values
    // are pinned rather than merely the behaviour.
    expect(uniformOf('a')).toBeCloseTo(0.791374270339, 11)
    expect(uniformOf('')).toBeCloseTo(0.889415994752, 11)
    expect(uniformOf('sentra')).toBeCloseTo(0.074094691779, 11)
  })

  it('agrees with the construction spelled out, not just with itself', () => {
    // A pinned constant catches a changed hash but not a test written against
    // the implementation it is checking. This recomputes the rule from its
    // description: first four bytes of SHA-256, big-endian, over 2^32.
    const bytes = createHash('sha256').update('sentra').digest()
    const manual =
      ((bytes[0] ?? 0) * 2 ** 24 +
        (bytes[1] ?? 0) * 2 ** 16 +
        (bytes[2] ?? 0) * 2 ** 8 +
        (bytes[3] ?? 0)) /
      2 ** 32
    expect(uniformOf('sentra')).toBe(manual)
  })

  it('produces values in [0, 1)', () => {
    for (let i = 0; i < 2000; i++) {
      const u = uniformOf(`fixture-${String(i)}`)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThan(1)
    }
  })

  it('lands near the target share over many names', () => {
    // Not a claim about the 35 committed fixtures, which are far too few for
    // this to hold — a claim about the rule itself being unbiased.
    const held = Array.from({ length: 20_000 }, (_, i) => sliceOf(`f${String(i)}`)).filter(
      (s) => s === 'holdout',
    ).length
    expect(held / 20_000).toBeCloseTo(HOLDOUT_SHARE, 2)
  })

  it('is a pure function of the name', () => {
    expect(sliceOf('same-name')).toBe(sliceOf('same-name'))
  })
})

describe('adding a fixture never moves an existing one', () => {
  /**
   * The property the whole design is built around. Its failure is silent and
   * permanent: a fixture that changes slice invalidates every held-out number
   * published before the change, with nothing going red.
   */
  it('leaves all 35 committed fixtures where they were after 500 more arrive', () => {
    const before = new Map(listFixtures().map((name) => [name, sliceOf(name)]))

    const grown = [...listFixtures(), ...Array.from({ length: 500 }, (_, i) => `new-${String(i)}`)]
    const after = new Map(grown.map((name) => [name, sliceOf(name)]))

    for (const [name, slice] of before) expect(after.get(name), name).toBe(slice)
  })

  it('leaves the rest in place when a fixture is removed', () => {
    const all = listFixtures()
    const withoutFirst = all.slice(1)
    for (const name of withoutFirst) {
      expect(sliceOf(name)).toBe(new Map(all.map((n) => [n, sliceOf(n)])).get(name))
    }
  })

  it('treats a rename as a different fixture, which is the documented cost', () => {
    // Renaming can move a fixture across the boundary. It is a deliberate,
    // reviewable act on a file, unlike an insertion elsewhere in the directory.
    const moved = Array.from({ length: 50 }, (_, i) => `probe-${String(i)}`).filter(
      (name, _i, list) => sliceOf(name) !== sliceOf(`${list[0] ?? ''}-renamed`),
    )
    expect(moved.length).toBeGreaterThan(0)
  })
})

describe('slice selectors', () => {
  it('all includes both slices', () => {
    for (const name of listFixtures()) expect(inSlice(name, 'all')).toBe(true)
  })

  it('dev and holdout partition the dataset', () => {
    const dev = listFixtures().filter((n) => inSlice(n, 'dev'))
    const holdout = listFixtures().filter((n) => inSlice(n, 'holdout'))
    expect(dev.length + holdout.length).toBe(listFixtures().length)
    expect(dev.filter((n) => holdout.includes(n))).toEqual([])
  })

  it('counts --slice=all as consulting the held-out set', () => {
    // The loophole worth closing. Scoring everything reads the held-out fixtures
    // just as surely as asking for them by name.
    expect(consultsHoldout('all')).toBe(true)
    expect(consultsHoldout('holdout')).toBe(true)
    expect(consultsHoldout('dev')).toBe(false)
  })
})

describe('composition', () => {
  const fixtures = [
    { name: 'a', bucket: 'one' },
    { name: 'b', bucket: 'one' },
    { name: 'c', bucket: 'two' },
  ]

  it('counts each bucket into its slices', () => {
    const rows = sliceComposition(fixtures)
    expect(rows.map((r) => r.bucket)).toEqual(['one', 'two'])
    for (const row of rows) expect(row.dev + row.holdout).toBe(row.total)
  })

  it('sorts buckets so the report does not churn', () => {
    expect(
      sliceComposition([
        { name: 'a', bucket: 'zeta' },
        { name: 'b', bucket: 'alpha' },
      ]).map((r) => r.bucket),
    ).toEqual(['alpha', 'zeta'])
  })

  it('names buckets the held-out slice says nothing about', () => {
    expect(emptyHoldoutBuckets([{ bucket: 'empty', total: 5, dev: 5, holdout: 0 }])).toEqual([
      'empty',
    ])
  })

  it('does not name a bucket that has no fixtures at all', () => {
    // Nothing held out because nothing exists is not a gap in the split.
    expect(emptyHoldoutBuckets([{ bucket: 'unused', total: 0, dev: 0, holdout: 0 }])).toEqual([])
  })
})

describe('the committed dataset split', () => {
  const composition = sliceComposition(
    listFixtures().map((name) => ({ name, bucket: loadLabels(name).bucket })),
  )
  const held = composition.reduce((n, row) => n + row.holdout, 0)

  it('holds out 12 of 35', () => {
    // Pinned. 34% against a 20% target is ordinary binomial variance at n=35
    // (sd ≈ 2.4 on an expected 7), not a defect in the rule. If this number
    // moves without a fixture being added, the rule changed.
    expect(held).toBe(12)
  })

  it('currently holds out at least one fixture from every bucket', () => {
    // Not guaranteed by the rule — a bucket of four has a 41% chance of getting
    // none. It happens to hold today, and the report says so rather than
    // implying the split guarantees it.
    expect(emptyHoldoutBuckets(composition)).toEqual([])
  })

  it('leaves enough in the development slice to iterate against', () => {
    expect(composition.reduce((n, row) => n + row.dev, 0)).toBe(23)
  })
})

// ---------------------------------------------------------------------------

const run = (over: Partial<HoldoutRun> = {}): HoldoutRun => ({
  date: '2026-08-01',
  datasetRevision: 'abcd',
  slice: 'holdout',
  n: 11,
  jointAccuracy: 0.5,
  ...over,
})

describe('the held-out usage log', () => {
  const tempLog = (): string => join(mkdtempSync(join(tmpdir(), 'sentra-slices-')), 'log.json')

  it('reads an absent file as no runs rather than throwing', () => {
    // A fresh clone before the first held-out evaluation is a normal state.
    expect(readHoldoutLog(join(tempLog(), 'missing.json'))).toEqual([])
  })

  it('round-trips a run', () => {
    const path = tempLog()
    appendHoldoutRun(run(), path)
    expect(readHoldoutLog(path)).toEqual([run()])
  })

  it('appends rather than replacing', () => {
    const path = tempLog()
    appendHoldoutRun(run({ date: '2026-08-01' }), path)
    appendHoldoutRun(run({ date: '2026-08-02' }), path)
    expect(readHoldoutLog(path).map((r) => r.date)).toEqual(['2026-08-01', '2026-08-02'])
  })

  it('rejects a malformed log instead of silently starting over', () => {
    // Treating a corrupt log as empty would reset the usage budget, which is the
    // one thing the log exists to make un-resettable.
    const path = tempLog()
    writeFileSync(path, JSON.stringify({ runs: [{ date: 'yesterday' }] }))
    expect(() => readHoldoutLog(path)).toThrow(/not a valid held-out log/)
  })

  it('writes readable JSON with a trailing newline', () => {
    const path = tempLog()
    appendHoldoutRun(run(), path)
    const raw = readFileSync(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('\n  "runs"')
  })

  it('refuses a run with a malformed date', () => {
    expect(() => appendHoldoutRun(run({ date: '11/08/2026' }), tempLog())).toThrow()
  })
})

describe('overuse', () => {
  const on = (date: string): Date => new Date(`${date}T00:00:00Z`)

  it('counts nothing when the slice is untouched', () => {
    expect(overuse([], on('2026-08-11'))).toMatchObject({ within: 0, overused: false })
  })

  it('counts runs inside the window', () => {
    const runs = ['2026-08-01', '2026-08-05', '2026-08-10'].map((date) => run({ date }))
    expect(overuse(runs, on('2026-08-11')).within).toBe(3)
  })

  it('ignores runs outside the window', () => {
    const runs = [run({ date: '2026-06-01' }), run({ date: '2026-08-10' })]
    expect(overuse(runs, on('2026-08-11')).within).toBe(1)
  })

  it('includes a run exactly on the window boundary', () => {
    // 30 days back inclusive. An off-by-one here silently loosens the budget.
    expect(overuse([run({ date: '2026-07-12' })], on('2026-08-11')).within).toBe(1)
    expect(overuse([run({ date: '2026-07-11' })], on('2026-08-11')).within).toBe(0)
  })

  it('fires above the limit, not at it', () => {
    const three = Array.from({ length: OVERUSE_LIMIT }, () => run({ date: '2026-08-10' }))
    expect(overuse(three, on('2026-08-11')).overused).toBe(false)
    expect(overuse([...three, run({ date: '2026-08-10' })], on('2026-08-11')).overused).toBe(true)
  })

  it('explains what overuse costs, not just that it happened', () => {
    const warning = overuseWarning(
      overuse(
        Array.from({ length: 9 }, () => run({ date: '2026-08-10' })),
        on('2026-08-11'),
      ),
    )
    expect(warning).toContain('development set with extra')
    expect(warning).toContain('--slice=dev')
  })

  it('says nothing when the budget is intact', () => {
    expect(overuseWarning(overuse([], on('2026-08-11')))).toBeNull()
  })
})

describe('lastEvaluated', () => {
  it('is null before the first evaluation', () => {
    expect(lastEvaluated([])).toBeNull()
  })

  it('takes the latest date regardless of log order', () => {
    expect(lastEvaluated([run({ date: '2026-08-10' }), run({ date: '2026-01-01' })])).toBe(
      '2026-08-10',
    )
  })
})

describe('isoDate', () => {
  it('is day precision in UTC', () => {
    expect(isoDate(new Date('2026-08-11T23:59:59Z'))).toBe('2026-08-11')
  })
})

describe('the committed log', () => {
  it('parses', () => {
    expect(() => readHoldoutLog(HOLDOUT_LOG)).not.toThrow()
  })

  it('is within the usage budget', () => {
    // If this ever fails, the held-out slice is being consulted like a
    // development set and the number it produces has stopped meaning much.
    const runs = readHoldoutLog(HOLDOUT_LOG)
    expect(overuse(runs, new Date()).overused).toBe(false)
  })
})
