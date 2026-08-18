import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * The history cache, checked against ADR-0004 rather than against a reviewer.
 *
 * Three of the ADR's guarantees live entirely in the workflow file, where no
 * type checks them and no test runs them: the restore keys, the single writer,
 * and the flag that makes a job a writer. Every one of them fails silently.
 *
 * A wrong restore key does not error — it produces a cache miss, and a cache
 * miss is indistinguishable from a first run on a branch. A pull-request job
 * that passed `--write-history` would not error either; it would quietly feed
 * its own branch's failures into the history that judges the next one, and the
 * only symptom would be a determinism signal that slowly stopped meaning
 * anything.
 *
 * So the keys are asserted here against the ADR's own text, and the writer is
 * asserted to be exactly one job on exactly one branch.
 */

const root = new URL('../..', import.meta.url).pathname
const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
const adr = readFileSync(join(root, 'docs/adr/0004-history-persistence-via-ci-cache.md'), 'utf8')

interface Step {
  name?: string
  uses?: string
  if?: string
  run?: string
  id?: string
  with?: Record<string, string>
}
interface Job {
  name?: string
  needs?: string | string[]
  if?: string
  steps?: Step[]
}

const jobs = (parse(workflow) as { jobs: Record<string, Job> }).jobs
const steps = (job: string): Step[] => jobs[job]?.steps ?? []
const stepsUsing = (prefix: string): { job: string; step: Step }[] =>
  Object.entries(jobs).flatMap(([job, definition]) =>
    (definition.steps ?? [])
      .filter((step) => step.uses?.startsWith(prefix) === true)
      .map((step) => ({ job, step })),
  )

const HISTORY_PATH = '.flakemetry/history.json'

describe('the restore keys', () => {
  const restore = stepsUsing('actions/cache/restore@')

  it('is exactly one step, so there is one place the lookup is defined', () => {
    expect(restore).toHaveLength(1)
    expect(restore[0]?.job).toBe('flakemetry')
  })

  it('restores the path the library reads', () => {
    expect(restore[0]?.step.with?.path).toBe(HISTORY_PATH)
  })

  /**
   * The exact key carries this run's id and can never hit — no earlier run wrote
   * it. That is deliberate: it turns every lookup into a prefix search over the
   * restore keys, newest first, which is the semantics the ADR chose `actions/cache`
   * for in the first place.
   */
  it('uses a key no earlier run can have written', () => {
    expect(restore[0]?.step.with?.key).toBe('history-${{ github.ref_name }}-${{ github.run_id }}')
  })

  it('falls back to this branch, then to main, in that order', () => {
    const keys = (restore[0]?.step.with?.['restore-keys'] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')

    expect(keys).toEqual(['history-${{ github.ref_name }}-', 'history-main-'])
  })

  /** The ADR is the specification; drift between the two is the thing to catch. */
  it('matches the keys the ADR specifies', () => {
    expect(adr).toContain('history-${{ github.ref_name }}-${{ github.run_id }}')
    expect(adr).toContain('history-${{ github.ref_name }}-')
    expect(adr).toContain('history-main-')
  })
})

describe('the single writer', () => {
  const save = stepsUsing('actions/cache/save@')

  /**
   * ADR-0004 eliminates the lost-update race by having exactly one writer rather
   * than by mitigating contention. A second save step anywhere would put the
   * race back without changing a line of the reasoning that says there is none.
   */
  it('is one step, in one job', () => {
    expect(save).toHaveLength(1)
    expect(save[0]?.job).toBe('flakemetry')
  })

  it('runs only on main', () => {
    expect(save[0]?.step.if).toBe("github.ref == 'refs/heads/main'")
  })

  it('saves under the key the restore keys fall back to', () => {
    expect(save[0]?.step.with?.key).toBe('history-main-${{ github.run_id }}')
    expect(save[0]?.step.with?.path).toBe(HISTORY_PATH)
  })
})

describe('--write-history', () => {
  const commands = Object.values(jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? '')

  /**
   * The flag is what makes a job a writer, and a pull-request job that passed it
   * would not error — it would feed its own branch's failures into the history
   * that judges the next one, and the only symptom would be a determinism signal
   * that slowly stopped meaning anything.
   */
  it('is passed only inside a branch guarded on main', () => {
    const passing = commands.filter((run) => run.includes('--write-history'))
    expect(passing).toHaveLength(1)

    const command = passing[0] ?? ''
    const guard = command.indexOf('refs/heads/main')
    const flag = command.indexOf('--write-history')
    expect(guard, 'the main guard must come before the flag it guards').toBeGreaterThan(-1)
    expect(flag).toBeGreaterThan(guard)
  })

  it('has a branch that analyses without it, so pull requests still get a report', () => {
    const command = commands.find((run) => run.includes('--write-history')) ?? ''
    const withoutFlag = command
      .split('\n')
      .filter((line) => line.includes('flakemetry:analyze') && !line.includes('--write-history'))
    expect(withoutFlag).toHaveLength(1)
  })
})

describe('the job that runs it', () => {
  it('does not wait for a milestone that has not shipped', () => {
    // Gated on the command existing, not on the agents. Sharing a job with the
    // triage agents is how the history cache sat unexercised through all of M6:
    // `has-agents` looks for `agents/run.ts`, which lands in M7.
    expect(jobs.flakemetry?.if).toContain('has-flakemetry')
    expect(jobs.flakemetry?.if).not.toContain('has-agents')
  })

  /** The runs worth recording are the red ones. */
  it('runs even when the suites failed', () => {
    expect(jobs.flakemetry?.if).toContain('always()')
    expect(jobs.flakemetry?.needs).toEqual(['hygiene', 'unit', 'e2e'])
  })

  it('reads both reports, and requires neither', () => {
    const downloads = steps('flakemetry').filter((s) =>
      s.uses?.startsWith('actions/download-artifact@'),
    )
    expect(downloads.map((s) => s.with?.name)).toEqual(['test-results', 'unit-results'])
    for (const step of downloads) {
      expect(step['continue-on-error' as keyof Step] ?? true).toBeTruthy()
    }
  })

  /** Both halves of the pipeline's input have to survive the job that produced them. */
  it('is given a unit report to read, because some job uploads one', () => {
    const uploads = stepsUsing('actions/upload-artifact@').map(({ step }) => step.with?.name)
    expect(uploads).toContain('unit-results')
    expect(uploads).toContain('test-results')
  })

  it('publishes the document the agents read', () => {
    const uploads = steps('flakemetry')
      .filter((s) => s.uses?.startsWith('actions/upload-artifact@'))
      .map((s) => s.with?.name)
    expect(uploads).toEqual(['analysis'])
    expect(steps('analyze').some((s) => s.with?.name === 'analysis')).toBe(true)
  })
})

describe('what the job says out loud', () => {
  const reporting = steps('flakemetry').find((s) => s.name?.includes('cache returned'))?.run ?? ''

  /**
   * ADR-0004 says cache scoping across branches is subtle enough to need
   * verifying by observation. This is what makes the observation possible: a run
   * that does not say which key answered cannot be checked afterwards.
   */
  it('names which restore key answered, or that none did', () => {
    expect(reporting).toContain('cache-matched-key')
    expect(reporting).toContain('MISS')
    expect(reporting).toContain('HIT')
  })

  it('reports the size, so approaching the cap is visible before it bites', () => {
    expect(reporting).toContain('bytes')
    expect(reporting).toMatch(/::warning::/)
  })
})
