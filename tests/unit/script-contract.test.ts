import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The CLI surface is documented in three places: the README table a reader
 * follows, package.json which actually runs things, and script-manifest.json
 * which drives `npm run help` and the placeholder messages.
 *
 * Three copies of one list is two too many to maintain by hand, and the failure
 * is silent — a README that promises `npm run eval` while package.json has no
 * such script looks fine until somebody types it. These tests make the drift
 * loud instead.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface ManifestEntry {
  name: string
  description: string
  milestone: string
  issue: number
  status: 'implemented' | 'pending'
}

const manifest = JSON.parse(
  readFileSync(join(root, 'scripts', 'script-manifest.json'), 'utf8'),
) as { scripts: ManifestEntry[] }

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

const readme = readFileSync(join(root, 'README.md'), 'utf8')

/**
 * Pull the script names out of the README's reference table. Rows look like
 * `| `npm run eval` | M2 | ... |`, so the anchor is a backticked `npm run x`
 * at the start of a table cell rather than a positional column index — the
 * table can gain columns without breaking this.
 */
function scriptNamesInReadmeTable(): string[] {
  const names: string[] = []
  for (const line of readme.split('\n')) {
    const match = /^\|\s*`npm (?:run )?([a-z0-9:-]+)`\s*\|/.exec(line)
    if (match?.[1] !== undefined) names.push(match[1])
  }
  return names
}

/**
 * The same rows, with their descriptions. The status column is skipped: it
 * carries a 🚧 that the manifest expresses as a `status` field instead.
 */
function descriptionsInReadmeTable(): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of readme.split('\n')) {
    const match = /^\|\s*`npm (?:run )?([a-z0-9:-]+)`\s*\|[^|]*\|\s*(.*?)\s*\|\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) rows.set(match[1], match[2])
  }
  return rows
}

describe('script contract', () => {
  const manifestNames = manifest.scripts.map((s) => s.name)

  it('documents at least the pipeline scripts', () => {
    expect(manifestNames.length).toBeGreaterThanOrEqual(10)
  })

  it('has no duplicate entries', () => {
    expect(new Set(manifestNames).size).toBe(manifestNames.length)
  })

  it.each(manifestNames)('package.json defines "%s"', (name) => {
    expect(packageJson.scripts).toHaveProperty(name)
  })

  it('README table and manifest list the same scripts', () => {
    expect([...scriptNamesInReadmeTable()].sort()).toEqual([...manifestNames].sort())
  })

  /**
   * And describe them the same way. The names were already compared; the
   * descriptions were not, and three of them had drifted — the README and
   * `npm run help` were telling a reader two different things about the same
   * command, which is the sort of difference nobody notices because neither
   * source looks wrong on its own.
   */
  it('README table and manifest describe them the same way', () => {
    for (const entry of manifest.scripts) {
      expect(descriptionsInReadmeTable().get(entry.name), entry.name).toBe(entry.description)
    }
  })

  it('every pending script routes through the placeholder', () => {
    for (const entry of manifest.scripts.filter((s) => s.status === 'pending')) {
      expect(packageJson.scripts[entry.name]).toBe(`node scripts/pending.mjs ${entry.name}`)
    }
  })

  it('no implemented script still routes through the placeholder', () => {
    for (const entry of manifest.scripts.filter((s) => s.status === 'implemented')) {
      expect(packageJson.scripts[entry.name]).not.toContain('scripts/pending.mjs')
    }
  })

  it('every entry names a milestone and a tracking issue', () => {
    for (const entry of manifest.scripts) {
      expect(entry.milestone).toMatch(/^M(10|[0-9])$/)
      expect(entry.issue).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(10)
    }
  })
})
