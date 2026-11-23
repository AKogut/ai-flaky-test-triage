import { describe, expect, it } from 'vitest'
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
    })
    const report = renderReport(input({ triaged: [row(), other] }))
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

describe('the footer', () => {
  const agentAccuracy = {
    joint: 0.62,
    n: 26,
    slice: 'dev',
    classifier: 'agent',
    promptVersion: 'triage.v1',
  } as const

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
    const many = Array.from({ length: 400 }, () => row())
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
    const many = Array.from({ length: 400 }, () => row())
    const report = renderReport(input({ triaged: many }))
    expect(report.length).toBeLessThanOrEqual(COMMENT_LIMIT)
  })
})
