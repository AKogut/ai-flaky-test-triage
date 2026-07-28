# Agent design

Three agents, each a **single model call with a forced output schema**. No loops, no scratchpads,
no self-critique passes, no tool use beyond structured output. That is a decision, not an
omission — see [Why no agent loop](#why-there-is-no-agent-loop).

## Shared infrastructure

Every agent call goes through one wrapper that provides:

- **Structured output** via a tool-use schema. The model cannot return prose where an enum is
  expected; a schema violation triggers a retry with the validation error appended.
- **Input sanitisation.** Test names, error messages, and diff hunks are untrusted text. They are
  length-capped, fenced inside explicit delimiters, and prefixed with a standing instruction that
  content inside the delimiters is data, never instruction.
- **Replay/record.** With `SENTRA_REPLAY=1`, requests hash to a cassette file under
  `agents/replay/cassettes/` and the recorded response is returned. With `SENTRA_RECORD=1`, live
  responses are written there. This makes the demo credential-free and the integration tests free
  and deterministic.
- **Telemetry.** One OpenTelemetry span per call, carrying model, token counts, latency, cost,
  retry count, and cassette hit/miss. Exported to `otel-spans.json`.
- **Budget.** A per-run token ceiling. When it is hit the orchestrator stops dispatching and the
  report says how many failures went unclassified rather than silently truncating.

## 1. Triage agent

**Runs for:** every failing or newly-flaky test in the run.

**Input:** the context bundle from [architecture.md](architecture.md#3-analysisjson--agent-inputs)
— error, stack, snippet, flakiness signal, status history, diff summary, whether the diff touches
the file under test, and the test's own source.

**Output:** the `Classification` object from [taxonomy.md](taxonomy.md#output-schema).

**Prompt structure:**

1. Role and the two-axis definition, verbatim from the taxonomy doc — the same text the human
   labeller used, so the model and the ground truth share a rubric.
2. The ordered labelling rules, so ambiguous cases resolve the same way the dataset does.
3. Explicit instruction to reason about the axes independently.
4. The evidence bundle, in delimited blocks.
5. A requirement to quote evidence for the decision.

**Design notes:**

- The rubric is loaded from a single source shared with the eval harness. A prompt change that
  contradicts the labelling rules is a bug, and keeping one copy makes it impossible.
- Temperature is 0, which reduces but does not eliminate variance. The eval harness samples
  N times per fixture for exactly this reason.
- Prompts are versioned (`prompts/triage.v3.md`). `eval/report.md` records which version produced
  which numbers, so a regression is attributable.

## 2. Root-cause agent

**Runs for:** classifications of `owner: app_code` above the confidence threshold. The threshold
is chosen from the calibration curve, not picked by hand — see
[eval-methodology.md](eval-methodology.md#confidence-calibration).

**Input:** the triage output, the full diff of the files implicated, and the source of the
function(s) named in the stack trace.

**Output:**

```ts
type RootCause = {
  hypothesis: string          // <= 600 chars, plain prose
  implicatedFiles: string[]
  implicatedSymbols: string[]
  mechanism: 'race' | 'null_handling' | 'state_leak' | 'logic_error'
            | 'api_contract' | 'timing' | 'other'
  confidence: number
  alternativeHypothesis?: string
}
```

`alternativeHypothesis` is required whenever confidence is below 0.7. A single confident-sounding
explanation is the most dangerous output this system can produce; forcing a stated alternative
makes uncertainty visible in the report rather than buried in a number.

## 3. Fix-suggestion agent

**Runs for:** root-cause outputs above threshold.

**Input:** the hypothesis plus the relevant source.

**Output:**

```ts
type FixSuggestion = {
  summary: string             // one sentence
  approach: string            // prose, <= 800 chars
  patch?: string              // unified-diff-style snippet, illustrative only
  risks: string[]             // what this fix could break
  testGap?: string            // what test would have caught this earlier
}
```

**Hard guardrail:** this agent has no filesystem-write capability and the orchestrator never
applies its output. `patch` is a fenced code block in markdown. There is no code path from this
agent's output to `fs.writeFile`, and a unit test asserts that.

`risks` and `testGap` are required fields. A fix suggestion without stated risks reads as more
authoritative than it deserves to be, and the most valuable output for a flaky-test system is
often "the real problem is that nothing tests this path".

## Orchestration

```
analysis.json
  → filter to failing / newly-flaky
  → sort by (owner-uncertainty, flakinessScore) so budget goes to ambiguous cases first
  → concurrency-limited fan-out (default 4)
  → triage each
  → for app_code above threshold: root cause → fix suggestion
  → assemble report.md
```

Failures of individual agent calls are isolated: one test's API error produces an
`unclassified` row, not a dead pipeline.

**Report structure** (`report.md`):

1. Header: run summary, counts per quadrant, whether the run was degraded (no API key, budget
   hit, missing history).
2. A table of every failure, one row each: test, quadrant, confidence, one-line reason.
3. Expanded sections for `app_code` findings — hypothesis, alternative, fix suggestion, risks.
4. Collapsed `<details>` sections for the rest.
5. Footer: model, prompt version, token count, cost, eval accuracy of the current prompt, and a
   link to the methodology. **The report states the classifier's own measured accuracy inline**,
   so nobody reads it as ground truth.

## Why there is no agent loop

Triage is a single decision over a fixed, bounded input. Every piece of evidence that exists is
available before the first token. There is nothing to explore, no external state to query, no
sub-goal to decompose. A ReAct-style loop would add latency, cost, and non-determinism in exchange
for the model re-reading text it already has.

This is a claim, not an axiom, and the project treats it as testable: `npm run eval:ablation`
includes a multi-step variant. If it wins on the hard quadrants by a margin that justifies the
cost, the result becomes an ADR and the architecture changes. Until then, the simple thing stays.

## Prompt-injection considerations

Hostile content can enter through test titles, assertion messages, source comments, and diff
hunks — all attacker-controllable in a fork PR. Defences:

1. Untrusted content lives inside delimiters and is introduced as data.
2. Output is schema-constrained: the model cannot emit an instruction, only enum values and
   bounded strings.
3. The report escapes agent output before writing markdown, so injected HTML/markdown cannot
   forge report structure.
4. Nothing downstream *executes* agent output. The worst achievable outcome is a wrong label and
   a misleading comment — bad, but not an escalation.
5. Fork PRs have no API key at all, which removes most of the surface by construction.
