import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  GIT_OUTPUT_CAP,
  GIT_TRUNCATED,
  ShallowCheckoutError,
  openRepository,
  type GitReader,
} from './git.js'

/**
 * Against a real repository built by real git, not a mocked client.
 *
 * The claim is that this object cannot write. A mock proves what the mock was
 * told to do; only a real client against a real checkout shows what the surface
 * actually exposes — and the shallow-checkout behaviour, which is the one that
 * bites in CI, exists nowhere except in git itself.
 */

vi.setConfig({ testTimeout: 30_000 })

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

/** Four commits, so `HEAD~1..HEAD` and a shallow clone both have something to say. */
function buildRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sentra-git-'))
  git(dir, ['init', '--quiet', '--initial-branch=main'])

  writeFileSync(join(dir, 'README.md'), '# probe\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'first: the readme'])

  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'board.ts'), 'export const rows = 1\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'second: a module'])

  writeFileSync(join(dir, 'src', 'board.ts'), 'export const rows = 2\nexport const cols = 3\n')
  writeFileSync(join(dir, 'src', 'later.ts'), 'export const added = true\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'third: change one, add one'])

  return dir
}

let repo = ''
let reader: GitReader

beforeAll(() => {
  repo = buildRepository()
  reader = openRepository({ cwd: repo })
})

describe('what the object exposes', () => {
  /**
   * The guardrail, asserted rather than described. `docs/limitations-and-guardrails.md`
   * promises agents never push, tag or commit; this is what makes that a
   * property of the object instead of a habit.
   */
  it('is four reads and nothing else', () => {
    expect(Object.keys(reader).sort()).toEqual(['diff', 'fileAtRef', 'log', 'show'])
  })

  it.each(['push', 'commit', 'add', 'checkout', 'tag', 'raw', 'fetch', 'reset', 'clean'])(
    'has no %s on it, by any route',
    (method) => {
      expect(method in reader).toBe(false)
      expect((reader as unknown as Record<string, unknown>)[method]).toBeUndefined()
    },
  )

  /** A client held on a field is a client somebody reaches through. This one is in a closure. */
  it('holds no reference anybody can reach', () => {
    for (const value of Object.values(reader)) {
      expect(typeof value).toBe('function')
    }
    expect(Object.getOwnPropertyNames(reader).sort()).toEqual(['diff', 'fileAtRef', 'log', 'show'])
  })
})

