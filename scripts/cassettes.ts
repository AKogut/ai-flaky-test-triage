import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRequest,
  compare,
  isStale,
  listCassettes,
  MODEL_CONFIG,
  render,
  triageOptions,
  type Cassette,
  type Expectation,
} from '@sentra/agents'
import { parseAnalysis, selectForTriage, type ClassificationInput } from '@sentra/contracts'
import { DEFAULT_SAMPLES, listFixtures, loadPayload } from '@sentra/eval'
import { CURRENT_PROMPT, loadPrompt } from '@sentra/prompts'

/**
 * `npm run cassettes:check` — are the committed recordings still current?
 *
 * Offline and free. It asks the triage agent to assemble the requests it would
 * send for every fixture the eval scores and every failure the demo classifies,
 * hashes them, and compares against the files on disk. No model is called.
 *
 * Quiet until there is something to protect. Before the first recorded
 * evaluation there are no cassettes, and a check that failed on that would be a
 * check nobody could make pass — so an empty directory is reported as empty and
 * the exit code is zero.
 */

export const DEMO_DIR = 'demo'

interface CheckDeps {
  read?: (path: string) => string
  cassettes?: () => Cassette[]
  log?: (message: string) => void
}

/**
 * Every request a committed run would make.
 *
 * The union of the eval harness and the demo, because both are expected to work
 * offline and each asks for something the other does not. The eval's sample
 * count comes from the same constant the harness defaults to — a check that
 * expected one sample while the harness asks for five would report four
 * imaginary gaps on every run.
 */
export function expectations(read: (path: string) => string): Expectation[] {
  const version = CURRENT_PROMPT.triage
  const prompt = loadPrompt(version)
  const of = (input: ClassificationInput, sample: number, source: string): Expectation => ({
    source,
    request: buildRequest(
      triageOptions(input, { system: prompt.system, promptVersion: prompt.version, sample })
        .options,
    ),
  })

  const wanted: Expectation[] = []

  for (const name of listFixtures()) {
    const { payload } = loadPayload(name)
    for (let sample = 0; sample < DEFAULT_SAMPLES.agent; sample++) {
      wanted.push(of(payload, sample, `eval ${name} #${String(sample)}`))
    }
  }

  const analysis = parseAnalysis(
    JSON.parse(read(join(DEMO_DIR, 'analysis.json'))),
    join(DEMO_DIR, 'analysis.json'),
  )
  const diff = read(join(DEMO_DIR, 'diff.patch'))
  for (const subject of selectForTriage(analysis)) {
    wanted.push(
      of(
        {
          subject,
          diff,
          historyAvailable: analysis.historyAvailable,
          ...testSource(read, subject.result.file),
        },
        0,
        `demo ${subject.result.testId}`,
      ),
    )
  }

  return wanted
}

/** Mirrors what the demo does, including giving up quietly when a source is absent. */
function testSource(read: (path: string) => string, file: string): { testSource?: string } {
  try {
    return { testSource: read(join(DEMO_DIR, 'sources', file)) }
  } catch {
    return {}
  }
}

export function main(deps: CheckDeps = {}): number {
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'))
  const log = deps.log ?? console.log

  const onDisk = (deps.cassettes ?? (() => listCassettes()))()

  // Nothing recorded is the state before #38, not a failure. Expecting requests
  // against an empty directory would report every one of them missing and fail a
  // check nobody can make pass without spending money.
  if (onDisk.length === 0) {
    log('\n  No cassettes are committed yet, so there is nothing to go stale.\n')
    return 0
  }

  const report = compare(expectations(read), onDisk, {
    promptVersion: CURRENT_PROMPT.triage,
    model: MODEL_CONFIG.model,
  })

  const text = render(report)
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n')

  if (isStale(report)) {
    console.error(`\n${text}\n`)
    return 1
  }
  log(`\n${text}\n`)
  return 0
}

if (process.argv[1]?.endsWith('cassettes.ts') === true) {
  process.exitCode = main()
}
