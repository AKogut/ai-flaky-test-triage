import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  METRICS_FILES,
  frozenViolations,
  gitDeps,
  main,
  publishedVersions,
  renderViolations,
  REF_SENTINEL,
  UnreadableRefError,
  type FreezeDeps,
} from './freeze.js'

const REF = 'origin/main'

/** A repository state: what each path holds at the ref, and what it holds locally. */
const world = (atRef: Record<string, string>, local: Record<string, string>): FreezeDeps => ({
  // The sentinel is present in every world except the one that tests its absence.
  showAtRef: (_ref, path) => ({ [REF_SENTINEL]: 'sentinel', ...atRef })[path] ?? null,
  readLocal: (path) => local[path] ?? null,
})

const metrics = (promptVersion: string | null): string =>
  JSON.stringify({ version: 1, classifier: 'agent', promptVersion })

const PUBLISHED = {
  'eval/metrics.json': metrics('triage.v1'),
  'prompts/triage.v1.md': 'the prompt\n',
  'prompts/rubric.md': 'the rubric\n',
}

describe('what counts as published', () => {
  it('is whatever the committed metrics name', () => {
    const deps = world(
      {
        'eval/metrics.json': metrics('triage.v1'),
        'eval/holdout-metrics.json': metrics('triage.v2'),
      },
      {},
    )
    expect(publishedVersions(REF, deps)).toEqual(['triage.v1', 'triage.v2'])
  })

  it('is empty for the baseline, which has no prompt to protect', () => {
    expect(publishedVersions(REF, world({ 'eval/metrics.json': metrics(null) }, {}))).toEqual([])
  })

  it('is empty when the ref has no metrics at all', () => {
    expect(publishedVersions(REF, world({}, {}))).toEqual([])
  })

  /**
   * This check protects published numbers; it is not the validator for the
   * metrics format. Throwing here would report the wrong problem loudly enough
   * to hide the right one.
   */
  it('skips a metrics file it cannot parse rather than failing on it', () => {
    const deps = world(
      { 'eval/metrics.json': '{ not json', 'eval/holdout-metrics.json': metrics('triage.v1') },
      {},
    )
    expect(publishedVersions(REF, deps)).toEqual(['triage.v1'])
  })

  it('ignores a version field that is not a version', () => {
    const deps = world({ 'eval/metrics.json': JSON.stringify({ promptVersion: 7 }) }, {})
    expect(publishedVersions(REF, deps)).toEqual([])
  })

  it('looks at every metrics file the harness writes', () => {
    expect([...METRICS_FILES]).toContain('eval/holdout-metrics.json')
  })
})

describe('freezing', () => {
  it('allows everything while no numbers have been published', () => {
    const deps = world({ 'eval/metrics.json': metrics(null) }, { 'prompts/triage.v1.md': 'edited' })
    expect(frozenViolations(REF, deps)).toEqual([])
  })

  it('passes when the published files are untouched', () => {
    expect(frozenViolations(REF, world(PUBLISHED, PUBLISHED))).toEqual([])
  })

  it('catches an edit in place', () => {
    const deps = world(PUBLISHED, { ...PUBLISHED, 'prompts/triage.v1.md': 'reworded\n' })
    expect(frozenViolations(REF, deps)).toEqual([
      { path: 'prompts/triage.v1.md', reason: 'edited', promptVersion: 'triage.v1' },
    ])
  })

  /**
   * The case the frozen set would miss if it were the prompt files only. The
   * rubric is substituted in at load time, so editing it rewrites every
   * published prompt at once while leaving all of their files byte-identical.
   */
  it('catches a rubric edit, which changes every published prompt at once', () => {
    const deps = world(PUBLISHED, { ...PUBLISHED, 'prompts/rubric.md': 'reworded\n' })
    expect(frozenViolations(REF, deps)).toEqual([
      { path: 'prompts/rubric.md', reason: 'edited', promptVersion: 'triage.v1' },
    ])
  })

  it('catches a deletion', () => {
    const deps = world(PUBLISHED, { 'prompts/rubric.md': 'the rubric\n' })
    expect(frozenViolations(REF, deps)).toEqual([
      { path: 'prompts/triage.v1.md', reason: 'deleted', promptVersion: 'triage.v1' },
    ])
  })

  it('reports metrics that name a prompt the ref does not have', () => {
    const deps = world({ 'eval/metrics.json': metrics('triage.v4') }, {})
    expect(frozenViolations(REF, deps).map((v) => v.reason)).toEqual([
      'missing-at-ref',
      'missing-at-ref',
    ])
  })

  it('names every offending file at once rather than one per run', () => {
    const deps = world(PUBLISHED, { 'prompts/triage.v1.md': 'a', 'prompts/rubric.md': 'b' })
    expect(frozenViolations(REF, deps)).toHaveLength(2)
  })
})

