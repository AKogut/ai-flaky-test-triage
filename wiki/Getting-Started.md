# Getting Started

<!-- status:start -->

> **Project status: M2 — Golden dataset, baseline & eval harness.**
> 2 of 11 milestones complete.
> Current exit criterion: `npm run eval` scores the baseline heuristic on ≥30 labelled fixtures and writes a report with per-axis accuracy, intervals, and both confusion matrices — with no model involved.
>
> Progress is tracked as [milestones](https://github.com/AKogut/ai-flaky-test-triage/milestones), not dates.
> Commands marked 🚧 below are not implemented yet. Running one names the milestone it
> arrives in rather than failing with a missing-script error.

<!-- status:end -->

## Requirements

Node ≥ 22.13. Nothing else. No Docker, no database, and no API key for anything that works today.

## Clone and run

```bash
git clone https://github.com/AKogut/ai-flaky-test-triage.git
cd ai-flaky-test-triage
npm install
npm run help
```

`npm run help` prints every pipeline command, what it does, and — for the ones that do not exist
yet — which milestone it arrives in. It is the honest version of `npm run` on a project that is
still being built.

### What runs today

```bash
npm run test:unit     # the full suite, including the dataset's own tests
npm run eval:lint     # golden-dataset composition and label-leakage check
npm run typecheck
```

### What does not, and why it is described anyway

```bash
npm run demo          # 🚧 M3 · #39
```

The intent: run the entire pipeline — flakiness analysis, triage, root cause, fix suggestion,
report generation — against a bundled fixture run, using **recorded model responses**, with no
network call and no credentials.

That is the claim the Definition of Done rests on, which is why it is written down before it is
built rather than after. Running it today prints the milestone it arrives in and exits.

#### What replay mode will and will not prove

It will prove the pipeline works end to end: parsing, analysis, orchestration, schema validation,
report assembly. It will **not** prove what the model would say today, because the responses were
recorded earlier. The demo says so in its own output rather than implying a live classification
just happened.

Rationale: [ADR-0005](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0005-replay-cassettes-for-credential-free-demo.md).

## Check the classifier's accuracy yourself

```bash
npm run eval        # 🚧 M2 · #27
cat eval/report.md
```

This scores the classifier against the hand-labelled golden dataset **and** against the non-LLM
baseline heuristic on the same fixtures, with confidence intervals on every proportion.

The report is committed to the repository, so you can also just
[read the current one](https://github.com/AKogut/ai-flaky-test-triage/blob/main/eval/report.md)
without running anything. If the numbers there are unimpressive, that is deliberate — see
[Evaluation Methodology](Evaluation-Methodology) for why a flattering number would be the
suspicious outcome.

## Running against live models

```bash
cp .env.example .env
# add ANTHROPIC_API_KEY
npm test          # 🚧 M5 · #50 — runs the suite, writes results.json
npm run analyze   # 🚧 M8 · #71 — flakemetry + agents, writes report.md
```

`npm test` deliberately includes tests that fail intermittently. That is the point — they are the
input the pipeline exists to interpret. See [Architecture Overview](Architecture-Overview) for what
happens to their output.

## Running the demo application

```bash
npm run dev        # 🚧 M4 · #48
```

TaskFlow is a small task board: create, edit, delete, complete, filter, drag-to-reorder. It exists
only to be tested against and to produce realistic asynchronous-UI flakiness. It is not the
product, and it is deliberately not good software.

To reproduce a specific race:

```bash
SENTRA_CHAOS=<seed> npm run dev   # 🚧 M4 · #47
```

Seeded latency injection makes a particular interleaving reproducible, which is how the
optimistic-update race is captured for the dataset rather than waited for.

## Where things end up

| File                       | Written by                  | Committed?                                |
| -------------------------- | --------------------------- | ----------------------------------------- |
| `results.json`             | the test run                | no                                        |
| `analysis.json`            | `flakemetry:analyze`        | no                                        |
| `report.md`                | `agents:analyze`            | no                                        |
| `otel-spans.json`          | the agents' instrumentation | no                                        |
| `eval/report.md`           | `npm run eval`              | **yes** — a regression shows up as a diff |
| `.flakemetry/history.json` | CI, on `main` only          | no — lives in the CI cache                |

## Common questions

**Why did nothing get posted on my pull request?** Either the run had no failures — the agent stage
short-circuits and posts nothing — or the PR is from a fork, in which case there is no API key and
the pipeline degrades to baseline-heuristic output. Both cases are stated in the run log.

**Why is the classification wrong?** Sometimes it will be. The error rate is measured and
published. See [Limitations and Guardrails](Limitations-and-Guardrails).

More: [FAQ](FAQ).
