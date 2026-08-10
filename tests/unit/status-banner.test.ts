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

  it('marks every unimplemented pipeline command in the wiki quickstart (#116)', () => {
    // The wiki described npm run demo in the present tense while it was a
    // placeholder. It is the more public of the two surfaces, so it needs the
    // README's convention rather than an exemption from it.
    const page = readFileSync(join(root, 'wiki/Getting-Started.md'), 'utf8')
    for (const command of ['npm run demo', 'npm run dev', 'npm run eval', 'npm test']) {
      const line = page.split('\n').find((l) => l.includes(command) && l.includes('🚧'))
      expect(line, `${command} is described without a 🚧 marker`).toBeTruthy()
    }
  })
})