describe('the message', () => {
  it('says what to do instead of what went wrong', () => {
    const rendered = renderViolations(REF, [
      { path: 'prompts/triage.v1.md', reason: 'edited', promptVersion: 'triage.v1' },
    ])
    expect(rendered).toContain('was edited in place after its numbers were published')
    expect(rendered).toContain('<agent>.v<n+1>.md')
  })
})

describe('the CLI', () => {
  const say = (): { lines: string[]; log: (message: string) => void } => {
    const lines: string[] = []
    return { lines, log: (message) => lines.push(message) }
  }

  it('is quiet and green before anything is published', () => {
    const out = say()
    expect(main([], world({}, {}), out.log)).toBe(0)
    expect(out.lines.join('')).toContain('nothing to freeze')
  })

  it('names what it verified when everything holds', () => {
    const out = say()
    expect(main([], world(PUBLISHED, PUBLISHED), out.log)).toBe(0)
    expect(out.lines.join('')).toContain('triage.v1')
  })

  it('fails on a violation', () => {
    const out = say()
    const deps = world(PUBLISHED, { ...PUBLISHED, 'prompts/rubric.md': 'x' })
    expect(main([], deps, out.log)).toBe(1)
    expect(out.lines.join('')).toContain('prompts/rubric.md')
  })

  it('takes the reference ref from the command line', () => {
    const seen: string[] = []
    const deps: FreezeDeps = {
      showAtRef: (ref, path) => {
        seen.push(ref)
        return path === REF_SENTINEL ? 'sentinel' : null
      },
      readLocal: () => null,
    }
    main(['--ref=upstream/main'], deps, () => undefined)
    expect(new Set(seen)).toEqual(new Set(['upstream/main']))
  })

  /**
   * The failure this guard exists for: a shallow checkout that never fetched the
   * reference makes every lookup return nothing, and without the probe the check
   * reports "nothing to freeze" — green, and blind.
   */
  it('refuses to pass on a ref it cannot read', () => {
    const blind: FreezeDeps = { showAtRef: () => null, readLocal: () => null }
    expect(() => main([], blind, () => undefined)).toThrow(UnreadableRefError)
  })
})

describe('reading git', () => {
  it('returns null for a path no ref has, rather than throwing', () => {
    expect(gitDeps.showAtRef('HEAD', 'prompts/no-such-file.md')).toBeNull()
    expect(gitDeps.readLocal('prompts/no-such-file.md')).toBeNull()
  })

  it('reads a committed file back', () => {
    expect(gitDeps.showAtRef('HEAD', 'package.json')).toContain('"name": "sentra"')
    expect(gitDeps.readLocal('package.json')).toContain('"name": "sentra"')
  })

  /**
   * The whole check is a comparison between these two readers. If one of them
   * normalised line endings or stripped a trailing newline and the other did
   * not, every file would look edited and the check would be switched off within
   * a day.
   */
  it('reads a committed file identically from both sides', () => {
    const changed = new Set(
      execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'docs'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean),
    )
    const tracked = execFileSync('git', ['ls-files', 'docs'], { encoding: 'utf8' })
      .split('\n')
      .filter((path) => path.endsWith('.md') && !changed.has(path))

    // Chosen from the working tree rather than hard-coded, so the test does not
    // start lying the day that one file is edited on a branch.
    const [path] = tracked
    expect(path).toBeDefined()
    expect(gitDeps.showAtRef('HEAD', path ?? '')).toBe(gitDeps.readLocal(path ?? ''))
  })
})
