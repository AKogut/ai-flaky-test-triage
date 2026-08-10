/**
 * Changelog generation from Conventional Commits.
 *
 * `conventional-changelog-cli@5` was tried first and did not apply preset section
 * grouping — every commit came out in one flat list regardless of type. Rather
 * than pin around the bug, this reads `git log` directly. It is about eighty
 * lines, it removes a dependency, and it does exactly what
 * docs/branching-strategy.md specifies: grouped by type, then by scope, with
 * breaking changes in their own section.
 *
 * Output is spliced between markers in CHANGELOG.md so the hand-written preamble
 * survives regeneration. Prepending — what the CLI does — would push it below the
 * generated content on every run.
 *
 * Usage: tsx scripts/changelog.ts [--all] [--check]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const REPO = 'https://github.com/AKogut/ai-flaky-test-triage'
const START = '<!-- changelog:start -->'
const END = '<!-- changelog:end -->'

/** Types absent from this list are omitted. Tooling churn is not release notes. */
const SECTIONS: readonly { type: string; title: string }[] = [
  { type: 'feat', title: 'Features' },
  { type: 'fix', title: 'Fixes' },
  { type: 'perf', title: 'Performance' },
  { type: 'refactor', title: 'Refactoring' },
  { type: 'docs', title: 'Documentation' },
  { type: 'test', title: 'Tests' },
  { type: 'revert', title: 'Reverts' },
]

export interface ParsedCommit {
  hash: string
  type: string
  scope: string | null
  subject: string
  breaking: boolean
  breakingNote: string | null
  pr: number | null
}

/**
 * ASCII record and unit separators. Exported so tests build fixtures with the same
 * delimiters the parser splits on rather than duplicating the literals — a mismatch
 * there would make the tests pass against a parser that cannot read real `git log`
 * output. Control characters cannot occur in a commit subject or body, and unlike
 * NUL they are legal in an `execFile` argument.
 */
export const RECORD_SEP = '\u001e'
export const FIELD_SEP = '\u001f'

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9-]+)\))?(?<bang>!)?: (?<subject>.+)$/

/**
 * Parse `git log` output. Exported so the grouping and edge cases are testable
 * without a repository — the interesting failures here are silent ones, like a
 * breaking change that never reaches its section.
 */
export function parseCommits(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = []

  for (const record of raw.split(RECORD_SEP)) {
    if (record.trim() === '') continue
    const [hash = '', subject = '', body = ''] = record.split(FIELD_SEP)

    const match = HEADER.exec(subject.trim())
    if (!match?.groups) continue

    const { type = '', scope, bang, subject: text = '' } = match.groups

    const breakingFooter = /^BREAKING[ -]CHANGE:\s*(.+)$/m.exec(body)
    const prMatch = /\(#(\d+)\)\s*$/.exec(text)

    commits.push({
      hash: hash.trim(),
      type,
      scope: scope ?? null,
      subject: text.replace(/\s*\(#\d+\)\s*$/, '').trim(),
      breaking: bang === '!' || breakingFooter !== null,
      breakingNote: breakingFooter?.[1]?.trim() ?? null,
      pr: prMatch?.[1] !== undefined ? Number(prMatch[1]) : null,
    })
  }

  return commits
}

function bullet(c: ParsedCommit): string {
  const scope = c.scope === null ? '' : `**${c.scope}:** `
  const link =
    c.pr === null
      ? `([${c.hash.slice(0, 7)}](${REPO}/commit/${c.hash}))`
      : `([#${String(c.pr)}](${REPO}/pull/${String(c.pr)}))`
  return `- ${scope}${c.subject} ${link}`
}

/** Scope first, then subject — a stable order, so regeneration produces no diff noise. */
const byScopeThenSubject = (a: ParsedCommit, b: ParsedCommit): number =>
  (a.scope ?? '').localeCompare(b.scope ?? '') || a.subject.localeCompare(b.subject)

export function renderChangelog(commits: ParsedCommit[], heading: string): string {
  const lines: string[] = [`## ${heading}`, '']

  const breaking = commits.filter((c) => c.breaking)
  if (breaking.length > 0) {
    lines.push('### ⚠ Breaking changes', '')
    for (const c of [...breaking].sort(byScopeThenSubject)) {
      lines.push(bullet(c))
      if (c.breakingNote !== null) lines.push(`  ${c.breakingNote}`)
    }
    lines.push('')
  }

  for (const section of SECTIONS) {
    const inSection = commits.filter((c) => c.type === section.type)
    if (inSection.length === 0) continue
    lines.push(`### ${section.title}`, '')
    for (const c of [...inSection].sort(byScopeThenSubject)) lines.push(bullet(c))
    lines.push('')
  }

  if (lines.length === 2) lines.push('_No user-facing changes._', '')

  return lines.join('\n')
}

export function splice(existing: string, generated: string): string {
  const start = existing.indexOf(START)
  const end = existing.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`CHANGELOG.md is missing the ${START} / ${END} markers`)
  }
  return `${existing.slice(0, start + START.length)}\n\n${generated}${existing.slice(end)}`
}

function git(args: string[], { quiet = false }: { quiet?: boolean } = {}): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
  })
}

function main(): void {
  const all = process.argv.includes('--all')
  const check = process.argv.includes('--check')

  let range: string[] = []
  const heading = 'Unreleased'
  if (!all) {
    try {
      // No tags yet is the normal state before v1.0.0, so its stderr is noise.
      const tag = git(['describe', '--tags', '--abbrev=0'], { quiet: true }).trim()
      range = [`${tag}..HEAD`]
    } catch {
      // No tags yet. Everything is unreleased, which is the correct heading.
    }
  }

  const raw = git([
    'log',
    ...range,
    '--no-merges',
    `--format=${RECORD_SEP}%H${FIELD_SEP}%s${FIELD_SEP}%b`,
    '--reverse',
  ])

  const generated = renderChangelog(parseCommits(raw), heading)
  const existing = readFileSync('CHANGELOG.md', 'utf8')
  const next = splice(existing, generated)

  if (check) {
    if (next !== existing) {
      console.error('CHANGELOG.md is out of date. Run: npm run changelog')
      process.exit(1)
    }
    console.log('CHANGELOG.md is up to date')
    return
  }

  writeFileSync('CHANGELOG.md', next)
  console.log(`CHANGELOG.md regenerated (${heading})`)
}

if (process.argv[1]?.endsWith('changelog.ts') === true) main()
