import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * The clean-clone workflow, asserted against the file that defines it.
 *
 * It checks the README's Definition of Done the way a stranger would, and every
 * property below is one that would let it pass on a machine no stranger has: a
 * restored npm cache, a credential in the environment, a token left in the
 * checkout, an install command other than the one the README prints. None of it
 * is typed, and each one fails by passing, so it is read here. The two scripts
 * that decide something, the credential check and the timing table, are run.
 */

const root = new URL('../..', import.meta.url).pathname
const FILE = '.github/workflows/clean-clone.yml'

interface Step {
  name?: string
  id?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, string | number | boolean>
}

interface Job {
  name?: string
  'runs-on'?: string
  permissions?: Record<string, string>
  env?: Record<string, string>
  strategy?: { 'fail-fast'?: boolean; matrix?: { os?: string[] } }
  steps: Step[]
}

interface Workflow {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  env?: Record<string, string>
  jobs: Record<string, Job | undefined>
}

const text = readFileSync(join(root, FILE), 'utf8')
const workflow = parse(text) as Workflow
const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as Workflow
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const branching = readFileSync(join(root, 'docs/branching-strategy.md'), 'utf8')

const job: Job = workflow.jobs['clean-clone'] ?? { steps: [] }
const steps = job.steps
const using = (action: string): Step | undefined =>
  steps.find((step) => step.uses?.startsWith(`${action}@`) === true)
const named = (name: string): Step | undefined => steps.find((step) => step.name === name)
const lines = (step: Step | undefined): string[] =>
  (step?.run ?? '').split('\n').map((line) => line.trim())

/** The Definition of Done, from its heading to the next one. */
const dod = readme.slice(readme.indexOf('## Definition of Done'), readme.indexOf('## Contributing'))

/** A step's script, run the way the runner runs it, in an empty directory. */
function runStep(
  step: Step | undefined,
  env: Record<string, string>,
  files: Record<string, string> = {},
): { code: number | null; stdout: string; summary: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sentra-clean-clone-'))
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
  const summary = join(dir, 'summary.md')
  writeFileSync(summary, '')
  const script = join(dir, 'step.sh')
  writeFileSync(script, step?.run ?? 'exit 99')

  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      RUNNER_TEMP: dir,
      TIMINGS: join(dir, 'timings.tsv'),
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
    encoding: 'utf8',
  })
  return { code: result.status, stdout: result.stdout, summary: readFileSync(summary, 'utf8') }
}

describe('when it runs', () => {
  it('on demand, weekly, and on pull requests that change what installing depends on', () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      'pull_request',
      'schedule',
      'workflow_dispatch',
    ])
    expect(workflow.on.schedule).toHaveLength(1)
  })

  const paths = (workflow.on.pull_request as { paths?: string[] } | undefined)?.paths ?? []

  it('includes the manifests, the lockfile, the Node line and the demo', () => {
    for (const path of ['**/package.json', 'package-lock.json', '.nvmrc', 'scripts/demo.ts']) {
      expect(paths).toContain(path)
    }
  })

  /** A rename that forgot the filter would stop the workflow from testing its own edits. */
  it('includes this workflow, under its own name', () => {
    expect(paths).toContain(FILE)
  })

  /**
   * Filtered by path, so it does not report on most pull requests, and a
   * required check that never reports leaves the pull request waiting.
   */
  it('is not one of the required checks', () => {
    const required = branching.split('\n').find((line) => line.includes('Required status checks'))
    expect(required).toBeDefined()
    expect(required).not.toContain(job.name?.split(' (')[0] ?? 'Clean clone')
    expect(branching).toContain('`Clean clone`')
  })
})

