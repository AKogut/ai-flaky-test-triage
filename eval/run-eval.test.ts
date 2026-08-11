import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { format } from 'prettier'
import { describe, expect, it } from 'vitest'
import {
  buildReport,
  datasetRevision,
  DEFAULTS,
  evaluate,
  parseArgs,
  renderReport,
  unsupported,
  UsageError,
  type EvaluatedFixture,
  type Options,
} from './run-eval.js'

describe('parseArgs', () => {
  it('defaults to the classifier that needs no network', () => {
    // The evaluation gate runs on fork pull requests, which have no API key.
    // A default that reached for a model would fail there by design.
    expect(parseArgs([])).toEqual(DEFAULTS)
    expect(DEFAULTS.classifier).toBe('baseline')
  })

  it.each([
    [['--classifier=agent'], { classifier: 'agent' }],
    [['--slice=holdout'], { slice: 'holdout' }],
    [['--n=5'], { samples: 5 }],
    [['--samples=5'], { samples: 5 }],
    [['--gate'], { gate: true }],
    [['--out=/tmp/x.md'], { out: '/tmp/x.md' }],
  ])('parses %j', (argv, expected) => {
    expect(parseArgs(argv)).toMatchObject(expected)
  })

  it('accepts several flags at once', () => {
    expect(parseArgs(['--classifier=agent', '--slice=dev', '--n=3'])).toMatchObject({
      classifier: 'agent',
      slice: 'dev',
      samples: 3,
    })
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    // A silently dropped --slice=holdout would report the whole dataset under a
    // heading claiming otherwise. That is the single failure this file exists to
    // prevent, so an unrecognised flag has to be loud.
    expect(() => parseArgs(['--sclice=dev'])).toThrow(UsageError)
    expect(() => parseArgs(['--sclice=dev'])).toThrow(/unknown flag/)
  })

  it('rejects a bare argument', () => {
    expect(() => parseArgs(['dev'])).toThrow(/unexpected argument/)
  })

  it.each([
    ['--classifier=heuristic', /must be one of baseline \| agent/],
    ['--slice=everything', /must be one of dev \| holdout \| all/],
    ['--classifier', /must be one of/],
  ])('rejects %s', (arg, message) => {
    expect(() => parseArgs([arg])).toThrow(message)
  })

  it.each(['--n=0', '--n=-1', '--n=2.5', '--n=lots', '--n='])('rejects %s', (arg) => {
    expect(() => parseArgs([arg])).toThrow(/whole number/)
  })

  it('rejects an empty --out rather than writing to nowhere', () => {
    expect(() => parseArgs(['--out='])).toThrow(/needs a path/)
  })

  it('names the offending value in the message', () => {
    // An error that does not quote what it received sends the reader back to the
    // shell to work out what their quoting did.
    expect(() => parseArgs(['--slice=Dev'])).toThrow(/got "Dev"/)
  })
})

describe('capabilities that do not exist yet', () => {
  const options = (over: Partial<Options>): Options => ({ ...DEFAULTS, ...over })

  it('accepts the baseline over the whole dataset', () => {
    expect(unsupported(DEFAULTS)).toBeNull()
  })

  it.each([
    ['the agent classifier', { classifier: 'agent' as const }, '35'],
    ['the dev slice', { slice: 'dev' as const }, '28'],
    ['the holdout slice', { slice: 'holdout' as const }, '28'],
  ])('refuses %s and names the issue that lands it', (_case, over, issue) => {
    const message = unsupported(options(over))
    expect(message).toContain('not implemented yet')
    expect(message).toContain(`issues/${issue}`)
    expect(message).toContain('What works today')
  })

  it('reports the classifier before the slice, since it is the bigger gap', () => {
    expect(unsupported(options({ classifier: 'agent', slice: 'dev' }))).toContain(
      'The agent classifier',
    )
  })
})

describe('datasetRevision', () => {
  const fixture = (over: Partial<EvaluatedFixture> = {}): EvaluatedFixture => ({
    judgement: {
      name: 'a',
      predicted: { owner: 'app_code', determinism: 'intermittent' },
      actual: { owner: 'app_code', determinism: 'intermittent' },
    },
    labels: {
      name: 'a',
      owner: 'app_code',
      determinism: 'intermittent',
      justification: 'x'.repeat(200),
      ruleApplied: 'rule-4-default-app-code',
      provenance: 'synthetic',
      bucket: 'hard-quadrant',
      lowConfidenceGroundTruth: false,
    },
    payloadHash: 'aaaa',
    confidence: 0.5,
    reasoning: 'because',
    ...over,
  })

  it('is stable across runs', () => {
    expect(datasetRevision([fixture()])).toBe(datasetRevision([fixture()]))
  })

  it('moves when a payload changes', () => {
    expect(datasetRevision([fixture({ payloadHash: 'bbbb' })])).not.toBe(
      datasetRevision([fixture()]),
    )
  })

  it('moves when ground truth changes', () => {
    // A payload hash alone would miss this, and a relabelled fixture moves every
    // number in the report while looking like the same dataset.
    const relabelled = fixture()
    expect(
      datasetRevision([{ ...relabelled, labels: { ...relabelled.labels, owner: 'test_code' } }]),
    ).not.toBe(datasetRevision([relabelled]))
  })

  it('ignores a justification edit, which changes no number', () => {
    const original = fixture()
    expect(
      datasetRevision([
        { ...original, labels: { ...original.labels, justification: 'y'.repeat(200) } },
      ]),
    ).toBe(datasetRevision([original]))
  })

  it('moves when a fixture is added', () => {
    expect(datasetRevision([fixture(), fixture()])).not.toBe(datasetRevision([fixture()]))
  })
})

