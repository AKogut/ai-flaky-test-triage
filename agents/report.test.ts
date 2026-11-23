import type { ClassificationInput, FixSuggestion, RootCause } from '@sentra/contracts'
import { describe, expect, it } from 'vitest'
import { classifyWithBaseline } from './baseline.js'
import type { TriagedTest } from './pipeline.js'
import {
  COMMENT_LIMIT,
  DEGRADATIONS,
  TRUNCATION_NOTICE,
  escapeAgentText,
  fit,
  quadrantCounts,
  renderReport,
  type ReportInput,
} from './report.js'

/**
 * The one document this pipeline writes, and the only thing most people read.
 *
 * Most of what is asserted here is about not being trusted more than the system
 * has earned: the accuracy line survives truncation, model text cannot forge
 * structure, and an unmeasured classifier says so rather than staying quiet.
 */

type RowOverride = { [K in keyof TriagedTest]?: TriagedTest[K] | undefined }

const row = (over: RowOverride = {}): TriagedTest =>
  ({
    test: {
      result: {
        testId: 'tests/e2e/board.spec.ts›board › reorders',
        title: 'board › reorders two rows',
        file: 'tests/e2e/board.spec.ts',
        status: 'failed',
        attempts: 1,
        flakyWithinRun: false,
        durationMs: 12,
        annotations: [],
      },
      signal: {
        testId: 'tests/e2e/board.spec.ts›board › reorders',
        flakinessScore: 0.5,
        consecutiveFailures: 1,
        totalRuns: 20,
        firstSeenAt: '2026-08-01T00:00:00.000Z',
        lastPassedAt: null,
        statusHistory: 'PF',
        isNew: false,
      },
    },
    classification: {
      owner: 'app_code',
      determinism: 'intermittent',
      confidence: 0.82,
      reasoning: 'the diff changes the reducer the failing assertion reads',
      evidence: ['expected 3 to equal 4'],
    },
    ...over,
  }) as TriagedTest

/** A row with its own title, so two findings in one report can be told apart. */
const named = (title: string, over: RowOverride = {}): TriagedTest => {
  const base = row(over)
  const testId = `${base.test.result.file}›${title}`
  return {
    ...base,
    test: {
      result: { ...base.test.result, testId, title },
      signal: { ...base.test.signal, testId },
    },
  }
}

const cause: RootCause = {
  hypothesis: 'the reorder handler applies whichever response arrives last',
  implicatedFiles: ['app/server/routes/tasks.ts'],
  implicatedSymbols: ['reorder'],
  mechanism: 'race',
  confidence: 0.8,
}

const fix: FixSuggestion = {
  summary: 'apply moves in the order they were made',
  approach: 'carry a sequence number with each move and ignore a response older than the last one',
  risks: ['a response that is ignored can hide a real server error'],
}

const agentAccuracy = {
  joint: 0.62,
  n: 26,
  slice: 'dev',
  classifier: 'agent',
  promptVersion: 'triage.v1',
} as const

/** Every heading and every collapsed block a test's section can open with. */
const sections = (report: string): string[] =>
  report.split('\n').filter((line) => line.startsWith('### ') || line === '<details>')

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  triaged: [row()],
  commitSha: 'abc1234def',
  branch: 'main',
  runId: '42',
  model: 'claude-opus-5',
  promptVersions: { triage: 'triage.v1' },
  usage: [{ model: 'claude-opus-5', inputTokens: 1000, outputTokens: 200 }],
  ...over,
})

