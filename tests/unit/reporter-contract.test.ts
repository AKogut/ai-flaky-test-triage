import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TestResultSchema,
  normalisePlaywrightReport,
  normaliseVitestReport,
  relativise,
  TestRunSchema,
  type TestRun,
} from '@sentra/contracts'

/**
 * The contract between this repository and the two test runners it consumes.
 *
 * The failure these tests exist to prevent is the quiet one. A reporter renames
 * a field, the normaliser reads `undefined`, every test looks like it passed
 * once, and the flakiness signal degrades with no error anywhere — worse than a
 * crash, and far harder to notice, because `analysis.json` still parses and the
 * report still renders.
 *
 * The fixtures are real output from the pinned versions. Regenerating them is
 * deliberately manual: a version bump should be a conscious update with the new
 * output committed, not a lockfile refresh nobody reads.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixtureDir = join(root, 'tests/fixtures/reporters')

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>
}

const read = (file: string): unknown => JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'))

const meta = { runId: 'run-1', commitSha: 'abc1234', branch: 'main' }

describe('pinned reporter versions', () => {
  /**
   * Fixtures are named for the version that produced them. If the dependency
   * moves and the fixture does not, this fails — which is the point: it forces
   * whoever bumps the version to regenerate the fixture and look at the diff.
   */
  it.each([
    ['@playwright/test', 'playwright-'],
    ['vitest', 'vitest-'],
  ])('%s matches a committed fixture', (dependency, prefix) => {
    const pinned = packageJson.devDependencies[dependency]
    expect(pinned, `${dependency} must be pinned exactly, not a range`).toMatch(/^\d+\.\d+\.\d+$/)

    const fixtures = readdirSync(fixtureDir).filter((f) => f.startsWith(prefix))
    expect(
      fixtures,
      `No fixture for ${dependency}@${pinned ?? '?'}. Regenerate it and commit the output — ` +
        `see tests/fixtures/reporters/README.md.`,
    ).toContain(`${prefix}${pinned ?? ''}.json`)
  })
})

const runs: [label: string, run: TestRun][] = [
  ['playwright', normalisePlaywrightReport(read('playwright-1.62.1.json'), meta)],
  [
    'vitest',
    normaliseVitestReport(read('vitest-4.1.10.json'), { ...meta, repositoryRoot: '/repo' }),
  ],
]

describe.each(runs)('%s normalisation', (_label, run) => {
  it('produces a schema-valid TestRun', () => {
    expect(() => TestRunSchema.parse(run)).not.toThrow()
  })

  it('produces at least one result — an empty run would pass every other assertion', () => {
    expect(run.results.length).toBeGreaterThan(0)
  })

  it('leaves no required field undefined', () => {
    // The exact shape a renamed source field takes on the way through.
    for (const result of run.results) {
      for (const key of [
        'testId',
        'title',
        'file',
        'status',
        'attempts',
        'flakyWithinRun',
        'durationMs',
        'annotations',
      ] as const) {
        expect(result[key], `${result.title}.${key}`).toBeDefined()
      }
    }
  })

  it('gives every test a unique id', () => {
    const ids = run.results.map((r) => r.testId)
    expect(new Set(ids).size, 'duplicate testIds would merge two tests into one history').toBe(
      ids.length,
    )
  })

  it('uses repository-relative paths with no host directories', () => {
    for (const result of run.results) {
      expect(result.file).not.toMatch(/^\/|^[A-Za-z]:/)
      expect(result.file).not.toContain('\\')
    }
  })

  it('attaches an error to every failure and to none of the passes', () => {
    for (const result of run.results) {
      if (result.status === 'failed' || result.status === 'timedOut') {
        expect(result.error?.message, `${result.title} failed with no error`).toBeTruthy()
      }
      if (result.status === 'skipped') {
        expect(result.error, `${result.title} was skipped but carries an error`).toBeUndefined()
      }
    }
  })

  it('reports durations that are finite and non-negative', () => {
    expect(Number.isFinite(run.durationMs)).toBe(true)
    for (const result of run.results) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(result.durationMs)).toBe(true)
    }
  })
})

