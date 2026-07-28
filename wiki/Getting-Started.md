# Getting Started

## Requirements

Node ≥ 22. Nothing else. No Docker, no database, no API key for the default path.

## Clone and run

```bash
git clone https://github.com/AKogut/ai-flaky-test-triage.git
cd ai-flaky-test-triage
npm install
npm run demo
```

`npm run demo` runs the entire pipeline — flakiness analysis, triage, root cause, fix suggestion,
report generation — against a bundled fixture run, using **recorded model responses**. No network
call is made and no credentials are needed.

It finishes in well under a minute and writes a `report.md` that is the same document a real pull
request would receive.

### What replay mode does and does not prove

It proves the pipeline works end to end: parsing, analysis, orchestration, schema validation,
report assembly. It does **not** prove what the model would say today, because the responses were
recorded earlier. The demo says so in its own output rather than implying a live classification
just happened.

Rationale: [ADR-0005](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0005-replay-cassettes-for-credential-free-demo.md).

## Check the classifier's accuracy yourself

```bash
npm run eval
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
npm test          # runs the suite, writes results.json
npm run analyze   # flakemetry + agents, writes report.md
```

`npm test` deliberately includes tests that fail intermittently. That is the point — they are the
input the pipeline exists to interpret. See [Architecture Overview](Architecture-Overview) for what
happens to their output.

## Running the demo application

```bash
npm run dev
```

TaskFlow is a small task board: create, edit, delete, complete, filter, drag-to-reorder. It exists
only to be tested against and to produce realistic asynchronous-UI flakiness. It is not the
product, and it is deliberately not good software.

To reproduce a specific race:

```bash
SENTRA_CHAOS=<seed> npm run dev
```

Seeded latency injection makes a particular interleaving reproducible, which is how the
optimistic-update race is captured for the dataset rather than waited for.

## Where things end up

| File | Written by | Committed? |
|---|---|---|
| `results.json` | the test run | no |
| `analysis.json` | `flakemetry:analyze` | no |
| `report.md` | `agents:analyze` | no |
| `otel-spans.json` | the agents' instrumentation | no |
| `eval/report.md` | `npm run eval` | **yes** — a regression shows up as a diff |
| `.flakemetry/history.json` | CI, on `main` only | no — lives in the CI cache |

## Common questions

**Why did nothing get posted on my pull request?** Either the run had no failures — the agent stage
short-circuits and posts nothing — or the PR is from a fork, in which case there is no API key and
the pipeline degrades to baseline-heuristic output. Both cases are stated in the run log.

**Why is the classification wrong?** Sometimes it will be. The error rate is measured and
published. See [Limitations and Guardrails](Limitations-and-Guardrails).

More: [FAQ](FAQ).
