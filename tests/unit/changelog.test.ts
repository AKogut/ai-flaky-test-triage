import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'prettier'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  compareReleases,
  FIELD_SEP,
  isReleaseTag,
  NOTHING_USER_FACING,
  parseCommits,
  parseTags,
  planSections,
  readSections,
  RECORD_SEP,
  renderChangelog,
  renderSection,
  renderSections,
  splice,
} from '../../scripts/changelog.js'

/**
 * The failures worth catching here are the silent ones: a breaking change that
 * never reaches its section, a scope that vanishes, a `git log` field separator
 * that collides with commit body text. All of those produce a changelog that
 * looks fine and is wrong.
 */

const log = (...records: [hash: string, subject: string, body?: string][]): string =>
  records.map(([h, s, b = '']) => `${RECORD_SEP}${h}${FIELD_SEP}${s}${FIELD_SEP}${b}`).join('')

describe('parseCommits', () => {
  it('parses type, scope, subject and pull-request number', () => {
    const [c] = parseCommits(log(['abc1234def', 'feat(triage): add two-axis output schema (#42)']))
    expect(c).toMatchObject({
      hash: 'abc1234def',
      type: 'feat',
      scope: 'triage',
      subject: 'add two-axis output schema',
      breaking: false,
      pr: 42,
    })
  })

  it('treats a scopeless commit as scope null rather than empty string', () => {
    const [c] = parseCommits(log(['a1', 'chore: add husky hooks']))
    expect(c?.scope).toBeNull()
  })

  it('detects a breaking change from the bang', () => {
    const [c] = parseCommits(log(['a1', 'fix(flakemetry)!: change the history merge rule']))
    expect(c?.breaking).toBe(true)
  })

  it('detects a breaking change from the footer and keeps the note', () => {
    const [c] = parseCommits(
      log(['a1', 'feat(eval): version the fixture format', 'BREAKING CHANGE: fixtures need v2']),
    )
    expect(c?.breaking).toBe(true)
    expect(c?.breakingNote).toBe('fixtures need v2')
  })

  it('ignores commits that are not Conventional Commits', () => {
    expect(parseCommits(log(['a1', 'Initial commit'], ['a2', 'feat: real one']))).toHaveLength(1)
  })

  it('does not mistake a mid-subject issue reference for a pull-request number', () => {
    const [c] = parseCommits(log(['a1', 'fix(agents): handle #42 in error text']))
    expect(c?.pr).toBeNull()
    expect(c?.subject).toBe('handle #42 in error text')
  })

  it('survives a body containing the delimiter words', () => {
    const commits = parseCommits(
      log(['a1', 'feat(eval): add metrics', 'We RECORD every FIELD of every sample.']),
    )
    expect(commits).toHaveLength(1)
  })
})

describe('renderChangelog', () => {
  const commits = parseCommits(
    log(
      ['a1', 'feat(triage): add schema (#2)'],
      ['a2', 'feat(agents): add orchestrator (#3)'],
      ['a3', 'fix(eval): correct the Wilson interval (#4)'],
      ['a4', 'chore(deps): bump eslint (#5)'],
      ['a5', 'feat(flakemetry)!: rename the score field (#6)', 'BREAKING CHANGE: field renamed'],
    ),
  )
  const out = renderChangelog(commits, 'Unreleased')

  it('groups by type under readable section titles', () => {
    expect(out).toContain('### Features')
    expect(out).toContain('### Fixes')
  })

  it('hides tooling churn', () => {
    expect(out).not.toContain('bump eslint')
  })

  it('gives breaking changes their own section above the rest', () => {
    expect(out.indexOf('### ⚠ Breaking changes')).toBeLessThan(out.indexOf('### Features'))
    expect(out).toContain('field renamed')
  })

  it('sorts within a section by scope', () => {
    expect(out.indexOf('**agents:**')).toBeLessThan(out.indexOf('**triage:**'))
  })

  it('links to the pull request when there is one', () => {
    expect(out).toContain('/pull/2')
  })

  it('says so plainly when nothing user-facing changed', () => {
    const only = parseCommits(log(['a1', 'chore: tidy up']))
    expect(renderChangelog(only, 'Unreleased')).toContain('_No user-facing changes._')
  })

  it('says what the caller asks it to when nothing user-facing changed', () => {
    const out = renderChangelog([], 'Unreleased', '_No user-facing changes since v0.1.0._')
    expect(out).toBe('## Unreleased\n\n_No user-facing changes since v0.1.0._\n')
  })
})

