import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROMPT_DIR, RUBRIC_FILE } from './registry.js'

/**
 * A published prompt version is immutable.
 *
 * `eval/report.md` says which prompt version produced which numbers. That is the
 * whole mechanism by which a regression is attributable: two reports, two
 * versions, and the diff between them explains the move. Editing a version in
 * place keeps the record and destroys the link — the report still names
 * `triage.v1`, and `triage.v1` is now different text. Nothing looks broken.
 * Every past number silently becomes a claim about a prompt that no longer
 * exists.
 *
 * The check compares the working tree against the reference ref for every
 * version the committed metrics on that ref actually name. Nothing to maintain
 * by hand, and it stays quiet until numbers exist to protect.
 *
 * The rubric is frozen alongside them, and that is the part worth stating: it is
 * not a document *about* the prompt, it is a section *of* it, substituted in at
 * load time. An edit there rewrites every published prompt at once while leaving
 * every prompt file untouched — the exact shape of change this check exists to
 * catch, and the one it would miss if the frozen set were the prompt files only.
 */

export const METRICS_FILES = [
  'eval/metrics.json',
  'eval/holdout-metrics.json',
  'eval/metrics-all.json',
] as const

export interface FreezeDeps {
  /** File contents at a git ref, or null when the ref does not have that path. */
  showAtRef: (ref: string, path: string) => string | null
  /** Working-tree contents, or null when the file is gone. */
  readLocal: (path: string) => string | null
  metricsFiles?: readonly string[]
}

/**
 * A path every ref of this repository has.
 *
 * Without it the check fails open in the one environment it matters in. A
 * shallow CI checkout that never fetched the reference makes every `git show`
 * return nothing, `publishedVersions` comes back empty, and the check reports
 * "nothing to freeze" — passing, green, and blind. Probing a path that must
 * exist turns an unreadable ref into an error instead of an all-clear.
 */
export const REF_SENTINEL = 'package.json'

export class UnreadableRefError extends Error {
  constructor(readonly ref: string) {
    super(
      `cannot read ${ref} (${REF_SENTINEL} is not there). Fetch it first — ` +
        'on a shallow checkout every lookup returns nothing and this check would pass without looking at anything.',
    )
    this.name = 'UnreadableRefError'
  }
}

export interface Violation {
  path: string
  reason: 'edited' | 'deleted' | 'missing-at-ref'
  promptVersion: string
}

/**
 * Prompt versions named by the metrics committed on `ref`.
 *
 * A metrics file that does not parse is skipped rather than thrown on. This
 * check protects published numbers; it is not the validator for the metrics
 * format, and failing here on a malformed file would report the wrong problem
 * loudly enough to hide the right one.
 */
export function publishedVersions(ref: string, deps: FreezeDeps): string[] {
  if (deps.showAtRef(ref, REF_SENTINEL) === null) throw new UnreadableRefError(ref)

  const versions = new Set<string>()

  for (const path of deps.metricsFiles ?? METRICS_FILES) {
    const raw = deps.showAtRef(ref, path)
    if (raw === null) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }

    const version = (parsed as { promptVersion?: unknown }).promptVersion
    if (typeof version === 'string' && version !== '') versions.add(version)
  }

  return [...versions].sort()
}

export function frozenViolations(ref: string, deps: FreezeDeps): Violation[] {
  const versions = publishedVersions(ref, deps)
  if (versions.length === 0) return []

  const files = [
    ...versions.map((version) => [join(PROMPT_DIR, `${version}.md`), version] as const),
    // Substituted into every prompt at load time, so an edit here changes all of
    // them without touching one of their files.
    [join(PROMPT_DIR, RUBRIC_FILE), versions.join(', ')] as const,
  ]

  const violations: Violation[] = []
  for (const [path, promptVersion] of files) {
    const published = deps.showAtRef(ref, path)
    if (published === null) {
      violations.push({ path, reason: 'missing-at-ref', promptVersion })
      continue
    }

    const local = deps.readLocal(path)
    if (local === null) {
      violations.push({ path, reason: 'deleted', promptVersion })
    } else if (local !== published) {
      violations.push({ path, reason: 'edited', promptVersion })
    }
  }
  return violations
}

const EXPLANATION: Record<Violation['reason'], string> = {
  edited: 'was edited in place after its numbers were published',
  deleted: 'was deleted after its numbers were published',
  'missing-at-ref': 'is named by published metrics but does not exist at the reference ref',
}

export function renderViolations(ref: string, violations: readonly Violation[]): string {
  return [
    `${String(violations.length)} published prompt file(s) changed against ${ref}:`,
    '',
    ...violations.map(
      ({ path, reason, promptVersion }) => `  ${path} ${EXPLANATION[reason]} (${promptVersion})`,
    ),
    '',
    '  eval/report.md attributes its numbers to a prompt version. Changing that version in place',
    '  leaves every published figure describing text that no longer exists, and nothing about the',
    '  repository looks wrong afterwards.',
    '',
    '  Add the next version instead — copy the file to <agent>.v<n+1>.md, edit that, and point',
    '  CURRENT_PROMPT at it. The old numbers keep meaning what they said.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const gitDeps: FreezeDeps = {
  showAtRef: (ref, path) => {
    try {
      return execFileSync('git', ['show', `${ref}:${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return null
    }
  },
  readLocal: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
}

export function main(
  argv: readonly string[],
  deps: FreezeDeps = gitDeps,
  log: (message: string) => void = console.log,
): number {
  const ref = argv.find((arg) => arg.startsWith('--ref='))?.slice('--ref='.length) ?? 'origin/main'
  const violations = frozenViolations(ref, deps)

  if (violations.length === 0) {
    const published = publishedVersions(ref, deps)
    log(
      published.length === 0
        ? `No prompt version is referenced by metrics on ${ref} yet; nothing to freeze.`
        : `Published prompt versions are unchanged against ${ref}: ${published.join(', ')}.`,
    )
    return 0
  }

  log(renderViolations(ref, violations))
  return 1
}

if (process.argv[1]?.endsWith('freeze.ts') === true) {
  process.exitCode = main(process.argv.slice(2))
}