describe('the machine', () => {
  it('is a fresh Linux and a fresh macOS runner, and one failing does not cancel the other', () => {
    expect(job['runs-on']).toBe('${{ matrix.os }}')
    expect(job.strategy?.matrix?.os).toEqual(['ubuntu-latest', 'macos-latest'])
    expect(job.strategy?.['fail-fast']).toBe(false)
  })

  it('clears the npm cache and the Playwright browsers before the clock starts', () => {
    const clear = steps.findIndex((step) => step.run?.includes('rm -rf') === true)
    expect(clear).toBeGreaterThanOrEqual(0)
    expect(steps[clear]?.run).toContain('$HOME/.npm')
    expect(steps[clear]?.run).toContain('ms-playwright')
    expect(clear).toBeLessThan(steps.indexOf(using('actions/checkout') ?? {}))
  })

  /** setup-node restores an npm cache by itself once package.json names npm in `packageManager`. */
  it('gets Node from .nvmrc, with no npm cache', () => {
    const node = using('actions/setup-node')
    expect(node?.with?.['node-version-file']).toBe('.nvmrc')
    expect(node?.with?.cache).toBeUndefined()
    expect(node?.with?.['package-manager-cache']).toBe(false)
  })

  it('clones full history and leaves no token in the checkout', () => {
    const checkout = using('actions/checkout')
    expect(checkout?.with?.['fetch-depth']).toBe(0)
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })
})

describe('the credentials', () => {
  it('are read-only, and nothing widens them', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(job.permissions).toBeUndefined()
  })

  /** "No API key" is one of the claims under test, so nothing here may pass one in. */
  it('include no secret and no model variable anywhere', () => {
    expect(text).not.toContain('secrets.')
    const envs = [workflow.env, job.env, ...steps.map((step) => step.env)]
    for (const env of envs) {
      for (const key of Object.keys(env ?? {})) expect(key).not.toMatch(/^(ANTHROPIC_|SENTRA_)/)
    }
  })

  const guard = steps[0]

  it('are checked for first', () => {
    expect(guard?.name).toBe('No model credential in the environment')
  })

  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SENTRA_LIVE', 'SENTRA_RECORD'])(
    'fail the job when %s is set',
    (variable) => {
      const { code, stdout } = runStep(guard, { [variable]: 'x' })
      expect(code).toBe(1)
      expect(stdout).toContain(`::error::`)
      expect(stdout).toContain(variable)
    },
    20_000,
  )

  it('pass a clean environment', () => {
    expect(runStep(guard, { SENTRA_E2E_RETRIES: '0' }).code).toBe(0)
  }, 20_000)
})

