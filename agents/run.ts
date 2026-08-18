import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  parseAnalysis,
  type AnalysedTest,
  type Analysis,
  type ClassificationInput,
} from '@sentra/contracts'
import { CURRENT_PROMPT, loadPrompt } from '@sentra/prompts'
import { CassetteTransport, listCassettes, resolveMode } from './cassettes.js'
import { runContextFor } from './context.js'
import { TokenBudget } from './model-client.js'
import { hasWork } from './orchestrate.js'
import { runPipeline, type PipelineDeps } from './pipeline.js'
import { renderReport } from './report.js'
import { AnthropicTransport, type Transport } from './transport.js'

/**
 * `npm run agents:analyze` — `analysis.json` in, `report.md` out.
 *
 * The one module in `agents/` that reads and writes, and it writes exactly one
 * file. That is a guardrail rather than a coincidence: `docs/limitations-and-guardrails.md`
 * promises the pipeline never modifies the working tree, and #69 asserts the
 * whole-run version of that claim.
 *
 * **It exits 0 whenever the pipeline itself worked**, whatever the classifier
 * managed. A run where every model call rate-limited still produced a correct
 * report — one that says every test went unclassified and why — and exiting
 * non-zero there would fail a build over the weather. A non-zero exit here means
 * this program is broken, and nothing else.
 *
 * **A run with nothing to triage writes nothing at all.** Not an empty report: a
 * comment saying nothing went wrong, posted on every green pull request, is
 * noise that trains people to skip the one that matters.
 */

const ANALYSIS = 'analysis.json'
const REPORT = 'report.md'

/** A generous default. The point is a ceiling, not a tight one. */
const DEFAULT_BUDGET = 200_000

export interface RunDeps {
  env?: NodeJS.ProcessEnv
  read?: (path: string) => string
  write?: (path: string, contents: string) => void
  exists?: (path: string) => boolean
  log?: (message: string) => void
  transport?: Transport
  /** Injected so a test can drive a whole run without a clock or a network. */
  cassetteCount?: () => number
}

export interface RunOptions {
  analysis: string
  out: string
  budget: number
  concurrency?: number
}

export function parseArgs(argv: string[]): RunOptions {
  let analysis = ANALYSIS
  let out = REPORT
  let budget = DEFAULT_BUDGET
  let concurrency: number | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) continue
    if (flag === '--analysis') analysis = value
    else if (flag === '--out') out = value
    else if (flag === '--budget') budget = Number(value)
    else if (flag === '--concurrency') concurrency = Number(value)
    else continue
    i += 1
  }

  return { analysis, out, budget, ...(concurrency === undefined ? {} : { concurrency }) }
}

/**
 * Whether this run can call a model at all, and what to say if not.
 *
 * Checked before any work rather than discovered one call at a time. Without
 * credentials and without cassettes every test would fail identically, and forty
 * rows saying "no cassette for triage.v1" tell a reader nothing they could not
 * have been told once, at the top.
 */
export function credentialState(
  env: NodeJS.ProcessEnv,
  cassettes: number,
): { canRun: boolean; notice?: string } {
  const mode = resolveMode(env)
  const hasKey = (env.ANTHROPIC_API_KEY ?? '') !== '' || (env.ANTHROPIC_AUTH_TOKEN ?? '') !== ''

  if (mode === 'replay') {
    return cassettes > 0
      ? { canRun: true }
      : {
          canRun: false,
          notice:
            'The classifier did not run: replay mode is in force and no cassettes are recorded. ' +
            'The failures below are listed with the pipeline’s own signals and no verdicts.',
        }
  }

  // `ant auth login` leaves no environment variable, so an absent key is not
  // proof of absent credentials — but in CI it is the only evidence there is.
  return hasKey
    ? { canRun: true }
    : {
        canRun: false,
        notice:
          'The classifier did not run: no ANTHROPIC_API_KEY is configured for this job. ' +
          'The failures below are listed with the pipeline’s own signals and no verdicts.',
      }
}

