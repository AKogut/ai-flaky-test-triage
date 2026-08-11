import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRoadmap, renderBanner, splice } from '../../scripts/status-banner.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const roadmap = (...sections: [id: string, status: string][]): string =>
  sections
    .map(
      ([id, status]) =>
        `## ${id} — Theme for ${id}\n\nProse.\n\n**Status:** ${status}\n\n**Exit criterion:** something\nthat wraps onto a second line.\n`,
    )
    .join('\n')

describe('parseRoadmap', () => {
  it('reads id, theme, status and a wrapped exit criterion', () => {
    const [m] = parseRoadmap(roadmap(['M0', 'in progress']))
    expect(m).toEqual({
      id: 'M0',
      theme: 'Theme for M0',
      status: 'in progress',
      exitCriterion: 'something that wraps onto a second line.',
    })
  })

  it('rejects a status value it does not understand', () => {
    // A typo silently treated as "planned" would produce a plausible, wrong banner.
    expect(() => parseRoadmap(roadmap(['M0', 'nearly done']))).toThrow(/unknown status/)
  })

  it('drops a section that is missing a required field rather than half-parsing it', () => {
    expect(parseRoadmap('## M0 — Theme\n\n**Status:** done\n')).toHaveLength(0)
  })

  it('parses every milestone in the real ROADMAP.md', () => {
    const parsed = parseRoadmap(readFileSync(join(root, 'ROADMAP.md'), 'utf8'))
    expect(parsed).toHaveLength(11)
    expect(parsed.map((m) => m.id)).toEqual([
      'M0',
      'M1',
      'M2',
      'M3',
      'M4',
      'M5',
      'M6',
      'M7',
      'M8',
      'M9',
      'M10',
    ])
    for (const m of parsed) expect(m.exitCriterion.length).toBeGreaterThan(20)
  })
})

describe('renderBanner', () => {
  it('names the active milestone and counts the completed ones', () => {
    const banner = renderBanner(
      parseRoadmap(roadmap(['M0', 'done'], ['M1', 'in progress'], ['M2', 'planned'])),
    )
    expect(banner).toContain('M1 — Theme for M1')
    expect(banner).toContain('1 of 3 milestones complete')
  })

  it('refuses to guess when nothing is in progress', () => {
    expect(() => renderBanner(parseRoadmap(roadmap(['M0', 'done'], ['M1', 'planned'])))).toThrow(
      /no milestone marked/,
    )
  })

  it('switches to a completion banner when every milestone is done', () => {
    const banner = renderBanner(parseRoadmap(roadmap(['M0', 'done'], ['M1', 'done'])))
    expect(banner).toContain('All 2 milestones complete')
  })
})

describe('splice', () => {
  const doc = '# T\n\n<!-- status:start -->\n\nold\n\n<!-- status:end -->\n\nrest\n'

  it('replaces only the marked region', () => {
    const out = splice(doc, '> new')
    expect(out).toContain('> new')
    expect(out).not.toContain('old')
    expect(out).toContain('rest')
  })

  it('is idempotent', () => {
    expect(splice(splice(doc, '> new'), '> new')).toBe(splice(doc, '> new'))
  })

  it('refuses to guess when the markers are missing', () => {
    expect(() => splice('# T\n', '> new')).toThrow(/markers/)
  })
})

describe('the committed pages', () => {
  const milestones = parseRoadmap(readFileSync(join(root, 'ROADMAP.md'), 'utf8'))

  it.each([
    ['README.md', 'readme'],
    ['wiki/Home.md', 'wiki'],
    ['wiki/Getting-Started.md', 'wiki'],
  ] as const)('%s matches what generation produces', (file, variant) => {
    const page = readFileSync(join(root, file), 'utf8')
    expect(splice(page, renderBanner(milestones, variant))).toBe(page)
  })

  /**
   * The wiki described `npm run demo` in the present tense while it was a
   * placeholder (#116). It is the more public of the two surfaces, so it gets
   * the README's convention rather than an exemption from it.
   *
   * The command list is derived from `script-manifest.json` rather than written
   * out here. The hand-written version went stale twice over: it still demanded
   * a marker on `npm run eval` after #27 implemented it, and it never knew about
   * `eval:ablation` or `analyze`. A guard that has to be remembered is a guard
   * that eventually lies.
   */
  describe('unimplemented commands in every document that shows one (#116, #134)', () => {
    const manifest = JSON.parse(
      readFileSync(join(root, 'scripts/script-manifest.json'), 'utf8'),
    ) as { scripts: { name: string; status: 'implemented' | 'pending' }[] }

    /** `test:unit` → `npm run test:unit`; `test` → `npm test`. */
    const invocation = (name: string): string => (name === 'test' ? 'npm test' : `npm run ${name}`)

    /**
     * Every tracked document, rather than the one page somebody remembered.
     *
     * The first version named `wiki/Getting-Started.md` alone, and
     * `CONTRIBUTING.md` — the file a contributor reads immediately before
     * typing the commands, so the worst place for a false one — described
     * `npm run demo` and a whole evaluation section in the present tense the
     * entire time (#134).
     */
    const documents = execSync('git ls-files "*.md"', { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file !== '')

    /**
     * Lines that present a command with an inline annotation.
     *
     * The `#` is what separates "here is a command to run" from prose that
     * happens to name one. A sentence explaining why `npm test` will eventually
     * contain flaky specs is not a promise that it runs today.
     */
    const annotatedMentions = (command: string): { file: string; line: string }[] =>
      documents.flatMap((file) =>
        readFileSync(join(root, file), 'utf8')
          .split('\n')
          .filter((line) => new RegExp(`${command}(?![\\w:-])`).test(line) && line.includes('#'))
          .map((line) => ({ file, line })),
      )

    it.each(manifest.scripts.filter((s) => s.status === 'pending').map((s) => s.name))(
      '%s is shown with a marker wherever it is annotated',
      (name) => {
        for (const { file, line } of annotatedMentions(invocation(name))) {
          expect(line, `${file}: "${line.trim()}" shows a pending command with no 🚧`).toContain(
            '🚧',
          )
        }
      },
    )

    it.each(manifest.scripts.filter((s) => s.status === 'implemented').map((s) => s.name))(
      '%s is never marked as pending',
      (name) => {
        for (const { file, line } of annotatedMentions(invocation(name))) {
          expect(
            line,
            `${file}: "${line.trim()}" marks an implemented command as pending`,
          ).not.toContain('🚧')
        }
      },
    )

    it('marks the README script table in step with the manifest', () => {
      // The table is the canonical listing, and its milestone column carries the
      // marker separately from the quickstart blocks above it.
      const readme = readFileSync(join(root, 'README.md'), 'utf8')
      for (const entry of manifest.scripts) {
        const row = readme
          .split('\n')
          .find((line) => new RegExp(`^\\| \`${invocation(entry.name)}\`(?![\\w:-])`).test(line))
        expect(row, `${entry.name} has no row in the README table`).toBeTruthy()
        expect(row?.includes('🚧'), `${entry.name} is marked ${entry.status} in the manifest`).toBe(
          entry.status === 'pending',
        )
      }
    })
  })
})
