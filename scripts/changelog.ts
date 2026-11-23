/**
 * Changelog generation from Conventional Commits.
 *
 * `conventional-changelog-cli@5` was tried first and did not apply preset section
 * grouping — every commit came out in one flat list regardless of type. Rather
 * than pin around the bug, this reads `git log` directly. It removes a
 * dependency, and it does exactly what docs/branching-strategy.md specifies:
 * grouped by type, then by scope, with breaking changes in their own section.
 *
 * One section per release tag, newest first, below an `Unreleased` section for
 * what has landed since the newest, all rebuilt on every run. It once rendered
 * `Unreleased` alone, from the newest tag to HEAD: harmless with no tags, and on
 * the first run after `v0.1.0` it would have replaced every entry that shipped
 * in `v0.1.0` with the commits since.
 *
 * Output is spliced between markers in CHANGELOG.md so the hand-written preamble
 * survives regeneration. Prepending — what the CLI does — would push it below the
 * generated content on every run.
 *
 * Usage: tsx scripts/changelog.ts [--check] [--all] [--section <name>]
 *
 *   --check           exit 1 if CHANGELOG.md is not what regeneration would write
 *   --all             ignore release tags: all history as one Unreleased section,
 *                     which is what this script wrote before it read tags
 *   --section <name>  print one section — a tag such as v0.1.0, or Unreleased —
 *                     to stdout for release notes. CHANGELOG.md is not touched.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { format } from 'prettier'

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

/** What a section with nothing user-facing in it says instead of a list. */
export const NOTHING_USER_FACING = '_No user-facing changes._'

export function renderChangelog(
  commits: ParsedCommit[],
  heading: string,
  empty = NOTHING_USER_FACING,
): string {
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

  if (lines.length === 2) lines.push(empty, '')

  return lines.join('\n')
}

/**
 * A release tag: `v`, then a semver version with an optional pre-release suffix.
 *
 * Build metadata (`+build.5`) is left out on purpose. Semver gives it no
 * precedence, so two tags that differ only there could not be put in order, and
 * a changelog whose section order depends on which one git listed first is one
 * whose `--check` disagrees with itself between machines.
 */
const RELEASE_TAG =
  /^v(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<pre>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

interface Version {
  core: readonly [number, number, number]
  pre: readonly string[]
}

function parseVersion(tag: string): Version | null {
  const groups = RELEASE_TAG.exec(tag)?.groups
  if (groups === undefined) return null
  return {
    core: [Number(groups.major), Number(groups.minor), Number(groups.patch)],
    pre: groups.pre === undefined ? [] : groups.pre.split('.'),
  }
}

export function isReleaseTag(tag: string): boolean {
  return RELEASE_TAG.test(tag)
}

const NUMERIC = /^\d+$/

/** Semver §11: numeric identifiers by value and below alphanumeric ones, which compare in ASCII order. */
function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a)
  const bNumeric = NUMERIC.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
  // Not localeCompare: semver specifies ASCII order, and a locale is a property of the machine.
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Semver precedence, so `v0.10.0` follows `v0.9.0` and `v1.0.0-rc.1` precedes
 * `v1.0.0`. Sorting the names as strings gets both of those wrong, and wrong
 * order here means wrong ranges: every commit between the two tags is filed
 * under the wrong release.
 *
 * Throws on a name that is not a release tag rather than inventing an order for it.
 */
export function compareReleases(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x === null || y === null) throw new Error(`Not a release tag: ${x === null ? a : b}`)

  for (const i of [0, 1, 2] as const) {
    if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  }

  // A version without a pre-release ranks above the same version with one.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length

  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = compareIdentifiers(x.pre[i] ?? '', y.pre[i] ?? '')
    if (order !== 0) return order
  }
  return x.pre.length - y.pre.length
}

export interface ReleaseTag {
  name: string
  /** YYYY-MM-DD: the tagged commit's committer date, on the committer's own calendar. */
  date: string
}

/**
 * The `for-each-ref` format `parseTags` reads: name, then the committer date of
 * the commit an annotated tag points at, then the committer date of the ref
 * itself. Exactly one of the two dates is set — the first for an annotated tag,
 * the second for a lightweight one — so both kinds are dated by their commit.
 */
const TAG_FORMAT = `%(refname:lstrip=2)${FIELD_SEP}%(*committerdate:short)${FIELD_SEP}%(committerdate:short)`

/**
 * Release tags from `git for-each-ref --format=TAG_FORMAT`, in the order git
 * listed them. `planSections` puts them in release order.
 *
 * Anything that is not a release tag is dropped here, before it can become a
 * range boundary: a `nightly` or `demo-recording` tag between two releases would
 * otherwise split one release's commits across two sections, one of them not a
 * release at all.
 */
export function parseTags(raw: string): ReleaseTag[] {
  const tags: ReleaseTag[] = []

  for (const line of raw.split('\n')) {
    const [name = '', peeled = '', direct = ''] = line.split(FIELD_SEP).map((field) => field.trim())
    const date = peeled !== '' ? peeled : direct
    // No date means the tag does not point at a commit, and there is no range to read.
    if (!isReleaseTag(name) || date === '') continue
    tags.push({ name, date })
  }

  return tags
}