describe('escaping what a model produced', () => {
  /**
   * The agents are fed strings a contributor controls — titles, errors, diffs —
   * and a model that repeats one back carries the markdown with it. Unescaped, a
   * hypothesis containing `##` opens a section the pipeline did not write.
   */
  it('neutralises a heading that would forge a section', () => {
    expect(escapeAgentText('## Injected heading')).toBe('\\## Injected heading')
  })

  it('neutralises HTML, so a forged </details> cannot move everything after it', () => {
    expect(escapeAgentText('</details><script>')).toContain('&lt;/details&gt;')
    expect(escapeAgentText('</details>')).not.toContain('</details>')
  })

  it('neutralises a pipe, so a reason cannot split a table row', () => {
    expect(escapeAgentText('a | b')).not.toContain(' | ')
  })

  it('neutralises a backtick, so a fence cannot end the block it is inside', () => {
    expect(escapeAgentText('```js')).not.toContain('```')
  })

  it('leaves ordinary prose alone', () => {
    const prose = 'The reconciliation applies whichever response arrives last.'
    expect(escapeAgentText(prose)).toBe(prose)
  })

  it('escapes the injected text in the rendered report, not only in isolation', () => {
    const report = renderReport(
      input({
        triaged: [
          row({
            classification: {
              owner: 'app_code',
              determinism: 'intermittent',
              confidence: 0.9,
              reasoning: '</details>\n## Everything below is mine\n| forged | row |',
              evidence: ['x'],
            },
          }),
        ],
      }),
    )
    expect(report).not.toContain('</details>\n')
    expect(report).toContain('\\## Everything below is mine')
  })

  /**
   * The row flattens text onto one line, where a `##` cannot open anything. A
   * section keeps the line breaks, which is where a forged heading would land.
   */
  it('escapes it inside a section too, where the line breaks survive', () => {
    const forged = '</details>\n## Everything below is mine'
    const report = renderReport(
      input({
        triaged: [
          row({
            classification: {
              owner: 'test_code',
              determinism: 'intermittent',
              confidence: 0.9,
              reasoning: forged,
              evidence: ['x'],
            },
            rootCause: { ...cause, hypothesis: forged },
          }),
        ],
      }),
    )
    expect(sections(report)).toEqual(['<details>'])
    expect(report.split('</details>')).toHaveLength(2)
    expect(report.split('\n').filter((line) => line.startsWith('## '))).toEqual([
      '## Flaky-test triage',
    ])
  })
})

describe('the document', () => {
  /**
   * Written here, and only here. The workflow's upsert step used to prepend its
   * own copy, which put the marker in the comment twice — visible in the first
   * report this pipeline ever posted publicly.
   */
  it('opens with the marker the comment upsert looks for, exactly once', () => {
    const report = renderReport(input())
    expect(report).toMatch(/^<!-- sentra:report -->/)
    expect(report.split('<!-- sentra:report -->')).toHaveLength(2)
  })

  it('counts the quadrants it found', () => {
    expect(quadrantCounts([row()])['app_code+intermittent']).toBe(1)
    expect(renderReport(input())).toContain('**app_code+intermittent** 1')
  })

  it('has a row per test in the table', () => {
    const report = renderReport(input({ triaged: [row(), row()] }))
    expect(report.split('| tests/e2e/board.spec.ts').length - 1).toBeGreaterThanOrEqual(2)
  })

  /** What a reader must act on is open; what they may want is behind a summary. */
  it('expands application findings and collapses the rest', () => {
    const other = row({
      classification: {
        owner: 'test_code',
        determinism: 'deterministic',
        confidence: 0.9,
        reasoning: 'the locator matches two rows',
        evidence: ['x'],
      },
      rootCause: cause,
    })
    const report = renderReport(input({ triaged: [row({ rootCause: cause }), other] }))
    expect(report).toContain('<details>')
    expect(report.indexOf('### board › reorders two rows')).toBeLessThan(
      report.indexOf('<details>'),
    )
  })

  /**
   * A missing row reads as "nothing was wrong with this test", which is the
   * opposite of the truth.
   */
  it('lists an unclassified test with its reason rather than dropping it', () => {
    const report = renderReport(
      input({
        triaged: [
          row({
            classification: undefined,
            unclassified: { reason: 'error', detail: '429 rate limited' },
          }),
        ],
      }),
    )
    expect(report).toContain('unclassified')
    expect(report).toContain('429 rate limited')
    expect(report).toContain('the classifier call failed')
  })

  it('carries the degradation notices the run already knew about', () => {
    expect(renderReport(input({ notices: ['history was unreadable'] }))).toContain(
      'history was unreadable',
    )
  })
})

