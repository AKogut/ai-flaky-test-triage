import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClassificationInputSchema } from '@sentra/contracts'
import { describe, expect, it, vi } from 'vitest'
import { DIFF_CUT, DIFF_LIMIT, diffRange, fitDiff, readDiff } from './diff.js'
import { openRepository, type GitReader } from './git.js'

/**
 * Which diff a run reads, and what it does when git cannot answer.
 *
 * Most of this needs no repository: the range is a function of the environment
 * and the failure handling is a function of a rejected promise. The part a fake
 * cannot prove is what the range *means* — that three dots against the base
 * leave out what the base gained since — so that part runs against a real
 * repository built by real git, the same way `git.test.ts` does.
 */

vi.setConfig({ testTimeout: 30_000 })

const reader = (diff: GitReader['diff']): GitReader => ({
  diff,
  log: () => Promise.resolve([]),
  show: () => Promise.resolve(''),
  fileAtRef: () => Promise.resolve(null),
})

describe('the range', () => {
  it('is everything since the merge base on a pull request', () => {
    expect(diffRange({ GITHUB_BASE_REF: 'main' })).toBe('origin/main...HEAD')
    expect(diffRange({ GITHUB_BASE_REF: 'release/1.x' })).toBe('origin/release/1.x...HEAD')
  })

  /** GitHub sets the variable on every event and leaves it empty outside pull requests. */
  it('is the commit against its parent on a push, where the base is empty', () => {
    expect(diffRange({ GITHUB_BASE_REF: '' })).toBe('HEAD~1..HEAD')
  })

  it('is the commit against its parent locally, where the base is unset', () => {
    expect(diffRange({})).toBe('HEAD~1..HEAD')
  })
})

describe('reading it', () => {
  it('asks the facade for that range and returns what it says', async () => {
    const ranges: string[] = []
    const read = await readDiff(
      () =>
        reader((options) => {
          ranges.push(options?.range ?? '')
          return Promise.resolve('diff --git a/x.ts b/x.ts\n')
        }),
      { GITHUB_BASE_REF: 'main' },
    )
    expect(ranges).toEqual(['origin/main...HEAD'])
    expect(read).toEqual({ range: 'origin/main...HEAD', diff: 'diff --git a/x.ts b/x.ts\n' })
  })

  it('returns no diff and no failure for an empty change', async () => {
    expect(await readDiff(() => reader(() => Promise.resolve('')), {})).toEqual({
      range: 'HEAD~1..HEAD',
    })
  })

  it('returns the reason, not a rejection, when git fails', async () => {
    const read = await readDiff(
      () => reader(() => Promise.reject(new Error('fatal: bad revision'))),
      {},
    )
    expect(read).toEqual({ range: 'HEAD~1..HEAD', failure: 'fatal: bad revision' })
  })

  /** Opening is inside the guard: a client that cannot be built is one more way to have no diff. */
  it('returns the reason when the facade cannot be opened at all', async () => {
    const read = await readDiff(() => {
      throw new Error('no such directory')
    }, {})
    expect(read.failure).toBe('no such directory')
    expect(read.diff).toBeUndefined()
  })

  it('describes a thrown non-error rather than losing it', async () => {
    const read = await readDiff(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
      throw 'a string'
    }, {})
    expect(read.failure).toBe('a string')
  })

  it('caps what it returns to the contract', async () => {
    const huge = `diff --git a/x.ts b/x.ts\n${'+line\n'.repeat(10_000)}`
    const read = await readDiff(() => reader(() => Promise.resolve(huge)), {})
    expect(read.diff?.length).toBeLessThanOrEqual(DIFF_LIMIT)
  })
})

