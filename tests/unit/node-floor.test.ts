import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The minimum Node version is stated in four places: `engines.node`, which is the
 * only one a package manager reads, and three prose copies a human reads first —
 * the README badge, CONTRIBUTING, and the wiki's requirements line.
 *
 * These drifted the moment ESLint 10 raised the real floor from 22 to 22.13. The
 * failure is quiet in the worst way: the docs keep promising a version that no
 * longer installs, and the person who believes them gets an ERESOLVE wall instead
 * of a sentence telling them to upgrade.
 *
 * `engines.node` is the source of truth here because it is the copy that has
 * consequences.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')

const packageJson = JSON.parse(read('package.json')) as { engines: { node: string } }

/** `">=22.13"` → `"22.13"`. The comparator is fixed; only the version travels. */
const declaredFloor = (): string => {
  const match = /^>=(\d+(?:\.\d+)*)$/.exec(packageJson.engines.node)
  if (match?.[1] === undefined) {
    throw new Error(
      `engines.node is "${packageJson.engines.node}", which this check cannot read. ` +
        'It expects a single ">=x.y" comparator — if the policy has genuinely changed ' +
        'to a range, update this test rather than deleting it.',
    )
  }
  return match[1]
}

describe('the documented Node floor', () => {
  const floor = declaredFloor()

  it.each([
    ['README.md', () => read('README.md')],
    ['CONTRIBUTING.md', () => read('CONTRIBUTING.md')],
    ['wiki/Getting-Started.md', () => read('wiki/Getting-Started.md')],
  ])('%s states the version from engines.node', (_file, load) => {
    expect(load()).toContain(floor)
  })

  it('no prose copy still claims the superseded bare major', () => {
    // `Node ≥ 22` reads as correct and is not — 22.0 through 22.12 fail to install.
    // Matching the major with nothing after it is what catches a half-done update.
    const stale = /Node\s*(?:≥|>=)\s*22(?!\.)/
    for (const file of ['README.md', 'CONTRIBUTING.md', 'wiki/Getting-Started.md']) {
      expect(read(file)).not.toMatch(stale)
    }
  })

  it('the badge encodes the same floor', () => {
    // The badge URL percent-encodes `>=`, so it is the one copy a plain text
    // search for the version string would pass without actually agreeing.
    expect(read('README.md')).toContain(`node-%3E%3D${floor}-`)
  })

  it('is at or above the floor ESLint requires', () => {
    // ESLint 10 accepts `^20.19.0 || ^22.13.0 || >=24`. The repository is on the
    // 22 line, so 22.13 is the binding constraint; dropping below it silently
    // breaks `npm run lint` for anyone who trusts engines.node.
    const [major = 0, minor = 0] = floor.split('.').map(Number)
    expect(major).toBeGreaterThanOrEqual(22)
    if (major === 22) expect(minor).toBeGreaterThanOrEqual(13)
  })
})
