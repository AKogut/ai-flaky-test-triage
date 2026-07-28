# ADR-0001: Single repository, no persistent services

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** @AKogut

## Context

The original design for this system was service-shaped: a webhook listener, a job queue, a
Postgres instance for run history, and a registered GitHub App to post comments. That is a
defensible architecture for a product serving many repositories. It is a poor architecture for
this project, for one reason that dominates all others: **the work is triggered exactly once per
CI run and takes seconds.**

A service adds an availability problem, a deployment problem, a credentials problem, and a data
retention problem to a workload with no continuous demand. It also destroys the property that
matters most for a portfolio artifact — that someone can clone the repository and see the whole
thing work.

## Decision

Everything lives in one repository. Every component is a CLI script invoked by `npm run` locally
or as a GitHub Actions step. State between runs is a file. No server, queue, listener, or hosted
database is required to run, demo, or develop the project.

## Options considered

### Option A — Service architecture (webhook + queue + Postgres + GitHub App)

- **Pros:** scales to many repositories; real-time; a natural home for a dashboard.
- **Cons:** cannot be evaluated by a reviewer without provisioning; hosting cost with near-zero
  duty cycle; App registration and secret rotation; the demo breaks silently when free-tier
  hosting sleeps.

### Option B — Single repo, one-shot scripts (chosen)

- **Pros:** `git clone && npm install && npm run demo` reproduces everything; no infrastructure to
  keep alive; CI is the only runtime, so the execution environment is identical for everyone;
  every component is directly unit-testable as a function.
- **Cons:** no cross-repository capability; history is bounded by CI cache durability; no live
  dashboard.

### Option C — Hybrid (scripts now, service later behind an interface)

- **Pros:** keeps the door open.
- **Cons:** the abstraction would be designed against an imagined second consumer. Speculative
  generality with a real maintenance cost today.

## Consequences

### Positive

- The Definition of Done is verifiable by anyone in under five minutes.
- No secret rotation, no uptime concern, no hosting bill.
- Components are pure functions over files, which makes the test strategy straightforward.

### Negative / accepted costs

- Run history depends on the GitHub Actions cache, which is evicted and expires (ADR-0004).
- Analysis latency is bounded by the CI job, not by the user.
- Generalising to other repositories is out of scope and would be a rewrite, not an extension.

### What would make us revisit this

A second repository genuinely wanting to consume this pipeline. That is the point at which the
service architecture starts paying for itself — and not before.