describe('what earns a test a section', () => {
  /**
   * A section restates the row before it adds anything. When it adds nothing,
   * the finding is said twice — which is what every comment did while root
   * cause and fix suggestion were off.
   */
  it('leaves a finding with nothing more to say in the table only', () => {
    const report = renderReport(input())
    expect(report).toContain('| the diff changes the reducer the failing assertion reads |')
    expect(sections(report)).toEqual([])
  })

  /**
   * The baseline is what runs on a pull request without a key. Every owner rule,
   * with and without a failure streak, with and without history: its longest
   * sentences ran past the row's old width, and a section that only finishes
   * one is the repetition this exists to remove.
   */
  it('writes no section for any verdict the baseline heuristic can reach', () => {
    const productDiff = 'diff --git a/app/server/routes/tasks.ts b/app/server/routes/tasks.ts\n'
    const probe = (message: string, diff: string, streak: number, history: boolean) => {
      const subject = row().test
      const payload: ClassificationInput = {
        subject: {
          result: { ...subject.result, error: { message } },
          signal: { ...subject.signal, consecutiveFailures: streak },
        },
        ...(diff === '' ? {} : { diff }),
        historyAvailable: history,
      }
      return classifyWithBaseline(payload)
    }
    const verdicts = [
      ['Error: listen EADDRINUSE: address already in use :::3001', ''],
      ['expected 3 to equal 4', productDiff],
      ["locator('li') resolved to 2 elements", ''],
      ['expected 3 to equal 4', ''],
    ].flatMap(([message = '', diff = '']) =>
      [0, 3].flatMap((streak) => [true, false].map((h) => probe(message, diff, streak, h))),
    )
    expect(new Set(verdicts.map((v) => v.owner))).toEqual(
      new Set(['environment', 'app_code', 'test_code']),
    )
    expect(Math.max(...verdicts.map((v) => v.reasoning.length))).toBeGreaterThan(100)

    const report = renderReport(
      input({
        triaged: verdicts.map((classification, i) =>
          named(`baseline case ${String(i)}`, { classification }),
        ),
      }),
    )
    expect(sections(report)).toEqual([])
    for (const verdict of verdicts) expect(report).toContain(`| ${verdict.reasoning} |`)
  })

  it('writes a section for the one test with a root cause, and only that one', () => {
    const report = renderReport(
      input({
        triaged: [
          named('a finding with nothing more'),
          named('a finding with a hypothesis', { rootCause: cause }),
          named('another finding with nothing more'),
        ],
      }),
    )
    expect(sections(report)).toEqual(['### a finding with a hypothesis'])
    expect(report).toContain('**Hypothesis** (race, confidence 0.80)')
  })

  it.each<[string, RowOverride, string]>([
    ['a fix suggestion', { fixSuggestion: fix }, '**Suggested fix:** apply moves in the order'],
    [
      'a reason the row had to cut',
      {
        classification: {
          owner: 'app_code',
          determinism: 'intermittent',
          confidence: 0.82,
          reasoning: `${'the reducer reads the list before the move lands. '.repeat(4)}So it loses one.`,
          evidence: ['x'],
        },
      },
      'So it loses one.',
    ],
  ])('writes a section for %s, carrying what the row cannot', (_name, over, extra) => {
    const report = renderReport(input({ triaged: [row(over)] }))
    const [table, section] = report.split('\n### ')
    expect(sections(report)).toEqual(['### board › reorders two rows'])
    expect(table).not.toContain(extra)
    expect(section).toContain(extra)
  })

  /** Open or collapsed is still decided by the owner, not by what earned the section. */
  it('collapses a section that is not about application code', () => {
    const report = renderReport(
      input({
        triaged: [
          row({
            classification: {
              owner: 'environment',
              determinism: 'deterministic',
              confidence: 0.8,
              reasoning: 'the port was still held by the previous job',
              evidence: ['x'],
            },
            fixSuggestion: fix,
          }),
        ],
      }),
    )
    expect(sections(report)).toEqual(['<details>'])
    expect(report).toContain('<summary>board › reorders two rows</summary>')
  })

  /**
   * A row used to cut the id at 90 characters, which cut two of the three tests
   * in the first comment this pipeline posted about its own pull request. Every
   * id in this repository's suites fits in 120, and is now shown whole.
   */
  it('shows a long test id whole in the row, and writes no section for it', () => {
    const title = 'keeps both moves when a task is moved twice in quick succession, across a reload'
    const report = renderReport(input({ triaged: [named(title)] }))
    expect(report).toContain(`| tests/e2e/board.spec.ts›${title} |`)
    expect(sections(report)).toEqual([])
  })

  /**
   * Past that, the row has to cut, and then the section is the only place the
   * whole title is written. A name that cannot be found is a finding nobody acts on.
   */
  it('writes a section when the row has to cut the test id, and names the test in full', () => {
    const title =
      'renders the board for a workspace whose name runs long enough to wrap twice, ' +
      'then reloads it and checks the order'
    const report = renderReport(input({ triaged: [named(title)] }))
    const tableRow = report.split('\n').find((line) => line.includes('tests/e2e/board.spec.ts›'))
    expect(tableRow).toContain('…')
    expect(tableRow).not.toContain(title)
    expect(sections(report)).toEqual([`### ${title}`])
  })
})