describe('reading a diff', () => {
  it('returns the patch for the default range', async () => {
    const diff = await reader.diff()
    expect(diff).toContain('src/board.ts')
    expect(diff).toContain('+export const cols = 3')
    expect(diff).toContain('src/later.ts')
  })

  it('takes an explicit range', async () => {
    const diff = await reader.diff({ range: 'HEAD~2..HEAD~1' })
    expect(diff).toContain('src/board.ts')
    expect(diff).not.toContain('src/later.ts')
  })

  it('limits to paths, with the separator so a leading dash stays a path', async () => {
    const diff = await reader.diff({ paths: ['src/later.ts'] })
    expect(diff).toContain('src/later.ts')
    expect(diff).not.toContain('+export const cols = 3')
  })

  /**
   * The reason `--` is there. Without it git reads a leading dash as an option
   * and fails, or worse, matches something else — and a filename beginning with
   * a dash is exactly the sort of thing a contributor adds once and nobody tests
   * against.
   */
  it('treats a path that looks like a flag as a path', async () => {
    const odd = mkdtempSync(join(tmpdir(), 'sentra-git-odd-'))
    git(odd, ['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(odd, 'ordinary.ts'), 'export const a = 1\n')
    git(odd, ['add', '--', 'ordinary.ts'])
    git(odd, ['commit', '--quiet', '-m', 'first'])

    writeFileSync(join(odd, '-dashed.ts'), 'export const dashed = true\n')
    writeFileSync(join(odd, 'ordinary.ts'), 'export const a = 2\n')
    git(odd, ['add', '--', '-dashed.ts', 'ordinary.ts'])
    git(odd, ['commit', '--quiet', '-m', 'second'])

    const diff = await openRepository({ cwd: odd }).diff({ paths: ['-dashed.ts'] })
    expect(diff).toContain('-dashed.ts')
    expect(diff).not.toContain('export const a = 2')
  })

  it('can report the shape instead of the text', async () => {
    const stat = await reader.diff({ summaryOnly: true })
    expect(stat).toContain('src/board.ts')
    expect(stat).not.toContain('+export const cols')
  })
})

describe('reading history', () => {
  it('returns commits newest first', async () => {
    const log = await reader.log()
    expect(log.map((c) => c.subject)).toEqual([
      'third: change one, add one',
      'second: a module',
      'first: the readme',
    ])
  })

  it('carries a full hash and an ISO date', async () => {
    const [head] = await reader.log({ maxCount: 1 })
    expect(head?.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(head?.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('honours a count', async () => {
    expect(await reader.log({ maxCount: 2 })).toHaveLength(2)
  })

  it('shows a commit', async () => {
    const shown = await reader.show('HEAD')
    expect(shown).toContain('third: change one, add one')
    expect(shown).toContain('src/later.ts')
  })
})

describe('reading a file at a ref', () => {
  it('returns the contents as they were then', async () => {
    expect(await reader.fileAtRef('HEAD~1', 'src/board.ts')).toBe('export const rows = 1\n')
    expect(await reader.fileAtRef('HEAD', 'src/board.ts')).toContain('cols = 3')
  })

  /**
   * `null` rather than a throw. A file that did not exist yet is the ordinary
   * case when the diff added it, and making the caller tell that apart from a
   * real failure by parsing an error message is how a missing file becomes a
   * crashed run.
   */
  it('is null for a path that did not exist at that ref', async () => {
    expect(await reader.fileAtRef('HEAD~2', 'src/later.ts')).toBeNull()
  })

  it('is null for a path that never existed at all', async () => {
    expect(await reader.fileAtRef('HEAD', 'src/imaginary.ts')).toBeNull()
  })
})

describe('the read ceiling', () => {
  /**
   * Not the cap that shapes a prompt — `sanitise.ts` does that at 12,000
   * characters. This is a ceiling on what enters the process at all, so a merge
   * touching ten thousand files cannot be read into a string before being thrown
   * away downstream.
   */
  it('is far above the prompt cap, so only one of them decides what the model sees', () => {
    expect(GIT_OUTPUT_CAP).toBeGreaterThan(100_000)
  })

  it('marks a truncated read rather than letting it read as complete', async () => {
    const big = mkdtempSync(join(tmpdir(), 'sentra-git-big-'))
    git(big, ['init', '--quiet', '--initial-branch=main'])
    writeFileSync(join(big, 'a.txt'), 'x\n')
    git(big, ['add', '.'])
    git(big, ['commit', '--quiet', '-m', 'first'])
    // Comfortably past the ceiling, in one file so the diff is one hunk.
    writeFileSync(join(big, 'a.txt'), `${'y'.repeat(80)}\n`.repeat(GIT_OUTPUT_CAP / 40))
    git(big, ['add', '.'])
    git(big, ['commit', '--quiet', '-m', 'second: a great deal of y'])

    const diff = await openRepository({ cwd: big }).diff()
    expect(diff.endsWith(GIT_TRUNCATED)).toBe(true)
    expect(diff).toHaveLength(GIT_OUTPUT_CAP + GIT_TRUNCATED.length)
  })
})

describe('a checkout without the history it needs', () => {
  /**
   * `actions/checkout` clones shallow by default, and on a shallow clone
   * `git diff HEAD~1` does not return an empty diff — it fails, with a message
   * about a bad object rather than about depth. Reported as an ordinary git
   * error it sends whoever is on the pipeline looking for a corrupt repository.
   */
  it('names the depth, not the object', async () => {
    const shallow = mkdtempSync(join(tmpdir(), 'sentra-git-shallow-'))
    git(shallow, ['clone', '--quiet', '--depth', '1', `file://${repo}`, 'checkout'])
    const shallowReader = openRepository({ cwd: join(shallow, 'checkout') })

    await expect(shallowReader.diff({ range: 'HEAD~1..HEAD' })).rejects.toThrow(
      ShallowCheckoutError,
    )
    await expect(shallowReader.diff({ range: 'HEAD~1..HEAD' })).rejects.toThrow(/fetch-depth: 0/)
  })

  /**
   * The same message on a full checkout would be a lie, and a lie that sends
   * somebody to edit CI when they mistyped a ref.
   */
  it('does not blame depth for a bad ref in a checkout that has everything', async () => {
    await expect(reader.diff({ range: 'no-such-ref..HEAD' })).rejects.not.toThrow(
      ShallowCheckoutError,
    )
    await expect(reader.diff({ range: 'no-such-ref..HEAD' })).rejects.toThrow()
  })
})
