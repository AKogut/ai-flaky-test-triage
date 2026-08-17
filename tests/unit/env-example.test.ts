import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `.env.example` is documentation that goes stale silently.
 *
 * It has drifted twice. Once it advertised `SENTRA_MODEL`, a variable nothing
 * read, naming a different model from the one the code pinned. Then it gained
 * two entries nothing read and lost two the code did read, and neither was
 * visible until somebody went looking.
 *
 * The rule enforced here is not "every variable must be read" — some are for
 * components that land in later milestones, and deleting them would remove the
 * only place their existence is written down. It is that **every variable is
 * either read by the code or says which issue will read it.** Both states are
 * honest; the silent third state is not.
 */

const example = readFileSync('.env.example', 'utf8')

/** Name, plus the comment block immediately above it. */
interface Entry {
  name: string
  comment: string
}

function entries(): Entry[] {
  const found: Entry[] = []
  let comment: string[] = []

  for (const line of example.split('\n')) {
    if (line.startsWith('#')) {
      comment.push(line)
      continue
    }
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line)
    if (match?.[1] !== undefined) found.push({ name: match[1], comment: comment.join('\n') })
    if (line.trim() === '') comment = []
  }
  return found
}

/**
 * Every TypeScript source, once.
 *
 * `git ls-files` rather than a directory walk: the build output and the bundle
 * contain the variable names too, and matching against those would let a
 * deleted reader keep the check green.
 */
const sources = execSync('git ls-files "*.ts" "*.tsx"', { encoding: 'utf8' })
  .split('\n')
  .filter((path) => path !== '' && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')

describe('.env.example', () => {
  const all = entries()

  it('lists some variables at all', () => {
    expect(all.length).toBeGreaterThan(5)
  })

  it.each(all.map((entry) => [entry.name, entry] as const))(
    '%s is either read today or says which issue will read it',
    (name, entry) => {
      const isRead = sources.includes(name)
      const isPlanned = /#\d+/.test(entry.comment)
      expect(
        isRead || isPlanned,
        `${name} is in .env.example, nothing reads it, and its comment names no issue`,
      ).toBe(true)
    },
  )

  /**
   * The other direction, and the one that bit hardest: a variable the code reads
   * and the example never mentions is a setting nobody knows exists.
   */
  it.each(['SENTRA_DB', 'VITE_PORT', 'PORT', 'ANTHROPIC_API_KEY', 'SENTRA_TOKEN_BUDGET'])(
    '%s is documented, because the code reads it',
    (name) => {
      expect(all.map((entry) => entry.name)).toContain(name)
    },
  )

  /**
   * The model is pinned in `agents/model-client.ts` so that "which model produced
   * this number" has one answer per commit. An environment variable for it would
   * let two people publish figures from two different models and neither would
   * know — which is why one was removed, and why this asserts it stays removed.
   */
  it('offers no way to change the model from the environment', () => {
    expect(example).not.toContain('SENTRA_MODEL')
  })
})
