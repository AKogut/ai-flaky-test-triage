import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CassetteMissError,
  TransportError,
  type ModelRequest,
  type ModelResponse,
  type Transport,
} from '@sentra/agents'
import { format } from 'prettier'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ABLATION_DEFAULTS,
  ABLATION_PATH,
  ablate,
  buildAblation,
  compareRuns,
  joinNames,
  main,
  NO_CASSETTES,
  overlaps,
  parseArgs,
  regenerateCommand,
  renderAblation,
  signedPoints,
} from './ablation.js'
import { DEFAULTS, evaluate } from './run-eval.js'
import { sliceOf } from './slices.js'
import { OTHER_VARIANTS, VARIANTS } from './variants.js'

/**
 * The ablation harness, with the baseline control run for real and the agent
 * driven three ways: with no cassettes, through a stub transport, and through
 * one that misses on some variants only.
 *
 * Nothing here reaches a network. The agent's environment is pinned to replay
 * in every test that does not inject a transport, so a developer with a key in
 * their shell cannot turn the suite into a bill.
 */

const REPLAY = { SENTRA_REPLAY: '1' }

const baselineOptions = parseArgs(['--classifier=baseline'])
const baseline = await ablate(baselineOptions)
const headline = await evaluate(DEFAULTS)

const REPLY = {
  owner: 'app_code',
  determinism: 'intermittent',
  confidence: 0.5,
  reasoning: 'a reason',
  evidence: ['some quoted line'],
}

/** Answers every request the same way, and records what it was asked. */
function stub(
  miss: (request: ModelRequest) => boolean = () => false,
): Transport & { sent: ModelRequest[] } {
  const sent: ModelRequest[] = []
  const check = (request: ModelRequest): void => {
    if (miss(request)) throw new CassetteMissError('0000', 'triage.v1.0000.json', 'triage.v1')
  }
  return {
    sent,
    countInputTokens: (request) => {
      check(request)
      return Promise.resolve(50)
    },
    send: (request): Promise<ModelResponse> => {
      check(request)
      sent.push(request)
      return Promise.resolve({
        raw: REPLY,
        stopReason: 'end_turn',
        model: 'claude-opus-5-5',
        usage: { inputTokens: 50, outputTokens: 20 },
      })
    },
  }
}

const withheldLine = (request: ModelRequest): boolean =>
  request.prompt.includes('Withheld from this run on purpose (ablation)')

const scratch = (): string => mkdtempSync(join(tmpdir(), 'sentra-ablation-'))

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults to the agent, which is whose ablation the methodology describes', () => {
    expect(parseArgs([])).toEqual(ABLATION_DEFAULTS)
    expect(ABLATION_DEFAULTS).toMatchObject({ classifier: 'agent', samples: 5, check: false })
    expect(ABLATION_DEFAULTS.out).toBe(ABLATION_PATH)
  })

  it('samples the baseline once, since it is a pure function', () => {
    expect(parseArgs(['--classifier=baseline']).samples).toBe(1)
  })

  it.each([
    [['--n=3'], { samples: 3 }],
    [['--samples=2', '--classifier=baseline'], { samples: 2, classifier: 'baseline' }],
    [['--check'], { check: true }],
    [['--out=/tmp/x.md'], { out: '/tmp/x.md' }],
  ])('parses %j', (argv, expected) => {
    expect(parseArgs(argv)).toMatchObject(expected)
  })

  it.each(['--slice=holdout', '--slice=all', '--slice=dev'])(
    'refuses %s and says why, rather than accepting a slice it will not use',
    (arg) => {
      expect(() => parseArgs([arg])).toThrow(/development slice only/)
    },
  )

  it.each([
    ['--classifer=agent', /unknown flag/],
    ['agent', /unexpected argument/],
    ['--classifier=model', /must be one of baseline \| agent, got "model"/],
    ['--classifier', /must be one of/],
    ['--n=0', /whole number/],
    ['--n=1.5', /whole number/],
    ['--out=', /needs a path/],
  ])('rejects %s', (arg, message) => {
    expect(() => parseArgs([arg])).toThrow(message)
  })
})