export interface Section {
  /** `Unreleased`, or the tag. What `--section` matches. */
  name: string
  /** Everything after `## `. */
  heading: string
  /** Revisions for `git log`. Empty means all history up to HEAD. */
  range: string[]
  /** What the section says when nothing in its range is user-facing. */
  empty: string
}

/**
 * Which commits each section reads, newest first.
 *
 * A release's range is the previous release tag to its own, and the oldest
 * release reaches back to the root commit, so every commit lands in exactly one
 * section and none falls between two. With no tags this is a single
 * `Unreleased` over all history — the same output the generator produced before
 * it read tags.
 *
 * `Unreleased` is always the first heading, empty or not. When it is empty its
 * line names the tag and does not count commits: the `chore(release)` commit
 * that records a regenerated changelog lands after the tag, and a line that
 * counted it would change with it — `--check` would fail on the commit that had
 * just made it pass.
 */
export function planSections(tags: readonly ReleaseTag[]): Section[] {
  const ordered = [...tags].sort((a, b) => compareReleases(a.name, b.name))
  const newest = ordered.at(-1)

  const unreleased: Section =
    newest === undefined
      ? { name: 'Unreleased', heading: 'Unreleased', range: [], empty: NOTHING_USER_FACING }
      : {
          name: 'Unreleased',
          heading: 'Unreleased',
          range: [`${newest.name}..HEAD`],
          empty: `_No user-facing changes since ${newest.name}._`,
        }

  const releases = ordered.map((tag, i): Section => {
    const previous = ordered[i - 1]
    return {
      name: tag.name,
      heading: `${tag.name} — ${tag.date}`,
      range: [previous === undefined ? tag.name : `${previous.name}..${tag.name}`],
      empty: NOTHING_USER_FACING,
    }
  })

  return [unreleased, ...releases.reverse()]
}

export function splice(existing: string, generated: string): string {
  const start = existing.indexOf(START)
  const end = existing.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`CHANGELOG.md is missing the ${START} / ${END} markers`)
  }
  return `${existing.slice(0, start + START.length)}\n\n${generated}${existing.slice(end)}`
}

function git(args: string[], { cwd }: { cwd: string }): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

/**
 * The sections the repository at `cwd` has, newest first.
 *
 * Only tags reachable from HEAD count, which is the set `git describe` chose
 * from before this read tags. A release tag on a branch that never merged does
 * not describe anything on this one.
 */
export function readSections(cwd: string, { all = false }: { all?: boolean } = {}): Section[] {
  if (all) return planSections([])
  return planSections(
    parseTags(
      git(['for-each-ref', '--merged=HEAD', `--format=${TAG_FORMAT}`, 'refs/tags'], { cwd }),
    ),
  )
}

/** One section, rendered from the commits in its range. */
export function renderSection(section: Section, cwd: string): string {
  const raw = git(
    [
      'log',
      ...section.range,
      '--no-merges',
      `--format=${RECORD_SEP}%H${FIELD_SEP}%s${FIELD_SEP}%b`,
      '--reverse',
      // Ends the revisions, so a tag can never be read as a path.
      '--',
    ],
    { cwd },
  )
  return renderChangelog(parseCommits(raw), section.heading, section.empty)
}

/** Everything between the markers, before Prettier. */
export function renderSections(sections: readonly Section[], cwd: string): string {
  return sections.map((section) => renderSection(section, cwd)).join('\n')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      all: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      section: { type: 'string' },
    },
  })

  const cwd = process.cwd()
  const sections = readSections(cwd, { all: values.all })

  if (values.section !== undefined) {
    const wanted = sections.find((s) => s.name === values.section)
    if (wanted === undefined) {
      console.error(
        `No section named ${values.section}. There is: ${sections.map((s) => s.name).join(', ')}`,
      )
      process.exit(1)
    }
    process.stdout.write(await format(renderSection(wanted, cwd), { parser: 'markdown' }))
    return
  }

  const generated = renderSections(sections, cwd)
  const existing = readFileSync('CHANGELOG.md', 'utf8')

  // Formatted before it is compared or written, for the same reason
  // eval/report.md is: this file sits in a tree `npm run format:check` reads, so
  // output Prettier would rewrite breaks CI on the commit that regenerates it —
  // and `--check` would report a diff that is only whitespace.
  const next = await format(splice(existing, generated), { parser: 'markdown' })

  if (values.check) {
    if (next !== existing) {
      console.error('CHANGELOG.md is out of date. Run: npm run changelog')
      process.exit(1)
    }
    console.log('CHANGELOG.md is up to date')
    return
  }

  writeFileSync('CHANGELOG.md', next)
  console.log(`CHANGELOG.md regenerated (${sections.map((s) => s.name).join(', ')})`)
}

if (process.argv[1]?.endsWith('changelog.ts') === true) await main()