describe('fitting the contract', () => {
  it('leaves a diff under the limit exactly as it is', () => {
    expect(fitDiff('diff --git a/x b/x\n+one\n')).toBe('diff --git a/x b/x\n+one\n')
  })

  it('cuts at a line boundary, under the limit, and says it cut', () => {
    const cut = fitDiff(`head\n${'+a line of patch\n'.repeat(50)}`, 200)
    expect(cut.length).toBeLessThanOrEqual(200)
    expect(cut.endsWith(DIFF_CUT)).toBe(true)
    expect(cut.slice(0, -DIFF_CUT.length).endsWith('+a line of patch')).toBe(true)
  })

  it('still fits when there is no line boundary to cut at', () => {
    const cut = fitDiff('x'.repeat(1_000), 200)
    expect(cut.length).toBeLessThanOrEqual(200)
    expect(cut.endsWith(DIFF_CUT)).toBe(true)
  })

  /** The point of the cap: what the pipeline builds is an input the contract accepts. */
  it('produces a diff the classification input contract accepts', () => {
    const subject = {
      result: {
        testId: 't',
        title: 't',
        file: 'tests/e2e/t.spec.ts',
        status: 'failed',
        attempts: 1,
        flakyWithinRun: false,
        durationMs: 1,
        annotations: [],
      },
      signal: {
        testId: 't',
        flakinessScore: 0,
        consecutiveFailures: 1,
        totalRuns: 1,
        firstSeenAt: '2026-08-01T00:00:00.000Z',
        lastPassedAt: null,
        statusHistory: 'F',
        isNew: true,
      },
    }
    const diff = fitDiff(`diff --git a/x b/x\n${'+y\n'.repeat(20_000)}`)
    expect(
      ClassificationInputSchema.safeParse({ subject, diff, historyAvailable: true }).success,
    ).toBe(true)
  })
})

describe('against a real repository', () => {
  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 't@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    })

  const commit = (cwd: string, path: string, contents: string, message: string): void => {
    mkdirSync(join(cwd, path, '..'), { recursive: true })
    writeFileSync(join(cwd, path), contents)
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '--quiet', '-m', message])
  }

  /**
   * A pull request branched from main, and a main that moved on after it did.
   * `refs/remotes/origin/main` is what `actions/checkout` leaves behind with
   * `fetch-depth: 0`, written directly here because there is no remote.
   */
  function pullRequest(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sentra-diff-'))
    git(dir, ['init', '--quiet', '--initial-branch=main'])
    commit(dir, 'app/board.ts', 'export const rows = 1\n', 'base')

    git(dir, ['checkout', '--quiet', '-b', 'feature'])
    commit(dir, 'app/board.ts', 'export const rows = 2\n', 'the pull request')

    git(dir, ['checkout', '--quiet', 'main'])
    commit(dir, 'docs/later.md', '# landed on main afterwards\n', 'main moves on')
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'main'])

    git(dir, ['checkout', '--quiet', 'feature'])
    return dir
  }

  /**
   * Three dots, not two. Two would show the pull request *and* the reverse of
   * everything main gained since it branched, and the baseline would read a
   * file the pull request never touched as one it changed.
   */
  it('shows the pull request and nothing main gained after it branched', async () => {
    const dir = pullRequest()
    const read = await readDiff(() => openRepository({ cwd: dir }), { GITHUB_BASE_REF: 'main' })
    expect(read.failure).toBeUndefined()
    expect(read.diff).toContain('diff --git a/app/board.ts b/app/board.ts')
    expect(read.diff).not.toContain('docs/later.md')
  })

  it('fails, rather than reading as empty, when the base was never fetched', async () => {
    const dir = pullRequest()
    const read = await readDiff(() => openRepository({ cwd: dir }), { GITHUB_BASE_REF: 'gone' })
    expect(read.diff).toBeUndefined()
    expect(read.failure).toMatch(/origin\/gone/)
  })

  it('fails when the directory is not a repository', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sentra-diff-none-'))
    const read = await readDiff(() => openRepository({ cwd: bare }), {})
    expect(read.diff).toBeUndefined()
    expect(read.failure).toMatch(/not a git repository/i)
  })

  /** The checkout `actions/checkout` gives by default, and the one this job opts out of. */
  it('fails, and names the depth, on a shallow clone', async () => {
    const source = pullRequest()
    const shallow = mkdtempSync(join(tmpdir(), 'sentra-diff-shallow-'))
    git(shallow, ['clone', '--quiet', '--depth', '1', `file://${source}`, 'checkout'])
    const read = await readDiff(() => openRepository({ cwd: join(shallow, 'checkout') }), {})
    expect(read.diff).toBeUndefined()
    expect(read.failure).toContain('fetch-depth: 0')
  })
})
