import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * The comment upsert, asserted against the workflow that contains it.
 *
 * It is a dozen lines of JavaScript embedded in YAML, which is the least
 * testable place in the repository — no types, no imports, and it only ever runs
 * where a mistake is visible to everyone watching the pull request. So the
 * properties are checked here, and the behaviour was watched on real pull
 * requests: #192 created one, #196 edited that same comment in place.
 *
 * The failure this guards against is not a crash, and never was — it is a wall of stale analysis. It is a fresh comment per
 * push, which turns an active pull request into a wall of stale analysis and
 * guarantees the feature is muted within a week.
 */

const root = new URL('../..', import.meta.url).pathname
const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
const parsed = parse(workflow) as {
  jobs: Record<string, { steps?: { name?: string; if?: string; with?: { script?: string } }[] }>
}

const step = parsed.jobs.analyze?.steps?.find((s) => s.name === 'Upsert PR comment')
const script = step?.with?.script ?? ''

describe('the upsert step', () => {
  it('exists, in the one job with permission to comment', () => {
    expect(script).not.toBe('')
  })

  /** Written by `agents/report.ts`, which owns the document, and matched here. */
  it('finds its own comment by a hidden marker', () => {
    expect(script).toContain('<!-- sentra:report -->')
    expect(script).toContain('startsWith(MARKER)')
  })

  /**
   * An old pull request has more comments than one page holds, and `listComments`
   * without pagination would silently stop looking — then post a second comment
   * beside the one it failed to find.
   */
  it('paginates, so an old pull request still finds its comment', () => {
    expect(script).toContain('github.paginate')
    expect(script).not.toMatch(/await github\.rest\.issues\.listComments\(/)
  })

  it('updates when it finds one and creates when it does not', () => {
    expect(script).toContain('updateComment')
    expect(script).toContain('createComment')
    // A deleted comment simply is not found, so the create branch handles it —
    // no special case, and nothing to throw.
    expect(script).toMatch(/if \(existing\)[\s\S]*else[\s\S]*createComment/)
  })

  /** Replaced wholesale. Appending would grow a comment nobody finishes reading. */
  it('replaces the body rather than appending to it', () => {
    expect(script).toContain("body = fs.readFileSync('report.md', 'utf8')")
    expect(script).not.toContain('existing.body +')
  })

  /**
   * Nothing is posted when there is nothing wrong: `run.ts` writes no file for a
   * green run, and `hashFiles` on a missing file is the empty string.
   */
  it('does not run when no report was written', () => {
    expect(step?.if).toContain("hashFiles('report.md') != ''")
  })

  it('does not run outside a pull request', () => {
    expect(step?.if).toContain("github.event_name == 'pull_request'")
  })
})

describe('what the comment carries', () => {
  /**
   * The commit is the first line of the report, because a comment edited in
   * place otherwise gives no way to tell which push it describes.
   */
  it('names the commit it analysed', async () => {
    const { renderReport } = await import('../../agents/report.js')
    const report = renderReport({
      triaged: [],
      commitSha: 'abc1234def5678',
      branch: 'main',
      runId: '1',
      model: 'claude-opus-5',
      promptVersions: { triage: 'triage.v1' },
      usage: [],
    })
    expect(report).toContain('`abc1234`')
  })
})
