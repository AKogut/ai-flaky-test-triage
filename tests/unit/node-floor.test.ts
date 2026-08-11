import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The minimum Node version is stated in five places: `engines.node`, which is the
 * only one a package manager reads, and four prose copies a human reads first —
 * the README badge, CONTRIBUTING, and two wiki pages.
 *
 * These drifted the moment ESLint 10 raised the real floor from 22 to 22.13. The
 * failure is quiet in the worst way: the docs keep promising a version that no
 * longer installs, and the person who believes them gets an ERESOLVE wall instead
 * of a sentence telling them to upgrade.
 *
 * `engines.node` is the source of truth here because it is the copy that has
 * consequences.
 *
 * The list below started with three files and missed `wiki/Contributing.md`,
 * which then sat on the stale number while the check reported green. A guard
 * that enumerates its targets by hand is only as good as the enumeration, so
 * anything new that states a Node version belongs in `PROSE_COPIES`.
 */
const PROSE_COPIES = [
  'README.md',
  'CONTRIBUTING.md',
  'wiki/Getting-Started.md',
  'wiki/Contributing.md',
] as const

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')

const packageJson = JSON.parse(read('package.json')) as {
  engines: { node: string }
  devDependencies: Record<string, string>
}

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

  it.each(PROSE_COPIES)('%s states the version from engines.node', (file) => {
    expect(read(file)).toContain(floor)
  })

  it.each(PROSE_COPIES)('%s does not still claim the superseded bare major', (file) => {
    // `Node ≥ 22` reads as correct and is not — 22.0 through 22.12 fail to install.
    // Matching the major with nothing after it is what catches a half-done update.
    expect(read(file)).not.toMatch(/Node\s*(?:≥|>=)\s*22(?!\.)/)
  })

  it('checks every copy that exists, not a subset someone remembered', () => {
    // The original list missed one wiki page, which then held the stale number
    // while this suite reported green. Anything stating a Node version has to be
    // in PROSE_COPIES, so the search runs over the tracked files rather than
    // trusting the list to be complete.
    //
    // Both spellings count. README states the floor only inside a shields.io URL,
    // where `>=` is percent-encoded — searching for prose alone would miss the
    // one copy most readers see first.
    const statesAVersion = /Node\s*(?:≥|>=)\s*\d|node-%3E%3D\d/
    const stated = execSync('git ls-files "*.md"', { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file !== '' && statesAVersion.test(read(file)))
    expect(stated.sort()).toEqual([...PROSE_COPIES].sort())
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

describe('@types/node tracks the runtime, not the newest release', () => {
  /**
   * DefinitelyTyped versions `@types/node` by Node major, so the types describe
   * one specific runtime's API surface. Taking a newer major than the project
   * runs is not a harmless upgrade — it is the compiler agreeing to calls that
   * do not exist.
   *
   * Concretely: `@types/node@26` declares `node:ffi` and `node:quic`, neither of
   * which Node 22 has. Under those types an import from `node:quic` type-checks
   * cleanly and throws `ERR_UNKNOWN_BUILTIN_MODULE` at runtime — the compiler
   * turned from a check into a rubber stamp, silently.
   */
  const range = packageJson.devDependencies['@types/node']

  it('is declared at all', () => {
    expect(range).toBeDefined()
  })

  it('has the same major as engines.node', () => {
    const typesMajor = /(\d+)/.exec(range ?? '')?.[1]
    const runtimeMajor = declaredFloor().split('.')[0]
    expect(typesMajor).toBe(runtimeMajor)
  })
})