// ---------------------------------------------------------------------------

describe('evaluating the committed dataset', () => {
  const evaluation = evaluate(DEFAULTS)

  it('runs end to end with no model and no network', () => {
    expect(evaluation.fixtures).toHaveLength(33)
    expect(evaluation.metrics.n).toBe(33)
  })

  it('orders fixtures by name, so a regenerated report diffs cleanly', () => {
    const names = evaluation.fixtures.map((f) => f.judgement.name)
    expect(names).toEqual([...names].sort())
  })

  it('produces the same revision hash on a second run', () => {
    expect(evaluate(DEFAULTS).datasetRevision).toBe(evaluation.datasetRevision)
  })

  it('scores the headline over fixtures with confident ground truth only', () => {
    const arguable = evaluation.fixtures.filter((f) => f.labels.lowConfidenceGroundTruth)
    expect(evaluation.metrics.n).toBe(evaluation.fixtures.length - arguable.length)
  })
})

describe('the rendered report', () => {
  const evaluation = evaluate(DEFAULTS)
  const report = renderReport(evaluation)

  it('leads with joint accuracy', () => {
    expect(report.indexOf('**joint accuracy**')).toBeLessThan(report.indexOf('`owner` accuracy'))
  })

  it('records what the numbers were computed from', () => {
    for (const field of [
      'classifier',
      'model',
      'prompt version',
      'dataset revision',
      'slice',
      'samples per fixture',
    ]) {
      expect(report).toContain(field)
    }
    expect(report).toContain(evaluation.datasetRevision)
  })

  it('says the baseline uses no model rather than leaving the field blank', () => {
    // "unknown" and "none" mean different things, and a reader auditing a number
    // needs to know which one applies.
    expect(report).toContain('none — a heuristic, no model call')
  })

  it('keeps the agent column visible while it is empty', () => {
    // The project reports a delta over the baseline. Dropping the column would
    // let the absolute number read as the result.
    expect(report).toContain('| metric')
    expect(report).toContain('agent')
    expect(report).toContain('issues/35')
  })

  it('carries every section the methodology promises', () => {
    for (const heading of [
      '## Provenance',
      '## Headline',
      '## Per quadrant',
      '## Confusion matrices',
      '## Per class',
      '## Breakdowns',
      '## Every fixture',
      '## How to read this',
    ]) {
      expect(report).toContain(heading)
    }
  })

  it('names the axis on every per-class row', () => {
    // The five class values are distinct today by coincidence, not by design.
    expect(report).toMatch(/\| `owner` +\| `app_code`/)
    expect(report).toMatch(/\| `determinism` +\| `deterministic`/)
  })

  it('puts every fixture in a collapsed section', () => {
    expect(report).toContain('<details>')
    for (const fixture of evaluation.fixtures) {
      expect(report).toContain(`\`${fixture.judgement.name}\``)
    }
  })

  it('distinguishes half-right from wrong in the per-fixture table', () => {
    // One axis right is not a usable answer, but it is not the same failure as
    // getting both wrong, and the debugging section is where that matters.
    expect(report).toContain('½')
    expect(report).toContain('one axis right and one wrong')
  })

  it('carries no timestamp, so an unchanged run produces no diff', () => {
    // A clock reading in the body would make every regeneration a diff even when
    // nothing measured moved — the noise that trains people to skim the diff.
    expect(report).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(report).toContain('no generation timestamp')
  })

  it('is byte-identical across runs', () => {
    expect(renderReport(evaluate(DEFAULTS))).toBe(report)
  })

  it('tells a reader the interval is not a generalisation claim', () => {
    expect(report).toContain('stratified by design')
  })
})

describe('the committed report', () => {
  it('is actually tracked by git', () => {
    // It was not. `.gitignore` carried an unanchored `report.md`, meant for the
    // pipeline output at the repository root, which also matched this file at
    // any depth. Nothing failed — the deliverable simply was not there, every
    // document describing it as committed was wrong, and `--gate` would have
    // failed on a fresh checkout looking for a file git had been told to hide.
    const tracked = execSync('git ls-files eval/report.md', { encoding: 'utf8' }).trim()
    expect(tracked).toBe('eval/report.md')
  })

  it('matches what a run produces right now', async () => {
    // This is what `--gate` checks in CI. Having it as a unit test too means the
    // failure arrives locally, before the push, with the same message.
    const committed = readFileSync('eval/report.md', 'utf8')
    expect(await buildReport(evaluate(DEFAULTS))).toBe(committed)
  })

  it('is formatted the way Prettier formats it', async () => {
    // The file is committed into a tree `npm run format:check` reads, so a
    // report Prettier would rewrite breaks CI on every regeneration.
    const committed = readFileSync('eval/report.md', 'utf8')
    expect(await format(committed, { parser: 'markdown' })).toBe(committed)
  })
})
