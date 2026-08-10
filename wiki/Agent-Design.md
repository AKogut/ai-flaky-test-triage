# Agent Design

> Normative version, with prompt structure and full schemas:
> [`docs/agent-design.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/agent-design.md).

## Three agents, three single calls

| Agent              | Runs for                                  | Produces                                                                                     |
| ------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Triage**         | every failing or newly-flaky test         | two-axis classification, confidence, quoted evidence                                         |
| **Root cause**     | `app_code` above the calibrated threshold | a hypothesis, implicated files and symbols, a mechanism, a mandatory alternative when unsure |
| **Fix suggestion** | root causes above threshold               | prose approach, an illustrative patch, **risks**, and the missing test                       |

No loops. No scratchpads. No self-critique passes. No tools beyond the structured-output schema.

## Why there is no agent loop

"Agent" usually implies a loop: plan, call a tool, observe, iterate. That shape exists for tasks
where the necessary information is not known in advance and must be discovered.

Triage is not that task. The input is fixed and complete before the first token — an error, a stack,
a snippet, a flakiness history, a diff, the test's source. There is nothing to discover, no external
state to query, no sub-goal to decompose. A loop would mostly re-read text the model already has,
in exchange for latency, cost, and non-determinism in a step whose evaluation is already fighting
variance.

The honest part: this is a claim, not an axiom. The ablation study runs a bounded multi-step variant
against the same dataset. If it wins on the hard quadrant by a margin that survives its confidence
interval and justifies the cost, that becomes a superseding ADR and the architecture changes.

[ADR-0006](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0006-single-shot-agents-no-loop.md) ·
[the experiment](https://github.com/AKogut/ai-flaky-test-triage/issues/80)

## One wrapper, five properties

Every model call in the project goes through a single wrapper. That is what makes these guarantees
structural rather than aspirational:

- **Structured output.** The response is validated against a Zod schema; a violation is retried with
  the validation error appended. The model cannot return prose where an enum is expected.
- **Sanitisation.** Test titles, error messages, source, and diff hunks are attacker-influenced on a
  fork PR. They are length-capped, delimited, escaped, and introduced as data.
- **Replay.** Cassettes make the demo credential-free and the integration tests free and
  deterministic. A cassette miss is a loud error, never a silent fall-through to a live call.
- **Telemetry.** One span per call carrying model, tokens, latency, cost, retries, cassette hit.
- **Budget.** A per-run token ceiling. When hit, the orchestrator stops dispatching and the report
  says how many failures went unclassified — rather than truncating silently.

If any agent could construct its own client, every one of those would be a convention instead of a
guarantee.

## Design details worth knowing

**The rubric has one source.** The classification rubric in the triage prompt and the labelling
rules used to build the dataset are the same file. If they drift, the evaluation measures agreement
with a rubric nobody is applying — and it would keep producing plausible numbers while doing so.

**Prompts are versioned files.** `prompts/triage.v1.md`, `v2`, and so on. `eval/report.md` records
which version produced which numbers, so a regression is attributable to a change. Editing a
version in place after its numbers are published breaks that link, and CI rejects it.

**`alternativeHypothesis` is mandatory below 0.7 confidence.** A single confident-sounding
explanation is the most dangerous output this system can produce, because it redirects a
developer's attention with more authority than it has earned. Forcing a stated alternative puts the
uncertainty in front of the reader.

**`risks` and `testGap` are required on every fix suggestion.** A suggestion without stated risks
reads as more authoritative than it deserves to. And for a flaky-test system, the most valuable
output is often "the real problem is that nothing tests this path".

## Orchestration

```
analysis.json
  → filter to failing / newly-flaky
  → sort by ambiguity, most uncertain first
  → concurrency-limited fan-out
  → triage each
  → app_code above threshold → root cause → fix suggestion
  → assemble report.md
```

The sort order is the non-obvious part. Work is ordered by ambiguity so that if the budget runs out,
the cases dropped are the ones a heuristic could have handled anyway. Processing in file order would
spend the budget alphabetically, which is the same as spending it at random.

Individual failures are isolated: one test's API error produces one `unclassified` row, not a dead
pipeline. A tool for analysing CI failures that becomes unavailable when CI is unhealthy would be a
poor joke.

## Prompt injection

Hostile content can arrive through test titles, assertion messages, source comments, and diff
hunks — all attacker-controllable on a fork pull request.

The defences are layered, but the one that actually matters is the last: **nothing downstream
executes agent output.** The impact ceiling of a successful injection is a wrong label and a
misleading comment. Bad, worth preventing, not an escalation.

Fork PRs also receive no API key at all, which removes most of the surface by construction rather
than by control.

Full threat model: [Limitations and Guardrails](Limitations-and-Guardrails).