describe('the commands', () => {
  /** The README is the contract. If it says `npm ci` one day, so does this. */
  it('install the way the Definition of Done says to', () => {
    const install = /`git clone` → `([^`]+)` → `npm run demo`/.exec(dod)?.[1]
    expect(install).toBe('npm install')
    expect(lines(named('npm install'))).toContain(install)
  })

  it('run the demo and check the report names the classifier that ran', () => {
    const demo = lines(named('npm run demo'))
    expect(demo).toContain('npm run demo')
    expect(demo).toContain('test -s report.md')
    expect(demo).toContain("grep -F 'with the **baseline** classifier' report.md")
  })

  it('run npm test and npm run eval as a reader would, without the gate', () => {
    expect(lines(named('npm test'))).toContain('npm test || status=$?')
    const evaluation = lines(named('npm run eval'))
    expect(evaluation).toContain('npm run eval')
    expect(named('npm run eval')?.run).not.toContain('--gate')
  })

  /** The suite is red by design, so the verdict is the one the E2E job uses, not the exit status. */
  it('judge the e2e run exactly as the CI workflow does', () => {
    const ours = steps.find((step) => step.run?.includes('scripts/e2e-summary.ts') === true)
    const theirs = ci.jobs.e2e?.steps.find((step) => step.run?.includes('e2e-summary.ts') === true)
    expect(ours?.run).toBe(theirs?.run)
    expect(ours?.env?.E2E_EXIT_CODE).toBe('${{ steps.test.outputs.exit-code }}')
    expect(ours?.if).toBe("${{ !cancelled() && steps.test.outcome == 'success' }}")
  })

  /** An expression inside `run:` is pasted into the script before the shell sees it. */
  it('have no expression interpolated into them', () => {
    for (const step of steps) expect(step.run ?? '').not.toContain('${{')
  })

  /** The repository requires a full SHA; reusing CI's keeps one version of each action. */
  it('use actions pinned to the same commit the CI workflow pins', () => {
    const split = (uses: string): [string, string] => {
      const [name = '', sha = ''] = uses.split('@')
      return [name, sha]
    }
    const pinned = new Map(
      Object.values(ci.jobs)
        .flatMap((definition) => definition?.steps ?? [])
        .flatMap((step) => (step.uses === undefined ? [] : [split(step.uses)])),
    )
    const actions = steps.flatMap((step) => step.uses ?? [])
    expect(actions.length).toBe(3)
    for (const action of actions) {
      const [name, sha] = split(action)
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      expect(pinned.get(name)).toBe(sha)
    }
  })
})

describe('the timings', () => {
  const summary = named('Write the timings to the job summary')
  const KEYS = ['clone', 'install', 'demo', 'browser', 'test', 'eval']

  /** A key written under one name and read under another is a row that always says "did not finish". */
  it('are written once per step under the names the summary reads', () => {
    const written = steps.flatMap((step) =>
      [...(step.run ?? '').matchAll(/printf '(\w+)\\t%s\\n'/g)].map((match) => match[1]),
    )
    expect(written.sort()).toEqual([...KEYS].sort())
    for (const key of KEYS) expect(summary?.run).toContain(`cell ${key}`)
  })

  it('are summarised whatever happened', () => {
    expect(summary?.if).toBe('always()')
  })

  const ENV = {
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    GITHUB_RUN_ID: '42',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'owner/repo',
    CLONE_START: String(Math.floor(Date.now() / 1000) - 400),
  }

  it('make a table with clone-to-report and the whole job', () => {
    const {
      code,
      stdout,
      summary: markdown,
    } = runStep(summary, ENV, {
      'timings.tsv': 'clone\t3\ninstall\t41\ndemo\t2\nbrowser\t30\ntest\t185\neval\t4\n',
    })
    expect(code).toBe(0)
    // The log carries the same table, so the transcript survives without the summary page.
    expect(stdout).toBe(markdown)
    expect(markdown).toContain('## Clean clone on Linux')
    expect(markdown).toContain('[run 42](https://github.com/owner/repo/actions/runs/42)')
    expect(markdown).toContain('| `git clone`, full history | 3s |')
    expect(markdown).toContain('| **Clone to `report.md`** | **46s** |')
    expect(markdown).toContain('| `npm test`, unit then e2e | 3m 05s |')
    expect(markdown).toMatch(/\| \*\*Whole job\*\*, [^|]+ \| \*\*6m 4\ds\*\* \|/)
    expect(markdown).not.toContain('changed tracked files')
  }, 20_000)

  it('say which step did not finish, and do not total a clone that stopped', () => {
    const { code, summary: markdown } = runStep(summary, ENV, {
      'timings.tsv': 'clone\t3\ninstall\t41\n',
    })
    expect(code).toBe(0)
    expect(markdown).toContain('| `npm run demo` | did not finish |')
    expect(markdown).toContain('| **Clone to `report.md`** | **did not finish** |')
  }, 20_000)

  it('still write a table when nothing was timed', () => {
    const { code, summary: markdown } = runStep(summary, { ...ENV, CLONE_START: '' })
    expect(code).toBe(0)
    expect(markdown).toContain('| `git clone`, full history | did not finish |')
    expect(markdown).toMatch(/\| \*\*Whole job\*\*, [^|]+ \| \*\*did not finish\*\* \|/)
  }, 20_000)

  it('list the files npm install changed', () => {
    const { summary: markdown } = runStep(summary, ENV, {
      'timings.tsv': 'clone\t3\n',
      'install-changes.txt': ' M package-lock.json\n',
    })
    expect(markdown).toContain('`npm install` changed tracked files in the checkout:')
    expect(markdown).toContain('```\n M package-lock.json\n```')
  }, 20_000)
})

describe('the README', () => {
  /** A duration with no date and no run is a number nobody can check or notice going stale. */
  it('states the measured time with the date and the run it came from', () => {
    expect(dod).toMatch(
      /measured on \d{4}-\d{2}-\d{2} in\s+\[run \d+\]\(https:\/\/github\.com\/AKogut\/ai-flaky-test-triage\/actions\/runs\/\d+\)/,
    )
    expect(dod).toMatch(/\d+ s on Linux and \d+ s on macOS/)
  })

  it('points at this workflow, so the next measurement is one click away', () => {
    expect(dod).toContain(`(${FILE})`)
    expect(dod).toContain('actions/workflows/clean-clone.yml')
  })

  /** The clean runs install the browser before `npm test`, and the Definition of Done says so. */
  it('names the browser npm test needs', () => {
    expect(dod).toContain('npx playwright install chromium')
  })
})