export async function main(argv: string[], deps: RunDeps = {}): Promise<number> {
  const options = parseArgs(argv)
  const env = deps.env ?? process.env
  const read = deps.read ?? ((p: string) => readFileSync(p, 'utf8'))
  const exists = deps.exists ?? ((p: string) => existsSync(p))
  const log =
    deps.log ??
    ((m: string) => {
      console.log(m)
    })
  const write =
    deps.write ??
    ((p: string, contents: string) => {
      mkdirSync(dirname(p) === '' ? '.' : dirname(p), { recursive: true })
      writeFileSync(p, contents)
    })

  if (!exists(options.analysis)) {
    console.error(`\n  ${options.analysis} does not exist. Run npm run flakemetry:analyze first.\n`)
    return 1
  }

  let analysis: Analysis
  try {
    analysis = parseAnalysis(JSON.parse(read(options.analysis)), options.analysis)
  } catch (error) {
    console.error(`\n  ${(error as Error).message}\n`)
    return 1
  }

  if (!hasWork(analysis)) {
    log('  nothing to triage — no report written')
    return 0
  }

  const countCassettes = deps.cassetteCount ?? ((): number => listCassettes().length)
  const credentials = credentialState(env, countCassettes())

  const notices: string[] = []
  if (analysis.historySource === 'unreadable') {
    notices.push('The run history could not be read, so every test reads as new.')
  } else if (!analysis.historyAvailable) {
    notices.push('The run had no history, so every test reads as new.')
  }
  if (credentials.notice !== undefined) notices.push(credentials.notice)

  const triagePrompt = loadPrompt(CURRENT_PROMPT.triage)

  return await renderAndWrite()

  async function renderAndWrite(): Promise<number> {
    // Without credentials there is nothing to await, and a report is still owed.
    if (!credentials.canRun) {
      write(
        options.out,
        renderReport({
          triaged: analysis.tests
            .filter((t) => hasWork({ ...analysis, tests: [t] }))
            .map((test) => ({
              test,
              unclassified: {
                // Its own reason, not `error`. No call was made, and a header
                // that says "the classifier call failed" about a call that never
                // happened sends a reader looking for an outage.
                reason: 'not-run' as const,
                detail: 'no classifier was available for this run',
              },
            })),
          commitSha: analysis.commitSha,
          branch: analysis.branch,
          runId: analysis.runId,
          model: 'none — the classifier did not run',
          promptVersions: { triage: triagePrompt.version },
          usage: [],
          notices,
        }),
      )
      log(`  wrote ${options.out} (degraded: ${String(notices.length)} notice(s))`)
      return 0
    }

    // Awaited, not fired and forgotten. A report written after the process has
    // decided to exit is a report nobody gets — and the exit code would say the
    // run succeeded either way, which is the worst of both.
    await dispatch()
    return 0
  }

  async function dispatch(): Promise<void> {
    const inner = deps.transport ?? new AnthropicTransport({ allowModelFallback: true })
    const transport =
      deps.transport === undefined
        ? new CassetteTransport(inner, { mode: resolveMode(env) })
        : inner

    const pipelineDeps: PipelineDeps = {
      triage: {
        transport,
        system: triagePrompt.system,
        promptVersion: triagePrompt.version,
      },
      // Root cause and fix suggestion stay off until a calibration exists — see
      // shouldInvestigate. A threshold nobody measured is a guess with a decimal.
      threshold: null,
      budget: new TokenBudget(options.budget),
      inputFor: (test): ClassificationInput => inputFor(test),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    }

    const result = await runPipeline(analysis, pipelineDeps)

    write(
      options.out,
      renderReport({
        triaged: result.triaged,
        commitSha: analysis.commitSha,
        branch: analysis.branch,
        runId: analysis.runId,
        model: result.telemetry[0]?.model ?? 'unknown',
        promptVersions: { triage: triagePrompt.version },
        usage: result.telemetry.map((t) => ({
          model: t.model,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
        })),
        notices,
      }),
    )
    log(
      `  wrote ${options.out} (${String(result.triaged.length)} tests, degraded: ${String(result.degraded)})`,
    )
  }

  function inputFor(test: AnalysedTest): ClassificationInput {
    const source = join(process.cwd(), test.result.file)
    const runContext = runContextFor(analysis.tests, test.result.testId)
    return {
      subject: test,
      historyAvailable: analysis.historyAvailable,
      ...(runContext === null ? {} : { runContext }),
      ...(exists(source) ? { testSource: read(source) } : {}),
    }
  }
}

if (process.argv[1]?.endsWith('run.ts') === true) {
  process.exitCode = await main(process.argv.slice(2))
}