describe('release tags', () => {
  it.each(['v0.1.0', 'v1.0.0', 'v10.20.30', 'v1.0.0-rc.1', 'v1.0.0-alpha.beta-2', 'v1.0.0-0'])(
    'counts %s',
    (tag) => {
      expect(isReleaseTag(tag)).toBe(true)
    },
  )

  it.each([
    'nightly',
    '0.1.0',
    'v0.1',
    'v0.1.0.1',
    'v01.0.0',
    'v1.0.0-',
    'v1.0.0-rc..1',
    'v1.0.0+build.5',
    'release-v1.0.0',
    'V1.0.0',
  ])('ignores %s', (tag) => {
    expect(isReleaseTag(tag)).toBe(false)
  })

  /** The precedence example from semver §11, in that order, so the spec is the oracle. */
  const SPEC_ORDER = [
    'v1.0.0-alpha',
    'v1.0.0-alpha.1',
    'v1.0.0-alpha.beta',
    'v1.0.0-beta',
    'v1.0.0-beta.2',
    'v1.0.0-beta.11',
    'v1.0.0-rc.1',
    'v1.0.0',
  ]

  it('orders pre-releases the way semver does', () => {
    const scrambled = [
      'v1.0.0-beta.11',
      'v1.0.0',
      'v1.0.0-alpha.beta',
      'v1.0.0-rc.1',
      'v1.0.0-alpha',
      'v1.0.0-beta.2',
      'v1.0.0-alpha.1',
      'v1.0.0-beta',
    ]
    expect(scrambled.sort(compareReleases)).toEqual(SPEC_ORDER)
  })

  it('orders by number, where a string sort puts v0.10.0 before v0.9.0', () => {
    const tags = ['v0.10.0', 'v0.9.0', 'v1.0.0', 'v0.9.1', 'v0.2.0']
    expect(tags.sort(compareReleases)).toEqual(['v0.2.0', 'v0.9.0', 'v0.9.1', 'v0.10.0', 'v1.0.0'])
  })

  it('puts a numeric pre-release identifier below an alphanumeric one', () => {
    expect(compareReleases('v1.0.0-1', 'v1.0.0-alpha')).toBeLessThan(0)
  })

  it('refuses to order a name that is not a release tag', () => {
    expect(() => compareReleases('v1.0.0', 'nightly')).toThrow(/nightly/)
  })
})

describe('parseTags', () => {
  const refs = (...rows: [name: string, peeled: string, direct: string][]): string =>
    rows.map((row) => row.join(FIELD_SEP)).join('\n') + '\n'

  it('dates an annotated tag by its commit and a lightweight one by its own ref', () => {
    expect(parseTags(refs(['v0.1.0', '', '2026-01-15'], ['v0.2.0', '2026-02-20', '']))).toEqual([
      { name: 'v0.1.0', date: '2026-01-15' },
      { name: 'v0.2.0', date: '2026-02-20' },
    ])
  })

  it('drops tags that are not releases, and tags that do not point at a commit', () => {
    const tags = parseTags(
      refs(['nightly', '', '2026-01-01'], ['v0.1.0', '', '2026-01-15'], ['v0.3.0', '', '']),
    )
    expect(tags.map((t) => t.name)).toEqual(['v0.1.0'])
  })

  it('is empty for a repository with no tags', () => {
    expect(parseTags('')).toEqual([])
  })
})

describe('planSections', () => {
  it('is one Unreleased section over all history when there are no tags', () => {
    expect(planSections([])).toEqual([
      { name: 'Unreleased', heading: 'Unreleased', range: [], empty: NOTHING_USER_FACING },
    ])
  })

  it('gives a single tag the history up to it, and Unreleased the rest', () => {
    expect(planSections([{ name: 'v0.1.0', date: '2026-11-23' }])).toEqual([
      {
        name: 'Unreleased',
        heading: 'Unreleased',
        range: ['v0.1.0..HEAD'],
        empty: '_No user-facing changes since v0.1.0._',
      },
      {
        name: 'v0.1.0',
        heading: 'v0.1.0 — 2026-11-23',
        range: ['v0.1.0'],
        empty: NOTHING_USER_FACING,
      },
    ])
  })

  /**
   * The ranges have to chain: each one starts where the next older one ends.
   * A gap loses commits from every section, an overlap lists them twice, and
   * both look like a normal changelog.
   */
  it('chains the ranges newest first, in semver order whatever order git listed the tags', () => {
    const sections = planSections([
      { name: 'v0.10.0', date: '2026-03-01' },
      { name: 'v0.2.0', date: '2026-01-01' },
      { name: 'v0.10.0-rc.1', date: '2026-02-01' },
      { name: 'v0.9.0', date: '2026-01-15' },
    ])
    expect(sections.map((s) => [s.name, s.range])).toEqual([
      ['Unreleased', ['v0.10.0..HEAD']],
      ['v0.10.0', ['v0.10.0-rc.1..v0.10.0']],
      ['v0.10.0-rc.1', ['v0.9.0..v0.10.0-rc.1']],
      ['v0.9.0', ['v0.2.0..v0.9.0']],
      ['v0.2.0', ['v0.2.0']],
    ])
  })
})

