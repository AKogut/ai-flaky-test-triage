# ADR-0003: Dataset-first milestone ordering

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** @AKogut

## Context

The natural order is to build the demo app, write tests for it, make some of them flaky, and then
build the AI layer on top of the traces they produce. It follows the data flow, so it feels right.

It has two problems. First, the least differentiated part of the project — a small CRUD app with
drag-and-drop — is also the most time-consuming, and it sits in front of everything that carries
the actual value. Second, and worse: it defers the only question that can invalidate the project.
_Can a model classify these failures better than a thirty-line heuristic?_ Learning the answer
after a week of React work is the expensive way to learn it.

## Decision

The evaluation harness and a measurable triage agent land **before** the application. Fixtures for
the golden dataset are hand-authored JSON, which requires no app to exist. The application arrives
at M4, after the core hypothesis has been tested, and its role is then to _extend_ the dataset
with captured real-world runs rather than to bootstrap it.

Order: contracts (M1) → dataset + baseline + eval (M2) → triage agent (M3) → app (M4) →
tests (M5) → flakemetry (M6) → remaining agents (M7) → CI (M8).

## Options considered

### Option A — App-first (spec order)

- **Pros:** natural data flow; real traces from the start; visible progress early.
- **Cons:** the falsifying experiment runs last; several days of UI work are committed before any
  evidence exists that the premise holds; the dataset ends up derived entirely from one app's
  failure modes.

### Option B — Dataset-first (chosen)

- **Pros:** the project's central claim is tested in week one, cheaply; the eval harness exists
  before the prompts, so every prompt change is measured from the first one; hand-authored
  fixtures can be adversarial in ways a real app would not naturally produce.
- **Cons:** no runnable demo until M4; early fixtures are synthetic, which is a validity threat
  that has to be managed explicitly.

## Consequences

### Positive

- A go/no-go signal on the premise arrives before the expensive work.
- Prompt development never happens without a measurement, which is the single most common failure
  mode in LLM projects.
- Fixture provenance (`synthetic` / `captured` / `mutated`) becomes a tracked dimension, and the
  synthetic-only risk is measured rather than assumed away.

### Negative / accepted costs

- Nothing visually demonstrable exists for the first two milestones. Mitigated by `eval/report.md`
  being a genuine artifact.
- Synthetic fixtures risk encoding the author's expectations of what failures look like. M5
  explicitly requires captured fixtures from real runs, and metrics are broken down by provenance.

### What would make us revisit this

If synthetic-fixture accuracy and captured-fixture accuracy diverge sharply once M5 lands, the
dataset-first approach produced a classifier tuned to imagination rather than reality. The
response would be to reweight the dataset toward captured runs and re-tune, recorded in a new ADR.