describe('the footer', () => {
  it('states the model, the prompt versions and what the run cost', () => {
    const report = renderReport(input())
    expect(report).toContain('claude-opus-5')
    expect(report).toContain('triage `triage.v1`')
    expect(report).toContain('1200 tokens')
  })

  /**
   * A verdict in a pull-request comment reads as ground truth unless the comment
   * says otherwise. This is the line that says otherwise.
   */
  it('states the classifier’s measured accuracy, and what it means', () => {
    const report = renderReport(input({ accuracy: agentAccuracy }))
    expect(report).toContain('Measured accuracy of this classifier: 62% joint')
    expect(report).toContain('wrong about 38% of failures')
    expect(report).toContain('eval-methodology.md')
  })

  /** "62%" alone does not say of what; the dataset and the slice do. */
  it('names what the figure was measured on', () => {
    const report = renderReport(input({ accuracy: agentAccuracy }))
    expect(report).toContain('on the golden dataset (prompt triage.v1, dev slice, n=26)')
  })

  /** The baseline has no prompt, and `(null, n=26)` is not a sentence. */
  it('names the baseline as the baseline', () => {
    const report = renderReport(
      input({
        accuracy: {
          joint: 0.34615,
          n: 26,
          slice: 'dev',
          classifier: 'baseline',
          promptVersion: null,
        },
      }),
    )
    expect(report).toContain(
      'Measured accuracy of this classifier: 35% joint** on the golden dataset ' +
        '(baseline heuristic, dev slice, n=26)',
    )
    expect(report).toContain('wrong about 65% of failures')
    expect(report).not.toContain('null')
    expect(report).not.toContain('has not been scored')
  })

  /** Both figures come from one rounded number, so they cannot sum to 101. */
  it('keeps the two percentages consistent at a rounding boundary', () => {
    const report = renderReport(input({ accuracy: { ...agentAccuracy, joint: 0.345 } }))
    const [, right, wrong] = /(\d+)% joint.*wrong about (\d+)%/s.exec(report) ?? []
    expect(Number(right) + Number(wrong)).toBe(100)
  })

  /**
   * The slice and the prompt version come from a committed file a pull request
   * can edit, so they are repository strings like any other.
   */
  it('escapes what it quotes from the metrics file', () => {
    const report = renderReport(
      input({
        accuracy: {
          ...agentAccuracy,
          slice: '</details>\n## forged',
          promptVersion: 'v1 | `x`',
        },
      }),
    )
    expect(report).not.toContain('</details>\n## forged')
    expect(report).not.toMatch(/^## forged/m)
    expect(report).toContain('&lt;/details&gt;')
    expect(report).toContain('v1 &#124; &#96;x&#96;')
  })

  /** Silence would read as a system that does not measure itself. */
  it('says so out loud when nobody has scored the classifier', () => {
    const report = renderReport(input())
    expect(report).toContain('has not been scored yet')
    expect(report).toContain('unmeasured system')
  })
})

describe('the notices block', () => {
  /**
   * Silent degradation is the specific behaviour that turns a useful tool into a
   * misleading one: the output looks the same, it is just quietly worse.
   */
  it('is absent entirely when the run was clean', () => {
    expect(renderReport(input())).not.toContain('⚠️')
  })

  it('counts the unclassified, and says what that costs the counts above', () => {
    const report = renderReport(
      input({
        triaged: [
          row(),
          row({ classification: undefined, unclassified: { reason: 'error', detail: 'boom' } }),
        ],
      }),
    )
    expect(report).toContain('1 test(s) went unclassified')
    expect(report).toContain('not all of it')
  })

  it('names the budget when that is why rows are missing', () => {
    const report = renderReport(
      input({
        triaged: [
          row(),
          row({ classification: undefined, unclassified: { reason: 'budget', detail: 'gone' } }),
        ],
      }),
    )
    expect(report).toContain('reached its token budget')
  })

  /** Passed in by the caller, which is the only thing that knows about credentials. */
  it.each([
    ['noKey', DEGRADATIONS.noKey, 'no credentials'],
    ['noHistory', DEGRADATIONS.noHistory, 'reads as new'],
    ['unreadableHistory', DEGRADATIONS.unreadableHistory, 'writing that file wrongly'],
  ])('renders the %s notice', (_name, notice, phrase) => {
    expect(renderReport(input({ notices: [notice] }))).toContain(phrase)
  })

  /**
   * The truncation notice can only be known after the document is rendered, so
   * it is added on a second pass rather than guessed at from a length.
   */
  it('adds itself when the report had to be cut', () => {
    const many = Array.from({ length: 400 }, () => row({ rootCause: cause }))
    const report = renderReport(input({ triaged: many }))
    expect(report).toContain('truncated to fit GitHub')
    expect(report.length).toBeLessThanOrEqual(COMMENT_LIMIT)
  })

  /** Every notice says what it means, not only what happened. */
  it.each(Object.entries(DEGRADATIONS).filter(([, v]) => typeof v === 'string'))(
    '%s explains the consequence',
    (_name, notice) => {
      expect(String(notice).length).toBeGreaterThan(80)
    },
  )

  /**
   * Notices go through the same escaping as model text, which is right — but
   * then a backtick in one of our own sentences reaches the page as `&#96;`.
   * The fix is in the wording, not in exempting notices from the escape.
   */
  it.each(Object.entries(DEGRADATIONS).filter(([, v]) => typeof v === 'string'))(
    '%s survives the escape unchanged',
    (_name, notice) => {
      expect(escapeAgentText(String(notice))).toBe(notice)
    },
  )
})

describe('fitting under GitHub’s comment limit', () => {
  it('leaves a short report exactly as it is', () => {
    const whole = fit('body', 'footer', 1000)
    expect(whole).toBe('bodyfooter')
  })

  /**
   * The footer carries the accuracy figure — the line that stops a reader
   * treating the rest as ground truth — so it is the part that must survive.
   */
  it('keeps the footer and drops the body', () => {
    const footer = '\n---\nMeasured accuracy: 62%\n'
    const out = fit('x'.repeat(100_000), footer, 5_000)
    expect(out.endsWith(footer)).toBe(true)
    expect(out.length).toBeLessThanOrEqual(5_000)
    expect(out).toContain('truncated')
  })

  it('says it was truncated rather than just stopping', () => {
    expect(fit('x'.repeat(100_000), 'f', 5_000)).toContain(TRUNCATION_NOTICE.trim().split('\n')[0])
  })

  it('cuts at a section boundary so it does not end mid-sentence', () => {
    const body = Array.from(
      { length: 200 },
      (_, i) => `\n### Section ${String(i)}\n${'x'.repeat(400)}`,
    ).join('')
    const out = fit(body, '\nfooter\n', 20_000)
    expect(out).toContain(TRUNCATION_NOTICE.trim().split('\n')[0])
    expect(out.split(TRUNCATION_NOTICE)[0]?.trimEnd().endsWith('x')).toBe(true)
  })

  it('stays under the real limit for a large run', () => {
    const many = Array.from({ length: 400 }, () => row({ rootCause: cause }))
    const report = renderReport(input({ triaged: many }))
    expect(report.length).toBeLessThanOrEqual(COMMENT_LIMIT)
  })

  /**
   * A collapsed section starts at `<details>`, not at a heading. Cut inside one
   * and the notice and the footer render inside a block that never closes —
   * still in the text, folded out of sight under the last test's summary.
   */
  it('cuts before a collapsed section, so the footer is not folded into it', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      named(`case ${String(i)}`, {
        classification: {
          owner: 'test_code',
          determinism: 'intermittent',
          confidence: 0.7,
          reasoning: 'the locator matches two rows while the list re-renders. '.repeat(7),
          evidence: ['x'],
        },
      }),
    )
    const report = renderReport(input({ triaged: many, accuracy: agentAccuracy }))
    const [kept = ''] = report.split(TRUNCATION_NOTICE)
    expect(report).toContain(TRUNCATION_NOTICE)
    expect(kept.split('<details>').length).toBe(kept.split('</details>').length)
    expect(kept.trimEnd().endsWith('</details>')).toBe(true)
    expect(report).toContain('Measured accuracy of this classifier: 62% joint')
  })
})
