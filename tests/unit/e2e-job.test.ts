import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * The E2E job, asserted against the workflow that defines it.
 *
 * Three properties live only in YAML, where no type checks them. A red suite
 * must not fail a step, because a failed step is a red annotation on a green
 * run. A broken run must still fail the job. And the evidence the analysis
 * jobs read must be uploaded whatever happened. Each one fails quietly if it
 * breaks, so the step that decides the first two is run here, not only read.
 */

const root = new URL('../..', import.meta.url).pathname

interface Step {
  name?: string
  id?: string
  uses?: string
  if?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, string | number>
  'continue-on-error'?: boolean
}

interface Job {
  outputs?: Record<string, string>
  steps: Step[]
  'continue-on-error'?: boolean
}

const workflow = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job | undefined>
}
const e2e: Job = workflow.jobs.e2e ?? { steps: [] }
const steps = e2e.steps

const indexOf = (predicate: (step: Step) => boolean): number => steps.findIndex(predicate)
const playwright = steps.find((step) => step.id === 'e2e')
const summary = steps.find((step) => step.run?.includes('scripts/e2e-summary.ts') === true)
const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@') === true)

/** The step's script, run the way the runner runs it, with `npm` replaced by one that exits `status`. */
function runPlaywrightStep(status: number): {
  code: number | null
  outputs: Record<string, string>
} {
  const dir = mkdtempSync(join(tmpdir(), 'sentra-e2e-step-'))
  const npm = join(dir, 'npm')
  writeFileSync(npm, `#!/bin/sh\nexit ${String(status)}\n`)
  chmodSync(npm, 0o755)

  const script = join(dir, 'step.sh')
  const output = join(dir, 'output')
  writeFileSync(script, playwright?.run ?? 'exit 99')
  writeFileSync(output, '')

  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  })
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
  return { code: result.status, outputs }
}

describe('the Playwright step', () => {
  it('is the one with id `e2e`, and runs the suite the way a contributor does', () => {
    expect(playwright?.name).toBe('Run Playwright')
    expect(playwright?.run).toContain('npm run test:e2e')
  })

  it.each([
    [0, 'success'],
    [1, 'failure'],
    [2, 'failure'],
  ])(
    'does not fail when the suite exits %i, and records %s',
    (status, outcome) => {
      const { code, outputs } = runPlaywrightStep(status)
      expect(code).toBe(0)
      expect(outputs).toEqual({ 'exit-code': String(status), outcome })
    },
    // A real shell, spawned. Milliseconds on a runner; seconds on a busy laptop.
    20_000,
  )

  /**
   * `continue-on-error` let the step fail, which is the red annotation, and
   * forgave whatever made it fail, which is the silent part. The step exits 0 on
   * its own now. Anything that still fails it is the shell breaking, and that
   * should turn the job red.
   */
  it('has no continue-on-error, and neither does the job', () => {
    expect(steps.filter((step) => step['continue-on-error'] !== undefined)).toEqual([])
    expect(e2e['continue-on-error']).toBeUndefined()
  })

  it('is what the job reports as the suite’s outcome', () => {
    expect(e2e.outputs?.outcome).toBe('${{ steps.e2e.outputs.outcome }}')
  })
})

describe('the summary step', () => {
  it('runs the script that judges the report, which exists', () => {
    expect(summary?.run).toBe('npx tsx scripts/e2e-summary.ts')
    expect(existsSync(join(root, 'scripts/e2e-summary.ts'))).toBe(true)
  })

  it('comes after the suite and after the upload, so its verdict cannot cost the evidence', () => {
    const at = indexOf((step) => step === summary)
    expect(at).toBeGreaterThan(indexOf((step) => step === playwright))
    expect(at).toBeGreaterThan(indexOf((step) => step === upload))
  })

  /**
   * Whenever the suite ran, including after a failed upload. Not when it never
   * ran: the step that stopped it has already failed the job, and a second error
   * about a missing report would point at the wrong thing.
   */
  it('runs whenever the suite ran', () => {
    expect(summary?.if).toBe("${{ !cancelled() && steps.e2e.outcome == 'success' }}")
  })

  it('is handed the exit status through env', () => {
    expect(summary?.env?.E2E_EXIT_CODE).toBe('${{ steps.e2e.outputs.exit-code }}')
  })
})

describe('the scripts', () => {
  /**
   * An expression inside `run:` is pasted into the script before the shell
   * sees it. Outputs and anything else go in through `env` instead.
   */
  it('have no expression interpolated into them', () => {
    for (const step of steps) expect(step.run ?? '').not.toContain('${{')
  })
})

describe('the evidence', () => {
  /** What `Flakiness analysis` and `Agent triage` download. A red run is the one worth keeping. */
  it('is uploaded whatever the outcome, unchanged', () => {
    expect(upload?.if).toBe('always()')
    expect(upload?.with?.name).toBe('test-results')
    expect(String(upload?.with?.path).trim().split('\n')).toEqual([
      'results.json',
      'playwright-report/',
      'test-results/',
    ])
    expect(upload?.with?.['retention-days']).toBe(14)
  })
})

describe('the actions the job uses', () => {
  /** The repository requires it (`sha_pinning_required`); a tag would fail the run outright. */
  it('are pinned to a full commit SHA', () => {
    const actions = steps.flatMap((step) => step.uses ?? [])
    expect(actions.length).toBeGreaterThan(0)
    for (const action of actions) expect(action).toMatch(/@[0-9a-f]{40}$/)
  })
})
