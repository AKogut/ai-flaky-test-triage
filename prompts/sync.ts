import { readFileSync, writeFileSync } from 'node:fs'
import { PROMPT_DIR, loadRubric } from './registry.js'

/**
 * Copying the rubric into the documentation, mechanically.
 *
 * Markdown has no include directive, so "one rubric, two readers" has to be
 * either a generated block or a convention. A convention loses: the two copies
 * agree on the day they are written and diverge on the first edit that only
 * touches one of them, and nothing about the repository looks different
 * afterwards. The evaluation keeps reporting agreement with a rubric the
 * labeller is no longer applying.
 *
 * So `docs/taxonomy.md` carries a generated block, `npm run prompts:sync` writes
 * it, `--check` fails when it is stale, and a unit test asserts the same thing so
 * the invariant does not depend on the CI job being wired up.
 *
 * The generation direction is deliberate. The rubric file is the source because
 * it is what the model is actually sent; the documentation is the copy, because
 * a doc that disagrees with the prompt is a doc that is wrong.
 */

export const TAXONOMY_DOC = 'docs/taxonomy.md'

export const BEGIN_MARKER = '<!-- rubric:begin -->'
export const END_MARKER = '<!-- rubric:end -->'

const NOTICE = `<!-- Generated from ${PROMPT_DIR}/rubric.md by \`npm run prompts:sync\`. Edit that file, not this block. -->`

export class SyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncError'
  }
}

/** The document with its rubric block replaced. Idempotent, so `--check` can compare. */
export function syncedDoc(doc: string, rubric: string): string {
  const start = doc.indexOf(BEGIN_MARKER)
  const end = doc.indexOf(END_MARKER)

  if (start === -1 || end === -1 || end < start) {
    throw new SyncError(
      `${TAXONOMY_DOC} has no rubric block. It must contain ${BEGIN_MARKER} followed by ${END_MARKER}; ` +
        'without them there is nowhere to put the rubric and the two copies would drift apart unnoticed.',
    )
  }

  const block = [BEGIN_MARKER, '', NOTICE, '', rubric, '', END_MARKER].join('\n')
  return doc.slice(0, start) + block + doc.slice(end + END_MARKER.length)
}

export interface SyncDeps {
  readDoc?: (path: string) => string
  writeDoc?: (path: string, contents: string) => void
  rubric?: () => string
  log?: (message: string) => void
}

/** The real ones, named so a test can exercise them without going through `main`. */
export const fileDeps = {
  readDoc: (path: string): string => readFileSync(path, 'utf8'),
  writeDoc: (path: string, contents: string): void => writeFileSync(path, contents),
  rubric: (): string => loadRubric(),
}

/** Exit code, not `process.exit`, so a test can run the whole thing. */
export function main(argv: readonly string[], deps: SyncDeps = {}): number {
  const readDoc = deps.readDoc ?? fileDeps.readDoc
  const writeDoc = deps.writeDoc ?? fileDeps.writeDoc
  const rubric = deps.rubric ?? fileDeps.rubric
  const log = deps.log ?? console.log

  const check = argv.includes('--check')
  const current = readDoc(TAXONOMY_DOC)
  const next = syncedDoc(current, rubric())

  if (current === next) {
    log(`${TAXONOMY_DOC} is in sync with ${PROMPT_DIR}/rubric.md.`)
    return 0
  }

  if (check) {
    log(
      `${TAXONOMY_DOC} does not match ${PROMPT_DIR}/rubric.md.\n\n` +
        '  The rubric the model is sent and the rubric the dataset was labelled by have drifted.\n' +
        '  Every accuracy figure measured across that gap is agreement with a rule nobody applied.\n\n' +
        '  Fix with: npm run prompts:sync',
    )
    return 1
  }

  writeDoc(TAXONOMY_DOC, next)
  log(`Wrote the rubric into ${TAXONOMY_DOC}.`)
  return 0
}

if (process.argv[1]?.endsWith('sync.ts') === true) {
  process.exitCode = main(process.argv.slice(2))
}
