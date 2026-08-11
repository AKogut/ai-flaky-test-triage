import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listFixtures, loadLabels, loadPayload } from './dataset.js'
import { main as hygieneMain } from './hygiene.js'
import { main as evalMain } from './run-eval.js'

/**
 * The command-line surfaces and the guards that only fire when something is
 * wrong.
 *
 * These paths were the least covered in the repository, which is the wrong way
 * round: a guard whose failing branch has never run is a guard nobody has
 * watched work, and an exit code nothing asserts is a CI gate that might be
 * returning zero on failure.
 */

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'sentra-cli-'))

beforeEach(quiet)
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// dataset.ts guards
// ---------------------------------------------------------------------------

describe('the dataset refuses to load something incomplete', () => {
  const dir = (files: Record<string, unknown>): string => {
    const path = scratch()
    for (const [file, body] of Object.entries(files)) {
      writeFileSync(join(path, file), JSON.stringify(body))
    }
    return path
  }

  const payload = loadPayload(listFixtures()[0] ?? '').payload
  const labels = loadLabels(listFixtures()[0] ?? '')

  it('throws on a payload with no labels rather than scoring fewer fixtures than it says', () => {
    // The failure this prevents is silent: the fixture simply vanishes, and
    // every published metric is computed over a smaller dataset than the report
    // claims.
    const path = dir({ 'orphan.run.json': { ...payload, name: 'orphan' } })
    expect(() => listFixtures(path)).toThrow(/Incomplete fixtures/)
    expect(() => listFixtures(path)).toThrow(/orphan\.run\.json has no \.labels\.json/)
  })

  it('throws on labels with no payload', () => {
    const path = dir({ 'orphan.labels.json': { ...labels, name: 'orphan' } })
    expect(() => listFixtures(path)).toThrow(/orphan\.labels\.json has no \.run\.json/)
  })

  it('names every orphan, not just the first', () => {
    const path = dir({
      'a.run.json': { ...payload, name: 'a' },
      'b.run.json': { ...payload, name: 'b' },
    })
    const message = (() => {
      try {
        listFixtures(path)
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : ''
      }
    })()
    expect(message).toContain('a.run.json')
    expect(message).toContain('b.run.json')
  })

  it('refuses a payload whose declared name disagrees with its filename', () => {
    // Two names for one fixture means a report row and a labels file that look
    // related and are not.
    const path = dir({
      'stated-one-thing.run.json': { ...payload, name: 'declares-another' },
      'stated-one-thing.labels.json': { ...labels, name: 'stated-one-thing' },
    })
    expect(() => loadPayload('stated-one-thing', path)).toThrow(/the two must match/)
  })

  it('refuses labels whose declared name disagrees with the filename', () => {
    const path = dir({
      'stated-one-thing.run.json': { ...payload, name: 'stated-one-thing' },
      'stated-one-thing.labels.json': { ...labels, name: 'declares-another' },
    })
    expect(() => loadLabels('stated-one-thing', path)).toThrow(/the two must match/)
  })

  it('ignores files that are neither half of a fixture', () => {
    const path = dir({
      'a.run.json': { ...payload, name: 'a' },
      'a.labels.json': { ...labels, name: 'a' },
    })
    writeFileSync(join(path, 'README.md'), '# not a fixture')
    expect(listFixtures(path)).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// npm run eval:lint
// ---------------------------------------------------------------------------

describe('the hygiene CLI', () => {
  it('passes on the committed dataset', () => {
    expect(hygieneMain()).toBe(0)
  })

  it('returns a failing code when a fixture is incomplete', () => {
    // Previously this branch called process.exit, so nothing could assert it —
    // the one path that fails the build was the one path never exercised.
    const path = scratch()
    const first = listFixtures()[0] ?? ''
    writeFileSync(
      join(path, 'lonely.run.json'),
      JSON.stringify({ ...loadPayload(first).payload, name: 'lonely' }),
    )
    expect(hygieneMain(path)).toBe(1)
  })

  it('returns zero for an empty directory, which is unfinished rather than broken', () => {
    expect(hygieneMain(scratch())).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// npm run eval
// ---------------------------------------------------------------------------

describe('the eval CLI', () => {
  it('writes a report and its metrics, and says where', async () => {
    const out = join(scratch(), 'report.md')
    expect(await evalMain([`--out=${out}`])).toBe(0)
    expect(existsSync(out)).toBe(true)
    expect(existsSync(out.replace(/\.md$/, '.metrics.json'))).toBe(true)
  })

  it('keeps the metrics beside a redirected report rather than clobbering the committed pair', () => {
    // `--out=/tmp/x.md` writing eval/metrics.json would silently overwrite the
    // file the gate compares against.
    const out = join(scratch(), 'report.md')
    expect(existsSync('eval/metrics.json')).toBe(true)
    const before = readFileSync('eval/metrics.json', 'utf8')
    return evalMain([`--out=${out}`]).then(() => {
      expect(readFileSync('eval/metrics.json', 'utf8')).toBe(before)
    })
  })

  it.each([
    ['an unknown flag', ['--slyce=dev']],
    ['a bare argument', ['dev']],
    ['a bad value', ['--slice=everything']],
    ['a fractional sample count', ['--n=1.5']],
  ])('exits 2 on %s', async (_case, argv) => {
    // Distinct from 1: usage errors are the caller's mistake, threshold
    // failures are the classifier's, and CI reads the difference.
    expect(await evalMain(argv)).toBe(2)
  })

  it('exits 2 on a capability that does not exist yet', async () => {
    expect(await evalMain(['--classifier=agent'])).toBe(2)
  })

  it('exits 1 when the report it is gating on is missing', async () => {
    const out = join(scratch(), 'nothing-here.md')
    expect(await evalMain(['--gate', `--out=${out}`])).toBe(1)
  })

  it('exits 1 when the committed report is stale', async () => {
    const out = join(scratch(), 'report.md')
    await evalMain([`--out=${out}`])
    writeFileSync(out, `${readFileSync(out, 'utf8')}\nedited by hand\n`)
    expect(await evalMain(['--gate', `--out=${out}`])).toBe(1)
  })

  it('exits 0 when the committed report is current', async () => {
    const out = join(scratch(), 'report.md')
    await evalMain([`--out=${out}`])
    expect(await evalMain(['--gate', `--out=${out}`])).toBe(0)
  })

  it('gates on the committed report in the repository', async () => {
    // The check CI runs, run here so the failure arrives before the push.
    expect(await evalMain(['--gate'])).toBe(0)
  })

  it('notes that sampling the baseline more than once is wasted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await evalMain([`--out=${join(scratch(), 'r.md')}`, '--n=5'])
    expect(log.mock.calls.flat().join('\n')).toContain('deterministic')
  })

  it('does not touch the held-out log while gating', async () => {
    // A verification is not a consultation. If `--gate` logged, CI would spend
    // the budget on work nobody chose to do.
    const before = readFileSync('eval/holdout-log.json', 'utf8')
    await evalMain(['--gate'])
    expect(readFileSync('eval/holdout-log.json', 'utf8')).toBe(before)
  })
})
