import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { build, OUT_DIR, pages, SITE_URL, STYLESHEET, type Inputs } from '../../scripts/site.js'

/**
 * The Pages workflow, asserted against the file that defines it.
 *
 * It holds a deploy token, so the shape is the security property: who may
 * write, from which job, and on which events. And it has a path filter, which
 * fails by passing: a page made from a file the filter does not list goes
 * stale without a red run anywhere. Both are read here rather than trusted.
 */

const root = new URL('../..', import.meta.url).pathname
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const FILE = '.github/workflows/pages.yml'

interface Step {
  id?: string
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}

interface Job {
  needs?: string | string[]
  if?: string
  permissions?: Record<string, string>
  environment?: { name?: string; url?: string }
  steps: Step[]
}

interface Workflow {
  on: Record<string, { branches?: string[]; paths?: string[] } | null>
  permissions?: Record<string, string>
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  jobs: Record<string, Job | undefined>
}

const text = read(FILE)
const workflow = parse(text) as Workflow
const ci = parse(read('.github/workflows/ci.yml')) as Workflow
const buildJob: Job = workflow.jobs.build ?? { steps: [] }
const deployJob: Job = workflow.jobs.deploy ?? { steps: [] }
const steps = [...buildJob.steps, ...deployJob.steps]
const action = (job: Job, name: string): Step | undefined =>
  job.steps.find((step) => step.uses?.startsWith(`${name}@`) === true)

describe('when it runs', () => {
  it('on a push to main and on demand, never for a pull request', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on.push?.branches).toEqual(['main'])
  })

  /**
   * Every file a page is made from, and every file the build copies, derived
   * from the build itself. A new source or image that the filter misses is a
   * page that stops updating, and nothing would say so.
   */
  it('whenever something the site is made from changes', () => {
    const paths = workflow.on.push?.paths ?? []
    const covered = (path: string): boolean =>
      paths.some((glob) =>
        glob.endsWith('/**') ? path.startsWith(glob.slice(0, -2)) : glob === path,
      )
    const inputs: Inputs = {
      readme: read('README.md'),
      report: read('eval/report.md'),
      ablation: read('eval/ablation.md'),
      demo: '> Produced by `npm run demo` with the **baseline** classifier.',
    }
    const kind = (path: string): 'file' | 'directory' | undefined => {
      const stat = statSync(join(root, path), { throwIfNoEntry: false })
      return stat === undefined ? undefined : stat.isDirectory() ? 'directory' : 'file'
    }
    const needed = [
      ...pages(inputs).flatMap((page) => page.sources),
      ...build(inputs, { kind }, '0'.repeat(40)).assets,
      // Everything the demo reads: its run, its diff, and the test sources.
      ...readdirSync(join(root, 'demo'), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name))),
      STYLESHEET,
      'scripts/site.ts',
      FILE,
    ]
    expect(needed.filter((path) => !covered(path))).toEqual([])
  })

  it('one deployment at a time, never cancelled halfway', () => {
    expect(workflow.concurrency).toEqual({ group: 'pages', 'cancel-in-progress': false })
  })
})

describe('what it may do', () => {
  it('reads the repository, and nothing more, outside the job that deploys', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow.jobs)).toEqual(['build', 'deploy'])
    expect(buildJob.permissions).toBeUndefined()
  })

  /** The two that deploy-pages needs: a Pages write, and the OIDC token that proves the run. */
  it('writes Pages only from the deploy job, and only for main', () => {
    expect(deployJob.permissions).toEqual({ pages: 'write', 'id-token': 'write' })
    expect(deployJob.needs).toBe('build')
    expect(deployJob.if).toBe("github.ref == 'refs/heads/main'")
    expect(deployJob.environment).toEqual({
      name: 'github-pages',
      url: '${{ steps.deployment.outputs.page_url }}',
    })
  })

  it('references no secret, and no model credential', () => {
    expect(text).not.toMatch(/secrets\./)
    expect(text).not.toMatch(/ANTHROPIC|SENTRA_(?:LIVE|RECORD)/)
  })

  it('keeps no credentials in the checkout', () => {
    expect(action(buildJob, 'actions/checkout')?.with?.['persist-credentials']).toBe(false)
  })

  /** An expression inside a script is pasted into it before the shell sees it. */
  it('puts no expression inside a script', () => {
    for (const step of steps) expect(step.run ?? '').not.toContain('${{')
  })
})

describe('the steps', () => {
  it('render the site with the script, and upload what it wrote', () => {
    expect(buildJob.steps.filter((step) => step.run === 'npx tsx scripts/site.ts')).toHaveLength(1)
    expect(action(buildJob, 'actions/upload-pages-artifact')?.with).toEqual({ path: `${OUT_DIR}/` })
  })

  /**
   * configure-pages is the check that Pages is enabled: it fails the run, with
   * an annotation that says so, before anything is deployed. With `enablement`
   * on it would try to switch Pages on instead, which this token cannot do.
   */
  it('check that Pages is enabled before deploying, and do not try to enable it', () => {
    const uses = deployJob.steps.map((step) => step.uses?.split('@')[0])
    expect(uses).toEqual(['actions/configure-pages', 'actions/deploy-pages'])
    expect(action(deployJob, 'actions/configure-pages')?.with).toBeUndefined()
    expect(action(deployJob, 'actions/deploy-pages')?.id).toBe('deployment')
  })

  /** The repository requires it (`sha_pinning_required`); a tag would fail the run outright. */
  it('pin every action to a full commit SHA, with the release it is beside it', () => {
    const lines = text.split('\n').filter((line) => /^\s*(?:- )?uses:/.test(line))
    expect(lines).toHaveLength(steps.filter((step) => step.uses !== undefined).length)
    for (const line of lines)
      expect(line).toMatch(/uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
  })

  it('pin checkout and setup-node to the commits the CI workflow pins', () => {
    const pinned = new Map<string, string>()
    for (const step of Object.values(ci.jobs).flatMap((job) => job?.steps ?? [])) {
      const [name = '', sha = ''] = step.uses?.split('@') ?? []
      pinned.set(name, sha)
    }
    for (const name of ['actions/checkout', 'actions/setup-node']) {
      const sha = action(buildJob, name)?.uses?.split('@')[1]
      expect(sha, name).toMatch(/^[0-9a-f]{40}$/)
      expect(pinned.get(name), name).toBe(sha)
    }
  })
})

describe('the README', () => {
  it('links the site from the tour, which the index renders', () => {
    const readme = read('README.md')
    const tour = readme.slice(
      readme.indexOf('## The 60-second tour'),
      readme.indexOf('## The problem'),
    )
    expect(tour).toContain(`](${SITE_URL})`)
  })
})