describe('splice', () => {
  const doc = [
    '# Changelog',
    '',
    'Preamble.',
    '',
    '<!-- changelog:start -->',
    '',
    '<!-- changelog:end -->',
    '',
    'Footer.',
  ].join('\n')

  it('keeps the hand-written preamble and footer', () => {
    const out = splice(doc, '## Unreleased\n\n### Features\n\n- a thing\n')
    expect(out).toContain('Preamble.')
    expect(out).toContain('Footer.')
    expect(out).toContain('- a thing')
  })

  it('is idempotent', () => {
    const generated = '## Unreleased\n\n### Features\n\n- a thing\n'
    expect(splice(splice(doc, generated), generated)).toBe(splice(doc, generated))
  })

  it('refuses to guess when the markers are missing', () => {
    expect(() => splice('# Changelog\n', 'x')).toThrow(/markers/)
  })
})

/**
 * Against repositories built by real git, because the ranges and the tag dates
 * are git's to interpret: whether `v0.1.0..v0.2.0` excludes the commit `v0.1.0`
 * points at, and which date an annotated tag reports, are not things a fixture
 * string can be wrong about in the way git can.
 */
describe('against a real repository', { timeout: 30_000 }, () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  /** Commits and tags carry fixed dates, so the headings are the same on any machine. */
  function repository() {
    const dir = mkdtempSync(join(tmpdir(), 'sentra-changelog-'))
    dirs.push(dir)
    const run = (args: string[], date = '2026-01-01T12:00:00+00:00'): void => {
      execFileSync('git', args, {
        cwd: dir,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 't@example.com',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      })
    }
    run(['init', '--quiet', '--initial-branch=main'])

    let n = 0
    return {
      dir,
      commit(subject: string, date?: string): void {
        writeFileSync(join(dir, 'file.txt'), String(++n))
        run(['add', 'file.txt'])
        run(['commit', '--quiet', '-m', subject], date)
      },
      tag(name: string, { annotatedOn }: { annotatedOn?: string } = {}): void {
        run(
          annotatedOn === undefined ? ['tag', name] : ['tag', '-a', name, '-m', name],
          annotatedOn,
        )
      },
      run,
      changelog: (): string => renderSections(readSections(dir), dir),
    }
  }

  const bullets = (text: string): string[] =>
    text
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .sort()

  /** Byte for byte what the generator wrote before it read tags. */
  it('renders one Unreleased section over all history when there are no tags', () => {
    const repo = repository()
    repo.commit('feat(triage): first feature (#1)')
    repo.commit('chore: tidy up')
    repo.commit('fix(eval): first fix (#2)')

    expect(repo.changelog()).toBe(
      [
        '## Unreleased',
        '',
        '### Features',
        '',
        '- **triage:** first feature ([#1](https://github.com/AKogut/ai-flaky-test-triage/pull/1))',
        '',
        '### Fixes',
        '',
        '- **eval:** first fix ([#2](https://github.com/AKogut/ai-flaky-test-triage/pull/2))',
        '',
      ].join('\n'),
    )
  })

  /**
   * What the generator did before it read tags: the first regeneration after
   * the first tag kept only what came after it.
   */
  it('keeps every entry when the first tag arrives, and moves them under it', () => {
    const repo = repository()
    repo.commit('feat(triage): first feature (#1)')
    repo.commit('fix(eval): first fix (#2)')
    const before = repo.changelog()

    repo.tag('v0.1.0')
    const after = repo.changelog()

    expect(bullets(after)).toEqual(bullets(before))
    expect(after).toMatch(/^## Unreleased\n\n_No user-facing changes since v0.1.0\._\n\n## v0.1.0/)
  })

  /**
   * A section exists once its tag does, so the regenerated file is committed
   * after the tag — as `chore(release)`, like #122. If the empty Unreleased line
   * depended on that commit, `--check` would fail on the commit that had just
   * made it pass.
   */
  it('says the same about an empty Unreleased before and after the chore commit that records it', () => {
    const repo = repository()
    repo.commit('feat(triage): first feature (#1)')
    repo.tag('v0.1.0')
    const before = repo.changelog()

    repo.commit('chore(release): regenerate the changelog for v0.1.0')
    expect(repo.changelog()).toBe(before)
  })

  it('gives each of two tags its own range, newest first, and ignores a tag that is not a release', () => {
    vi.stubEnv('TZ', 'UTC')
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })

    const repo = repository()
    repo.commit('feat(triage): first feature (#1)')
    // Late evening in New York is already the next day in UTC. The heading
    // follows the commit's calendar, not the machine's.
    repo.commit('fix(eval): first fix (#2)', '2026-01-15T23:30:00-05:00')
    repo.tag('v0.1.0')
    repo.commit('feat(agents): between the tags (#3)')
    repo.tag('nightly')
    repo.commit('chore(deps): bump something (#4)')
    repo.commit('docs: after the nightly tag (#5)', '2026-02-20T10:00:00+00:00')
    // Annotated, and tagged on a later day than the commit: dated by the commit.
    repo.tag('v0.2.0', { annotatedOn: '2026-03-01T09:00:00+00:00' })
    repo.commit('feat(app): not released yet (#6)')

    const out = repo.changelog()
    const link = (pr: number): string =>
      `([#${String(pr)}](https://github.com/AKogut/ai-flaky-test-triage/pull/${String(pr)}))`

    expect(out).toBe(
      [
        '## Unreleased',
        '',
        '### Features',
        '',
        `- **app:** not released yet ${link(6)}`,
        '',
        '## v0.2.0 — 2026-02-20',
        '',
        '### Features',
        '',
        `- **agents:** between the tags ${link(3)}`,
        '',
        '### Documentation',
        '',
        `- after the nightly tag ${link(5)}`,
        '',
        '## v0.1.0 — 2026-01-15',
        '',
        '### Features',
        '',
        `- **triage:** first feature ${link(1)}`,
        '',
        '### Fixes',
        '',
        `- **eval:** first fix ${link(2)}`,
        '',
      ].join('\n'),
    )
    // Nothing lost and nothing listed twice: the same entries as one section over all history.
    expect(bullets(out)).toEqual(
      bullets(renderSections(readSections(repo.dir, { all: true }), repo.dir)),
    )
  })

  it('renders one release on its own, for release notes', () => {
    const repo = repository()
    repo.commit('feat(triage): first feature (#1)')
    repo.tag('v0.1.0')
    repo.commit('feat(agents): second feature (#2)')
    repo.tag('v0.2.0')

    const v010 = readSections(repo.dir).find((s) => s.name === 'v0.1.0')
    if (v010 === undefined) throw new Error('no v0.1.0 section')
    const out = renderSection(v010, repo.dir)
    expect(out).toMatch(/^## v0\.1\.0 — 2026-01-01\n/)
    expect(out).toContain('first feature')
    expect(out).not.toContain('second feature')
  })

  /** What `git describe` did before: a release tag on a branch this one never merged describes nothing here. */
  it('ignores a release tag that HEAD does not contain', () => {
    const repo = repository()
    repo.commit('feat(triage): first feature (#1)')
    repo.run(['checkout', '--quiet', '-b', 'elsewhere'])
    repo.commit('feat(agents): only on the other branch (#2)')
    repo.tag('v9.0.0')
    repo.run(['checkout', '--quiet', 'main'])

    expect(readSections(repo.dir).map((s) => s.name)).toEqual(['Unreleased'])
  })
})

/**
 * The generator writes into a tree `npm run format:check` reads.
 *
 * It did not always format its output, so `npm run changelog` — a documented
 * release step — produced a file Prettier would rewrite, and `--check` reported
 * a difference that was only a blank line. A release step that breaks the
 * formatting gate is a release step somebody skips.
 */
describe('the committed changelog', () => {
  // Prettier over the whole changelog: 1.2s on an ordinary run, 6.3s on a busy machine.
  it('is formatted the way Prettier formats it', { timeout: 30_000 }, async () => {
    const committed = readFileSync('CHANGELOG.md', 'utf8')
    expect(await format(committed, { parser: 'markdown' })).toBe(committed)
  })

  it('still carries the markers regeneration splices between', () => {
    const committed = readFileSync('CHANGELOG.md', 'utf8')
    expect(committed).toContain('<!-- changelog:start -->')
    expect(committed).toContain('<!-- changelog:end -->')
  })
})
