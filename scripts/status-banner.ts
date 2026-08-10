/**
 * Regenerate the README status banner from ROADMAP.md.
 *
 * A hand-maintained "Project status: Phase M0" line on a repository that has
 * shipped M6 undermines every other claim on the page, and it is exactly the
 * kind of edit that gets forgotten. This derives it from the one place the
 * milestone state is already recorded.
 *
 * Deliberately offline. The obvious alternative — querying the GitHub API for
 * open and closed issue counts — makes the check non-deterministic: closing an
 * unrelated issue would turn `main` red until somebody regenerated a README.
 * A gate that fires on activity elsewhere gets disabled by whoever is on call.
 * Live counts are shown as shields.io badges instead, which are always current
 * and need no maintenance at all.
 *
 * Usage: tsx scripts/status-banner.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const START = '<!-- status:start -->'
const END = '<!-- status:end -->'

const REPO = 'https://github.com/AKogut/ai-flaky-test-triage'

export type MilestoneStatus = 'done' | 'in progress' | 'planned'

export interface Milestone {
  id: string
  theme: string
  status: MilestoneStatus
  exitCriterion: string
}

const isStatus = (v: string): v is MilestoneStatus =>
  v === 'done' || v === 'in progress' || v === 'planned'

/**
 * Parse the milestone sections out of ROADMAP.md.
 *
 * Exported for testing: the parser silently returning fewer milestones than the
 * document contains would produce a plausible, wrong banner.
 */
export function parseRoadmap(markdown: string): Milestone[] {
  const milestones: Milestone[] = []
  let current: Partial<Milestone> | null = null

  const flush = (): void => {
    if (
      current?.id !== undefined &&
      current.theme !== undefined &&
      current.status !== undefined &&
      current.exitCriterion !== undefined
    ) {
      milestones.push(current as Milestone)
    }
    current = null
  }

  const lines = markdown.split('\n')
  for (const [index, line] of lines.entries()) {
    const heading = /^## (M\d+) — (.+)$/.exec(line)
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flush()
      current = { id: heading[1], theme: heading[2].trim() }
      continue
    }
    if (current === null) continue

    const status = /^\*\*Status:\*\*\s*(.+)$/.exec(line)
    if (status?.[1] !== undefined) {
      const value = status[1].trim()
      if (!isStatus(value)) {
        throw new Error(`ROADMAP.md: ${current.id ?? '?'} has unknown status "${value}"`)
      }
      current.status = value
      continue
    }

    const exit = /^\*\*Exit criterion:\*\*\s*(.*)$/.exec(line)
    if (exit?.[1] !== undefined) {
      // Exit criteria wrap across lines; take everything up to the blank line.
      const rest: string[] = [exit[1]]
      for (const next of lines.slice(index + 1)) {
        if (next.trim() === '') break
        rest.push(next.trim())
      }
      current.exitCriterion = rest.join(' ').trim()
    }
  }
  flush()

  return milestones
}

export function renderBanner(milestones: Milestone[]): string {
  const done = milestones.filter((m) => m.status === 'done')
  const active = milestones.find((m) => m.status === 'in progress')
  const total = milestones.length

  if (active === undefined) {
    if (done.length === total && total > 0) {
      return [
        `> **All ${String(total)} milestones complete.** The Definition of Done below holds end to`,
        `> end on a clean clone. See [\`eval/report.md\`](eval/report.md) for how well the classifier`,
        `> actually performs.`,
      ].join('\n')
    }
    throw new Error('ROADMAP.md has no milestone marked "in progress"')
  }

  return [
    `> **Project status: ${active.id} — ${active.theme}.**`,
    `> ${String(done.length)} of ${String(total)} milestones complete.`,
    `> Current exit criterion: ${active.exitCriterion}`,
    `>`,
    `> Progress is tracked as [milestones](${REPO}/milestones), not dates.`,
    `> Commands marked 🚧 in the script table are not implemented yet and say so when run.`,
  ].join('\n')
}

export function splice(readme: string, banner: string): string {
  const start = readme.indexOf(START)
  const end = readme.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md is missing the ${START} / ${END} markers`)
  }
  return `${readme.slice(0, start + START.length)}\n\n${banner}\n\n${readme.slice(end)}`
}

function main(): void {
  const milestones = parseRoadmap(readFileSync('ROADMAP.md', 'utf8'))
  if (milestones.length === 0) throw new Error('ROADMAP.md: no milestones parsed')

  const readme = readFileSync('README.md', 'utf8')
  const next = splice(readme, renderBanner(milestones))

  if (process.argv.includes('--check')) {
    if (next !== readme) {
      console.error('README status banner is out of date with ROADMAP.md. Run: npm run docs:status')
      process.exit(1)
    }
    console.log(`README status banner is up to date (${String(milestones.length)} milestones)`)
    return
  }

  writeFileSync('README.md', next)
  console.log('README status banner regenerated')
}

if (process.argv[1]?.endsWith('status-banner.ts') === true) main()