describe('regenerateCommand', () => {
  it.each([
    [[], 'npm run eval:ablation'],
    [['--classifier=baseline'], 'npm run eval:ablation -- --classifier=baseline'],
    [['--n=2'], 'npm run eval:ablation -- --n=2'],
    [['--classifier=baseline', '--n=3'], 'npm run eval:ablation -- --classifier=baseline --n=3'],
  ])('%j regenerates with "%s"', (argv, expected) => {
    expect(regenerateCommand(parseArgs(argv))).toBe(expected)
  })
})

describe('small formatters', () => {
  it.each([
    [0.1923, '+19.2pp'],
    [-0.1923, '-19.2pp'],
    [0, '0.0pp'],
    [0.0001, '0.0pp'],
  ])('signedPoints(%d) is %s', (delta, expected) => {
    expect(signedPoints(delta)).toBe(expected)
  })

  it.each([
    [[], ''],
    [['a'], 'a'],
    [['a', 'b'], 'a and b'],
    [['a', 'b', 'c'], 'a, b and c'],
  ])('joinNames(%j) is "%s"', (names, expected) => {
    expect(joinNames(names)).toBe(expected)
  })

  it('treats touching intervals as overlapping', () => {
    expect(overlaps({ lower: 0.1, upper: 0.3 }, { lower: 0.3, upper: 0.5 })).toBe(true)
    expect(overlaps({ lower: 0.1, upper: 0.2 }, { lower: 0.3, upper: 0.5 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('the baseline control', { timeout: 60_000 }, () => {
  const [study] = baseline.studies
  const runs = study?.runs ?? []
  const run = (name: string) => runs.find((r) => r.variant.name === name)

  it('is the only study, with one scored run per variant', () => {
    expect(baseline.studies).toHaveLength(1)
    expect(study?.classifier).toBe('baseline')
    expect(runs.map((r) => r.variant.name)).toEqual(VARIANTS.map((v) => v.name))
    expect(runs.every((r) => r.evaluation !== null && r.notRun === null)).toBe(true)
    expect(baseline.mode).toBeNull()
  })

  it('scores the full context exactly as eval/report.md scores its headline', () => {
    // The reference row is the published number, not a second measurement of
    // something that ought to agree with it.
    const reference = runs[0]?.evaluation
    expect(reference?.metrics).toEqual(headline.metrics)
    expect(reference?.datasetRevision).toBe(headline.datasetRevision)
  })

  it('never scores a held-out fixture', () => {
    for (const r of runs) {
      expect(r.evaluation?.fixtures.length).toBe(headline.fixtures.length)
      for (const fixture of r.evaluation?.fixtures ?? []) {
        expect(sliceOf(fixture.judgement.name), fixture.judgement.name).toBe('dev')
      }
    }
  })

  it('moves nothing when it withholds an input the baseline never reads', () => {
    const reference = runs[0]?.evaluation
    for (const name of ['No test source', 'No run context']) {
      const after = run(name)?.evaluation
      if (reference == null || after == null) throw new Error(`${name} did not run`)
      expect(compareRuns(reference, after).changed, name).toBe(0)
    }
  })

  it('has nothing left to call a fixture deterministic with once history is gone', () => {
    // The rule needs a failure streak of two, and a cache miss is a streak of
    // at most one. Every changed prediction is therefore on `determinism`.
    for (const name of ['No history', 'Error message only']) {
      const fixtures = run(name)?.evaluation?.fixtures ?? []
      expect(fixtures.length).toBeGreaterThan(0)
      expect(fixtures.every((f) => f.judgement.predicted.determinism === 'intermittent')).toBe(true)
    }
    const reference = runs[0]?.evaluation
    const noHistory = run('No history')?.evaluation
    if (reference == null || noHistory == null) throw new Error('No history did not run')
    expect(compareRuns(reference, noHistory).owner).toBe(0)
  })

  it('counts the fixtures that carry what each variant withholds', () => {
    expect(run('Full context')?.carriedBy).toBe(0)
    expect(run('No history')?.carriedBy).toBe(headline.metrics.n)
    expect(run('No diff')?.carriedBy).toBeGreaterThan(0)
    // Every result has an outcome, so the trivial-input variant always takes something.
    expect(run('Error message only')?.carriedBy).toBe(headline.metrics.n)
  })

  it('compares a run with itself as unchanged', () => {
    const reference = runs[0]?.evaluation
    if (reference == null) throw new Error('the reference did not run')
    expect(compareRuns(reference, reference)).toEqual({
      changed: 0,
      owner: 0,
      determinism: 0,
      gained: 0,
      lost: 0,
    })
  })
})

describe('the rendered baseline report', { timeout: 60_000 }, () => {
  const report = renderAblation(baseline)

  it('says it is generated and must not be edited', () => {
    expect(report).toContain(
      '> Generated by `npm run eval:ablation -- --classifier=baseline`. Do not edit by hand',
    )
  })

  it('labels the study as the control, and names what the agent is waiting on', () => {
    expect(report).toContain("## Baseline control — the agent's ablation waits on #38")
    expect(report).not.toContain('## Agent')
  })

  it('names every row of the methodology table', () => {
    for (const variant of [...VARIANTS, ...OTHER_VARIANTS]) expect(report).toContain(variant.name)
  })

  it('carries a comparison, conclusions, quadrants, buckets and cost', () => {
    for (const heading of [
      '### Comparison',
      '### What it shows',
      '### Per quadrant',
      '### Per bucket',
      '### Cost',
      '## Variants',
      '## How to read this',
    ]) {
      expect(report).toContain(heading)
    }
    expect(report).toMatch(/\d+\.\d% \[\d+\.\d–\d+\.\d\]/)
    expect(report).toContain('none — no model call')
  })

  it('states its conclusions in terms of the interval', () => {
    expect(report).toMatch(/beyond (its|the) interval/)
    expect(report).toContain('within noise')
  })

  it('carries no timestamp, so an unchanged run produces no diff', () => {
    expect(report).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('is byte-identical across runs', async () => {
    expect(renderAblation(await ablate(baselineOptions))).toBe(report)
  })
})

// ---------------------------------------------------------------------------

describe('the agent with no cassettes', { timeout: 60_000 }, () => {
  it('reports every variant as not run, and still runs the control', async () => {
    const ablation = await ablate(parseArgs(['--n=1']), { env: REPLAY })
    const [agent, control] = ablation.studies

    expect(ablation.mode).toBe('replay')
    expect(agent?.classifier).toBe('agent')
    expect(agent?.runs.every((r) => r.evaluation === null && r.notRun === NO_CASSETTES)).toBe(true)
    expect(control?.runs.every((r) => r.evaluation !== null)).toBe(true)
  })
})

describe('the agent through a transport', { timeout: 60_000 }, () => {
  it('scores every variant and tells the model what each one withheld', async () => {
    const transport = stub()
    const ablation = await ablate(parseArgs(['--n=1']), { env: REPLAY, transport })
    const [agent] = ablation.studies
    expect(agent?.runs.every((r) => r.evaluation !== null)).toBe(true)

    const perVariant = headline.fixtures.length
    const byVariant = VARIANTS.map((_, index) =>
      transport.sent.slice(index * perVariant, (index + 1) * perVariant),
    )
    // The full context says nothing about withholding; every other variant does.
    expect(byVariant[0]?.some(withheldLine)).toBe(false)
    for (const requests of byVariant.slice(1)) expect(requests.every(withheldLine)).toBe(true)
    expect(byVariant[1]?.[0]?.prompt).toContain('flakinessSignal, statusHistory')
  })

  it('asks the full-context questions `npm run eval` asks, so the two share cassettes', async () => {
    const ablating = stub()
    await ablate(parseArgs(['--n=1']), { env: REPLAY, transport: ablating })
    const evaluating = stub()
    await evaluate(
      { ...DEFAULTS, classifier: 'agent', samples: 1 },
      {
        env: REPLAY,
        transport: evaluating,
      },
    )

    const fullContext = ablating.sent.slice(0, evaluating.sent.length)
    expect(fullContext.map((r) => r.prompt)).toEqual(evaluating.sent.map((r) => r.prompt))
  })

  it('renders the agent study first, with the baseline beside it and the cost of each row', async () => {
    const ablation = await ablate(parseArgs(['--n=1']), { env: REPLAY, transport: stub() })
    const report = renderAblation(ablation)

    expect(report).toContain('## Agent')
    expect(report).toContain('## Baseline control')
    expect(report).not.toContain('waits on #38')
    expect(report.indexOf('## Agent')).toBeLessThan(report.indexOf('## Baseline control'))
    expect(report).toContain('| Baseline heuristic')
    expect(report).toContain('**Is the LLM needed at all?**')
    expect(report).toContain('| input tokens')
    expect(report).toContain('`claude-opus-5-5`')
    expect(report).toContain('Regenerate with** `npm run eval:ablation -- --n=1`')
  })

  it('reports a variant whose cassettes are missing as not run, and scores the rest', async () => {
    const transport = stub(withheldLine)
    const ablation = await ablate(parseArgs(['--n=1']), { env: REPLAY, transport })
    const [agent] = ablation.studies

    expect(agent?.runs[0]?.evaluation).not.toBeNull()
    expect(agent?.runs.slice(1).every((r) => r.notRun === NO_CASSETTES)).toBe(true)

    const report = renderAblation(ablation)
    expect(report).toContain('not run — no cassettes, see [#38]')
    expect(report).toMatch(/Not run: No history, .* and Error message only/)
  })

  it('says nothing can be compared when the full context itself is missing', async () => {
    const transport = stub((request) => !withheldLine(request))
    const ablation = await ablate(parseArgs(['--n=1']), { env: REPLAY, transport })
    const report = renderAblation(ablation)

    expect(ablation.studies[0]?.runs[0]?.evaluation).toBeNull()
    expect(report).toContain('The full-context row did not run')
  })

  it('stops on a fault that is not a missing cassette', async () => {
    // A refused request, a corrupt cassette or a spent budget is a fault, not an
    // absence. Reporting it as "not run" would hide it.
    const failing: Transport = {
      countInputTokens: () => Promise.reject(new TransportError('client', 'boom')),
      send: () => Promise.reject(new TransportError('client', 'boom')),
    }
    await expect(ablate(parseArgs(['--n=1']), { env: REPLAY, transport: failing })).rejects.toThrow(
      /boom/,
    )
  })
})

// ---------------------------------------------------------------------------

// Each of these runs six evaluations and formats the result with Prettier.
describe('the CLI', { timeout: 60_000 }, () => {
  const quiet = (): { log: string[]; error: string[] } => {
    const captured = { log: [] as string[], error: [] as string[] }
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      captured.log.push(String(m))
    })
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
      captured.error.push(String(m))
    })
    return captured
  }

  it('writes the report where it is told, and says so', async () => {
    const out = join(scratch(), 'ablation.md')
    const captured = quiet()
    expect(await main(['--classifier=baseline', `--out=${out}`])).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(await buildAblation(baseline))
    expect(captured.log.join('\n')).toContain(`Wrote ${out}`)
  })

  it('passes --check on a report that is current, and fails it once edited', async () => {
    const out = join(scratch(), 'ablation.md')
    quiet()
    await main(['--classifier=baseline', `--out=${out}`])
    expect(await main(['--classifier=baseline', '--check', `--out=${out}`])).toBe(0)

    writeFileSync(out, `${readFileSync(out, 'utf8')}\nedited by hand\n`)
    expect(await main(['--classifier=baseline', '--check', `--out=${out}`])).toBe(1)
  })

  it('fails --check on a missing report, and names the command that fixes it', async () => {
    const captured = quiet()
    const out = join(scratch(), 'nothing-here.md')
    expect(await main(['--classifier=baseline', '--check', `--out=${out}`])).toBe(1)
    expect(captured.error.join('\n')).toContain('missing entirely')
    expect(captured.error.join('\n')).toContain('npm run eval:ablation -- --classifier=baseline')
  })

  it('passes the check CI runs against the committed report', async () => {
    quiet()
    expect(await main(['--classifier=baseline', '--check'])).toBe(0)
  })

  it('exits 1 and writes nothing when no agent variant has cassettes', async () => {
    const captured = quiet()
    const out = join(scratch(), 'ablation.md')
    expect(await main([`--out=${out}`, '--n=1'], { env: REPLAY })).toBe(1)
    expect(existsSync(out)).toBe(false)

    const message = captured.error.join('\n')
    expect(message).toContain('not run — no cassettes, see #38')
    expect(message).toContain('npm run eval:ablation -- --classifier=baseline')
    expect(message).toContain(`${out} was left as it is`)
  })

  it('writes the agent study when a variant could be scored', async () => {
    quiet()
    const out = join(scratch(), 'ablation.md')
    expect(await main([`--out=${out}`, '--n=1'], { env: REPLAY, transport: stub() })).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('## Agent')
  })

  it('warns that a live run costs money before it starts', async () => {
    const captured = quiet()
    const out = join(scratch(), 'ablation.md')
    // A key in the environment means live, but the injected transport is what
    // answers, so nothing leaves the process.
    await main([`--out=${out}`, '--n=1'], { env: { ANTHROPIC_API_KEY: 'test' }, transport: stub() })
    expect(captured.log.join('\n')).toContain('This costs money')
  })

  it('exits 1 with the message when the run cannot start', async () => {
    const captured = quiet()
    expect(await main([], { env: { SENTRA_REPLAY: '1', SENTRA_RECORD: '1' } })).toBe(1)
    expect(captured.error.join('\n')).toContain('The ablation could not finish')
  })

  it('exits 2 on a usage error', async () => {
    const captured = quiet()
    expect(await main(['--slice=holdout'])).toBe(2)
    expect(captured.error.join('\n')).toContain('development slice only')
  })

  it('leaves the main report, its metrics and every held-out file alone', async () => {
    // The ablation reads the dataset and writes one file. It must not count as a
    // held-out consultation, and must not regenerate what `npm run eval` owns.
    const guarded = [
      'eval/report.md',
      'eval/metrics.json',
      'eval/holdout-log.json',
      'eval/holdout-metrics.json',
      'eval/holdout-report.md',
    ]
    const before = guarded.map((path) => readFileSync(path, 'utf8'))
    quiet()
    await main(['--classifier=baseline', `--out=${join(scratch(), 'ablation.md')}`])
    expect(guarded.map((path) => readFileSync(path, 'utf8'))).toEqual(before)
  })
})

// ---------------------------------------------------------------------------

describe('the committed report', { timeout: 60_000 }, () => {
  it('is tracked by git', () => {
    const tracked = execSync(`git ls-files ${ABLATION_PATH}`, { encoding: 'utf8' }).trim()
    expect(tracked).toBe(ABLATION_PATH)
  })

  it('matches what a run produces right now', async () => {
    // What CI checks, run here too so the failure arrives before the push.
    expect(await buildAblation(baseline)).toBe(readFileSync(ABLATION_PATH, 'utf8'))
  })

  it('is formatted the way Prettier formats it', async () => {
    const committed = readFileSync(ABLATION_PATH, 'utf8')
    expect(await format(committed, { parser: 'markdown' })).toBe(committed)
  })
})
