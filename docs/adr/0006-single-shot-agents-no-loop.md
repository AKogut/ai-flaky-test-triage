# ADR-0006: Single-shot agents, no agentic loop

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** @AKogut
- **Related:** [`docs/agent-design.md`](../agent-design.md)

## Context

"Agent" in current usage usually implies a loop: the model plans, calls tools, observes results,
and iterates until it decides it is done. That shape exists to handle tasks where the necessary
information is not known in advance and must be discovered.

Triage is not that task. The input is fixed and fully available before the first token: an error,
a stack, a snippet, a flakiness history, a diff, and the test's source. There is nothing to
discover, no external state to query, no sub-goal to decompose.

The pull toward a loop is aesthetic — it looks more sophisticated. That is a bad reason to add
latency, cost, and a source of non-determinism to a step that gates a CI comment.

## Decision

Each agent is a single model call with a forced output schema. No loop, no scratchpad, no
self-critique pass, no tool use beyond structured output. The pipeline's control flow is ordinary
TypeScript: filter, sort, fan out with a concurrency cap, assemble.

The claim that this is sufficient is treated as testable, not assumed. `npm run eval:ablation`
includes a multi-step variant, and the comparison is published.

## Options considered

### Option A — ReAct-style loop with tools (read file, run git, search)

- **Pros:** could pull in evidence the fixed bundle omits; adapts context depth to case difficulty.
- **Cons:** multiplies cost and latency by an unbounded factor; introduces non-determinism into a
  step whose eval is already fighting variance; needs a step cap, a loop-detection guard, and a
  per-tool sandbox — all of which are guardrail surface; the fixed bundle already contains the
  evidence, so the loop would mostly re-read it.

### Option B — Single call with a pre-assembled context bundle (chosen)

- **Pros:** one API call per decision, so cost and latency are predictable and budgetable; context
  assembly is a pure function and unit-testable without a network; the ablation study can measure
  each context field's contribution, which a loop makes almost impossible; far smaller guardrail
  surface — an agent with no tools cannot misuse one.
- **Cons:** context is fixed, so a case needing evidence outside the bundle cannot get it; adding a
  new evidence type means changing the assembler rather than letting the model ask.

### Option C — Two-pass: cheap classifier, expensive escalation for low confidence

- **Pros:** cost-efficient; concentrates capability where it is needed.
- **Cons:** depends on confidence being calibrated, which is itself unverified until M3.
  Premature.

## Consequences

### Positive

- Cost per run is bounded and predictable; the token budget is a simple multiplication.
- The ablation study is possible at all, because each context field is an independent variable.
- Guardrails are structural: an agent with no filesystem tool cannot write files, so the promise
  needs no runtime enforcement.

### Negative / accepted costs

- Failures whose explanation lies outside the assembled bundle are unreachable, and the ceiling on
  accuracy is set by the assembler rather than the model.
- Improving accuracy means improving context assembly — real engineering work rather than a prompt
  tweak. This is arguably a benefit.

### What would make us revisit this

The ablation showing the multi-step variant beating single-shot on the hard quadrant
(`app_code + intermittent`) by a margin that survives its confidence interval and justifies the
cost multiple. Option C also becomes worth revisiting once calibration data exists from M3.
