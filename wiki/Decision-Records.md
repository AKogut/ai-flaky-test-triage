# Decision Records

Seven decisions that were not obvious, cost something to reverse, or would otherwise have to be
reconstructed from the code. Full text in
[`docs/adr/`](https://github.com/AKogut/ai-flaky-test-triage/tree/main/docs/adr).

ADRs are immutable once accepted. A changed decision means a new ADR that supersedes the old one and
links back — the reasoning that turned out to be wrong is the interesting part.

---

### [ADR-0001](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0001-single-repo-no-persistent-services.md) — Single repository, no persistent services

The original design was service-shaped: webhook listener, job queue, Postgres, GitHub App. Rejected
because the work is triggered once per CI run and takes seconds, so a service adds availability,
deployment, credential, and retention problems to a workload with no continuous demand — and
destroys the property that a reviewer can clone the repository and run it.

**Revisit if** a second repository genuinely wants to consume the pipeline.

### [ADR-0002](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0002-two-axis-classification-taxonomy.md) — Two-axis classification taxonomy

The flat enum `real_bug | flaky_infra | stale_test | race_condition` has overlapping values — a
product race is both a real bug and a race — so ground truth was not reproducible, and every metric
built on it would have inherited the noise. Replaced by two orthogonal axes.

**Accepted cost:** joint accuracy is the lowest number the project reports, and it is the headline.

### [ADR-0003](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0003-dataset-first-milestone-ordering.md) — Dataset-first milestone ordering

App-first ordering follows the data flow and feels natural, but it defers the only question that can
invalidate the project — can a model beat a thirty-line heuristic? — until after a week of React
work. The eval harness and a measurable classifier land first; the app arrives later and extends the
dataset with captured runs.

**Revisit if** synthetic and captured accuracy diverge sharply once real runs land.

### [ADR-0004](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0004-history-persistence-via-ci-cache.md) — History via CI cache, `main`-only writes

Artifacts are addressed by run rather than by key, which makes "fetch the latest history" an API
listing exercise. `actions/cache` with restore-key fallback has exactly the right semantics.
Writing only from `main` eliminates the concurrent lost-update race rather than mitigating it.

**Accepted cost:** history is not durable; eviction is an expected operating condition.

### [ADR-0005](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0005-replay-cassettes-for-credential-free-demo.md) — Replay cassettes

Without them the Definition of Done is false: nobody evaluating a portfolio project will provision
an API key. One interception point at the model wrapper gives a credential-free demo, free
deterministic integration tests, and readable committed fixtures.

**Accepted cost:** cassettes go stale when prompts change, so CI checks for it.

### [ADR-0006](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0006-single-shot-agents-no-loop.md) — Single-shot agents, no loop

Triage is a single decision over a fixed, complete input. There is nothing to discover, so a loop
would add latency, cost, and non-determinism in exchange for re-reading text the model already has.
Stated as a testable claim, not an axiom — the ablation study runs a multi-step variant.

**Revisit if** the loop beats single-shot on the hard quadrant by a margin that survives its
interval.

### [ADR-0007](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0007-no-github-app-no-pull-request-target.md) — No GitHub App, no `pull_request_target`

A GitHub App solves a multi-repository problem that does not exist here. `pull_request_target` — the
usual workaround for fork PRs not getting secrets — runs untrusted code with a write-scoped token
and secrets in the environment. The project degrades instead of escalating.

**Side benefit:** it forces the baseline heuristic to be genuinely useful standalone, which is also
what makes it a fair evaluation control.

---

### [ADR-0008](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0008-run-level-context-is-the-worker-sequence.md) — Run-level context is the worker sequence

Every field the classifier saw described the failing test alone, which makes a cross-file state leak
impossible to get right: the failing test's evidence is complete, consistent, and points at the
wrong file. The bundle now carries the tests that shared a worker before it, in order.

**The rejected option is the interesting one.** "What else failed in this run" is cheaper, needs no
contract change, and would not have helped — the culprit in a state leak has usually _passed_, which
is why it left something behind rather than dying.

Whether it improves accuracy is a measurement, not a claim, and it needs live model calls.

---

## When an ADR is required

- Changing the agent architecture — call count, loop structure, tool surface
- Changing the classification schema or the labelling rules
- Changing how state persists between runs
- Removing, weakening, or adding a guardrail
- Adopting or rejecting an experiment

Use the [architecture decision issue template](https://github.com/AKogut/ai-flaky-test-triage/issues/new/choose).
