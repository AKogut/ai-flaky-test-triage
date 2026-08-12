# Agent design

Three agents, each a **single model call with a forced output schema**. No loops, no scratchpads,
no self-critique passes, no tool use beyond structured output. That is a decision, not an
omission — see [Why no agent loop](#why-there-is-no-agent-loop).

## Shared infrastructure

Every agent call goes through `agents/model-client.ts`, which provides:

- **Structured output** from the Zod schema. The response format is derived from the same schema
  that validates the reply, so the model cannot return prose where an enum is expected. A schema
  violation triggers a retry with the validation errors appended — the model is shown its own
  failure, because a bare "try again" re-runs the same misunderstanding at the same price.
- **Input sanitisation.** Test names, error messages, and diff hunks are untrusted text. They are
  length-capped, fenced inside explicit delimiters, and prefixed with a standing instruction that
  content inside the delimiters is data, never instruction. `agents/sanitise.ts`; see
  [Prompt-injection considerations](#prompt-injection-considerations).
- **Replay/record.** A decorator around the transport, so replay has no opinion about the SDK and
  the SDK adapter has none about replay. `SENTRA_REPLAY=1` serves from
  `agents/replay/cassettes/`; `SENTRA_RECORD=1` writes there; with no credentials replay is the
  default, which is what makes the demo credential-free and the integration tests free and
  deterministic. **A replay miss throws** — in replay the inner transport is unreachable, not
  merely unused, and a test proves it by wrapping one that fails on any call. A silent fallthrough
  would turn a free deterministic run into a surprise bill and an intermittent test, and would take
  months to notice.
- **Telemetry.** One OpenTelemetry span per call, carrying model, token counts, latency, cost,
  retry count, and cassette hit/miss. Exported to `otel-spans.json`.
- **Budget.** A per-run token ceiling, checked **before** dispatch against a real
  `count_tokens` call rather than a character estimate, and re-checked before each schema retry
  because a corrected prompt is longer. When it is hit the orchestrator stops dispatching and the
  report says how many failures went unclassified rather than silently truncating. A budget that
  only reports what was spent is an invoice.

### One transport, enforced

`agents/transport.ts` is the only module allowed to construct an SDK client, and
`eslint.config.js` fails the build on an `@anthropic-ai/sdk` import anywhere else under `agents/`.
Every property above is a property of going through that seam; without the rule each one holds
until the first call site that forgets, and then stops holding silently.

### Retries are classified, not counted

| Failure                                  | Retried                       | Why                                                              |
| ---------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| Schema violation                         | yes, with the errors appended | The model can correct itself once it sees what was wrong         |
| Rate limit (429)                         | yes, after backing off        | The request is fine; the timing is not                           |
| Server fault (5xx) or connection failure | yes, after backing off        | Nothing about the request caused it                              |
| Malformed request (4xx)                  | **no**                        | Sending it again produces the same 4xx                           |
| Refusal                                  | **no**                        | A decision, not a fault — asking again buys the same answer      |
| Anything unclassified                    | **no**                        | Retrying what nobody has categorised is how a bug becomes a bill |

Backoff is exponential with **full jitter**. A fleet that backs off on an identical curve
re-collides at every step, which is how one rate limit becomes a synchronised herd.

### The model is pinned, and refusals are not papered over

The model ID lives in `MODEL_CONFIG` and nowhere else, so "which model produced this number" has
one answer per commit. `.github/dependabot.yml` ignores the SDK for the same reason: a model change
moves every figure in `eval/report.md` and belongs in a reviewable commit with an eval run attached.

Server-side model fallback on a refusal is **off by default**. It is a real feature and a
reasonable default for the PR-comment path, where an answer from a second model beats no answer.
It is the wrong default here: a silent substitution part-way through an evaluation would make the
headline a blend of two models while the report still names one. A refusal surfaces as a typed
error and is recorded.

## 1. Triage agent

**Runs for:** every failing or newly-flaky test in the run.

**Input:** the context bundle from [architecture.md](architecture.md#3-analysisjson--agent-inputs)
— error, stack, snippet, flakiness signal, status history, diff summary, whether the diff touches
the file under test, and the test's own source.

**Output:** the `Classification` object from [taxonomy.md](taxonomy.md#output-schema).

**Prompt structure.** Every instruction is in the system message and every untrusted string is in
the user message, with nothing interpolated across the line. That split is the reason
`prompts/registry.ts` offers exactly one substitution — the rubric — and refuses a template with
any other placeholder: a prompt file that could interpolate evidence would be a prompt file that
can put attacker text inside an instruction.

System (`prompts/triage.v1.md`):

1. Role, and what the output is for.
2. The rubric — the two-axis definition and the ordered labelling rules, substituted verbatim from
   the same file the human labeller applies, so the model and the ground truth cannot disagree.
3. What absence and truncation in the evidence mean, so a capped field is not read as a complete
   one.
4. The output contract, including what `confidence` is measured against and a requirement to quote
   the evidence relied on rather than summarise it.

User (`agents/sanitise.ts`):

5. The standing "this is data" preamble, then the evidence in delimited blocks.

**Design notes:**

- **The rubric has one copy.** `prompts/rubric.md` is substituted into the prompt at load time and
  generated into [taxonomy.md](taxonomy.md#the-rubric), which is what the human labeller applies.
  A prompt whose definition of `intermittent` has drifted from the dataset's would make the
  evaluation measure agreement with a rule nobody is following, and the figure would look exactly
  like the one that meant something. `npm run prompts:sync` writes the copy, a unit test fails when
  it is stale, and a test asserts no prompt file contains a pasted duplicate — the invariant is
  "there is no second copy", not "the copies currently agree".
- **There is no temperature to set.** This model rejects `temperature`, `top_p` and `top_k` with a
  400, so the usual "pin it to 0 and call it deterministic" move is not available — and the loss is
  smaller than it looks, because it was never determinism in the first place. Variance is measured
  rather than suppressed: the eval harness samples N times per fixture and reports
  self-consistency as a first-class metric. A test asserts the client sends no sampling parameter,
  so this cannot drift back in.
- **Quoted evidence is verified against the input.** `evidence` is required by the schema, but a
  schema cannot tell a quotation from an invention — and an invented one reads exactly like a real
  one, which is what makes it the most damaging output this agent can produce. Every classification
  is checked: each quoted fragment must appear in the text the model was shown, with whitespace
  normalised and elisions honoured, so the count means "invented" rather than "reformatted".
  Reported, not rejected — throwing away an otherwise usable classification would hide the rate, and
  the rate is the thing worth knowing. #38 publishes it beside the accuracy figures.
- **Prompts are versioned and published versions are immutable.** `prompts/triage.v1.md`;
  `eval/report.md` and `eval/metrics.json` record which version produced which numbers, so a
  regression is attributable. Editing a version in place keeps the record and destroys the link —
  the report still names `triage.v1`, and `triage.v1` is now different text — so
  `npm run prompts:freeze` fails the build on any change to a prompt the committed metrics name,
  the rubric included, since it is a section of every prompt rather than a document about them.
  The next version is the way forward, not an edit.

### Running it

`eval/classifier.ts` is the seam: one signature, one input type, one place that decides whether a
run uses the heuristic or the model. The agent and the control have to be scored the same way over
the same input or the headline number compares their inputs rather than themselves, so nothing
about the two paths differs after this function returns.

The seam is async for both. That costs the baseline nothing and keeps every caller identical.

One token budget is shared across the whole run rather than one per call — a per-call ceiling is
not a ceiling on anything, since thirty-three fixtures would each stay inside it and the run would
spend thirty-three times what was authorised. Fixtures are scored sequentially: concurrency would
buy wall-clock and cost a deterministic order for the budget to run out in.

In replay mode the transport handed to the decorator is one that throws on any call. Constructing a
real client there would work — the SDK does not check a key until it sends — and would turn a
cassette miss into a live request from a run that was supposed to be free.

## 2. Root-cause agent

**Runs for:** classifications of `owner: app_code` above the confidence threshold. The threshold
is chosen from the calibration curve, not picked by hand — see
[eval-methodology.md](eval-methodology.md#confidence-calibration).

**Input:** the triage output, the full diff of the files implicated, and the source of the
function(s) named in the stack trace.

**Output:**

```ts
type RootCause = {
  hypothesis: string // <= 600 chars, plain prose
  implicatedFiles: string[]
  implicatedSymbols: string[]
  mechanism:
    'race' | 'null_handling' | 'state_leak' | 'logic_error' | 'api_contract' | 'timing' | 'other'
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
  summary: string // one sentence
  approach: string // prose, <= 800 chars
  patch?: string // unified-diff-style snippet, illustrative only
  risks: string[] // what this fix could break
  testGap?: string // what test would have caught this earlier
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
hunks — all attacker-controllable in a fork PR. The honest framing is that none of this prevents
the model from being persuaded; what it does is make persuasion structurally cheap to survive.

`agents/sanitise.ts` prepares every untrusted field in a fixed order — **normalise, redact,
escape, cap** — and the order is the design:

1. **Normalise.** ANSI sequences are stripped as whole sequences rather than by their escape byte,
   which would leave `[31m` sitting in an assertion message looking like something the test
   printed. Bidirectional overrides and zero-width characters are removed outright: they are the
   Trojan Source family, and their only use here is to make a rendered line say something other
   than what it contains — first to whoever reviews the input, then to whoever reads the report
   that quotes it back.
2. **Redact.** A secret-pattern scrub, shared with the cassette writer so there is one list rather
   than two. Before the cap, never after: truncating first can slice a credential past its own
   pattern, leaving a partial key in the prompt and a redaction count of zero to say all was well.
3. **Escape.** The three markers the harness owns — the two fences and the truncation notice — are
   replaced wherever they occur in content, case-insensitively. No input can close its own block
   and continue as though it were the harness talking, and no input can fake a notice that
   evidence was withheld.
4. **Cap.** Per-field, configurable, and a hard bound on rendered length rather than an intention:
   the truncation notice is budgeted _inside_ the cap. Truncation keeps both ends, because a stack
   names its origin at the top and an assertion puts expected-versus-actual at the bottom.

Then the guarantees that hold whatever the model does with the text:

5. **Truncation is never silent.** `[... truncated N characters ...]` appears in the prompt, and
   the same numbers reach the report, so neither the model nor the reader mistakes partial
   evidence for complete evidence.
6. **The total is bounded by construction.** A test sums the caps against the budget, so no
   combination of adversarial inputs can produce an oversized prompt — the runtime check exists
   for the caller who overrides a cap later, not for the defaults.
7. **Output is schema-constrained.** A fully persuaded model still has to answer in the
   `Classification` shape; anything else is a `SchemaViolationError`, not a result. A test asserts
   exactly that, because it is what caps the blast radius.
8. The report escapes agent output before writing markdown, so injected HTML/markdown cannot
   forge report structure.
9. Nothing downstream _executes_ agent output. The worst achievable outcome is a wrong label and
   a misleading comment — bad, but not an escalation.
10. Fork PRs have no API key at all, which removes most of the surface by construction.

The test suite carries a corpus of injection attempts — forged terminators in three casings, a
nested block, a terminator flood, an override hidden behind ANSI, another hidden behind a
right-to-left mark, a fake conversation turn, a fake tool result. Each one is asserted against a
property rather than a snapshot: the model sees exactly one opening and one closing marker per
field, whatever the content tried to add.
