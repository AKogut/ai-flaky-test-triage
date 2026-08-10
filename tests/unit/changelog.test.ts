import { describe, expect, it } from 'vitest'
import {
  FIELD_SEP,
  parseCommits,
  RECORD_SEP,
  renderChangelog,
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
