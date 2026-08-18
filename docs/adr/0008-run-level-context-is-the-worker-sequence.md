# ADR-0008: Run-level context is the worker sequence, not the failure list

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** @AKogut
- **Related:** [ADR-0002](0002-two-axis-classification-taxonomy.md), [ADR-0006](0006-single-shot-agents-no-loop.md)

## Context

`agents/context.ts` assembled twelve fields, and every one of them described the failing test alone.
Nothing described the run.

That is fine until a spec leaves state behind and a _different_ spec fails because of it. Then the
failing test's evidence — assertion, stack, snippet, diff, source — is complete, internally
consistent, and points entirely at a file that is not the problem. A classifier given that bundle
cannot distinguish "this spec is wrong about the data" from "a different spec changed the data",
because the second hypothesis has no evidence in the input at all. The best it can do is guess.

Filed as #168 against the assembler rather than the prompt, on purpose. No wording change recovers
information that was never supplied, and tuning a prompt until it guesses `test_code` more often on
this shape is fitting the prompt to one fixture.

## Decision

The bundle carries **the tests that ran in the same worker before this one, in order** — id, title,
file, status — capped at ten, with the number omitted stated when the cap bites.

It does not carry a list of what else failed in the run, and it does not carry which tests wrote to
shared state.

## Options considered

### Option A — What else failed in this run

- **Pros:** cheapest of the three; derivable today with no contract change; a leak often takes more
  than one victim.
- **Cons:** **it would not have helped on the fixture that motivated the issue.** The culprit in a
  state leak has usually _passed_ — that is why it left something behind rather than dying. A field
  listing failures sounds useful, is easy to build, and is empty of the one row that matters.

That asymmetry is the whole argument. It is also the reason this ADR exists rather than a comment:
the cheap option is the one a reader would assume was chosen.

### Option B — What ran in the same worker, in order (chosen)

- **Pros:** contains the culprit, because a state leak is a leak _between tests sharing a process_.
  Playwright already reports `workerIndex` and `startTime` per result and the pipeline was
  discarding both. Cheap at ~590 characters for ten neighbours, against a 40,000-character evidence
  budget.
- **Cons:** two new optional fields on `TestResult`, and a reporter asymmetry — Vitest reports
  neither, so unit failures have no run context at all. Ordering depends on `startTime`; without it
  the field is withheld rather than guessed, because a plausible-looking wrong sequence invites the
  wrong answer more strongly than no field does.

### Option C — Which tests wrote to shared state

- **Pros:** the actual answer, when it can be had.
- **Cons:** requires instrumenting the application under test or the database, which is a different
  project. Rejected as out of proportion to the one failure shape it serves.

## Consequences

### Positive

- The cross-file leak becomes _possible_ to classify correctly. It was not, before.
- The material was already in the reports; only the assembly was missing.
- Ten neighbours is a knob, and #74's ablation can turn it — including to zero.

### Negative / accepted costs

- `TestResult` gains two optional fields that only one reporter populates. The reporter-contract
  test now asserts that asymmetry is exactly these two, so a third cannot join them unnoticed.
- Unit failures carry no run context. Correct — Vitest does not report workers — but it means the
  field is absent for a whole provenance, which the eval must not read as a property of the tests.
- Every fixture written before this predates the field. They state its absence in words, like an
  absent history, rather than rendering an empty sequence — an empty list reads as "nothing else
  ran", which is a claim, and a false one.

### What would make us revisit this

The ablation (#74) showing the field does not change accuracy, in which case it should be removed
rather than left in as a plausible-sounding cost. A negative result here is worth publishing: it
would say that the sequence is not enough on its own, and that Option C is the only thing that would
work.

## What is not yet known

Whether it _helps_. The field puts the culprit in front of the classifier; whether the classifier
uses it is a measurement, and that measurement needs live model calls (#38). This ADR records a
decision about what information the bundle carries, not a claim about accuracy.