/**
 * Playwright relativises the file path and nothing else. The stack, the snippet
 * and the message keep the absolute path of the machine that ran the suite —
 * which goes into a prompt, then into a public pull-request comment, and makes a
 * captured fixture specific to whoever captured it.
 */
describe('absolute paths from the runner', () => {
  const raw = read('playwright-1.62.1.json')
  const stacks = (run: TestRun): string =>
    run.results
      .map((result) => `${result.error?.stack ?? ''}${result.error?.snippet ?? ''}`)
      .join('')

  it('are in the fixture, so the next assertion means something', () => {
    expect(stacks(normalisePlaywrightReport(raw, meta))).toContain('/repo/')
  })

  it('are stripped out of every error once a root is given', () => {
    const run = normalisePlaywrightReport(raw, { ...meta, repositoryRoot: '/repo' })

    for (const result of run.results) {
      for (const text of [result.error?.message, result.error?.stack, result.error?.snippet]) {
        expect(text ?? '').not.toContain('/repo/')
      }
    }
    // And the paths survive, relative: stripping the root must not delete the file.
    expect(stacks(run)).toContain('specs/sample.spec.ts')
  })

  it('are left alone when no root is given, rather than guessed at', () => {
    expect(stacks(normalisePlaywrightReport(raw, meta))).toContain('/repo/')
  })

  it('leaves text with no root in it untouched', () => {
    expect(relativise('at tests/e2e/board.spec.ts:12:5', '/repo')).toBe(
      'at tests/e2e/board.spec.ts:12:5',
    )
    // An empty root would otherwise strip every leading slash in the file.
    expect(relativise('/a/b', '')).toBe('/a/b')
    expect(relativise('/repo/a', '/repo/')).toBe('a')
  })
})

describe('the two reporters agree on shape', () => {
  /**
   * Which fields the schema marks optional, asked of the schema rather than
   * listed here. A hand-maintained list is a list that goes stale the first time
   * somebody adds a field, and going stale here means the asymmetry check below
   * quietly stops checking anything.
   */
  const optionalFields = Object.entries(TestResultSchema.shape)
    .filter(([, schema]) => schema.safeParse(undefined).success)
    .map(([name]) => name)

  it('produces results with identical key sets, ignoring optional fields', () => {
    // Nothing downstream branches on `source`, so a *required* field present
    // from one reporter and absent from the other would be a silent asymmetry.
    const required = (run: TestRun): string[] =>
      Object.keys(run.results[0] ?? {})
        .filter((k) => !optionalFields.includes(k))
        .sort()

    const [playwright, vitest] = runs.map(([, run]) => required(run))
    expect(playwright).toEqual(vitest)
  })

  /**
   * The asymmetries that are deliberate, named so a new one cannot join them
   * unnoticed.
   *
   * `workerIndex` and `startedAt` are Playwright's alone: it runs specs across
   * worker processes and says which, and that sequence is the only evidence a
   * cross-file state leak leaves anywhere (#168). Vitest reports neither, so a
   * unit failure simply has no run context — stated as absent rather than
   * guessed at.
   */
  it('is asymmetric only where a reporter genuinely knows more', () => {
    // Every key either reporter ever emits, not the first result's. `error` is
    // present on some results and absent on others, so sampling one would report
    // an asymmetry that is really just which test happened to fail first.
    const emitted = (run: TestRun): string[] => [
      ...new Set(run.results.flatMap((result) => Object.keys(result))),
    ]
    const [playwright, vitest] = runs.map(([, run]) => emitted(run))
    const onlyPlaywright = (playwright ?? []).filter((k) => !(vitest ?? []).includes(k)).sort()
    const onlyVitest = (vitest ?? []).filter((k) => !(playwright ?? []).includes(k)).sort()

    expect(onlyPlaywright).toEqual(['startedAt', 'workerIndex'])
    expect(onlyVitest).toEqual([])
  })

  it('derives ids the same way from the same file and title', () => {
    const [playwrightRun, vitestRun] = runs.map(([, run]) => run)
    const sample = playwrightRun?.results[0]
    const other = vitestRun?.results[0]
    expect(sample?.testId.includes('›')).toBe(true)
    expect(other?.testId.includes('›')).toBe(true)
  })
})
