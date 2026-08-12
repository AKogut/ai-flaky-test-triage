# Architecture

## Design constraint that shapes everything

**Nothing runs persistently.** Every component is a function invoked by a CLI script that exits.
State between runs is a file — carried by the CI cache, an artifact, or a commit to an orphan
branch. There is no server, no queue, no listener, no hosted database.

This is not a simplification for its own sake. A triage system that only ever runs once per CI
job has no reason to be a service, and making it one would add an availability problem, a
deployment problem, and a credentials problem to a system whose entire job takes eleven seconds.
The constraint also produces the strongest property of the project: a reviewer can clone it and
run the whole thing.

## Component map

```mermaid
flowchart LR
    subgraph sut["System under test"]
        APP["TaskFlow<br/>React + Express + SQLite"]
        TESTS["Vitest + Playwright"]
    end

    subgraph pipeline["Analysis pipeline"]
        FM["flakemetry-lib"]
        TRIAGE["Triage agent"]
        RC["Root-cause agent"]
        FIX["Fix-suggestion agent"]
        REPORT["Report writer"]
    end

    subgraph harness["Quality harness"]
        DATASET["Golden dataset"]
        BASELINE["Baseline heuristic"]
        METRICS["Metrics + calibration"]
    end

    APP --> TESTS
    TESTS -->|results.json| FM
    FM -->|analysis.json| TRIAGE
    TRIAGE -->|app_code + confident| RC
    RC --> FIX
    TRIAGE --> REPORT
    RC --> REPORT
    FIX --> REPORT

    DATASET --> TRIAGE
    DATASET --> BASELINE
    TRIAGE --> METRICS
    BASELINE --> METRICS
```

## Data flow, stage by stage

### 1. Test execution → `results.json`

Playwright's JSON reporter and Vitest's JSON reporter emit different shapes. Both are normalised
into a single internal `TestRun` type at the boundary, defined in the `contracts/` workspace. The normaliser is the _only_ place that
knows about reporter-specific fields, so a Playwright major bump breaks one file, loudly, with a
Zod error — not silently, three stages downstream.

```ts
type TestRun = {
  runId: string
  commitSha: string
  branch: string
  startedAt: string // ISO 8601
  durationMs: number
  results: TestResult[]
}

type TestResult = {
  testId: string // stable: file path + full title
  title: string
  file: string
  status: 'passed' | 'failed' | 'timedOut' | 'skipped'
  attempts: number
  durationMs: number
  error?: { message: string; stack?: string; snippet?: string }
  annotations?: string[]
}
```

### 2. `results.json` + history → `analysis.json`

`flakemetry-lib` merges the current run against `.flakemetry/history.json` and emits per-test
signal:

```ts
type FlakySignal = {
  testId: string
  flakinessScore: number // 0..1, EWMA of pass/fail alternation
  consecutiveFailures: number
  totalRuns: number
  firstSeenAt: string
  lastPassedAt: string | null
  statusHistory: string // e.g. "PPPFPFPPF" — most recent last
  isNew: boolean // first run in which this test exists
}
```

History is capped (last N runs per test, N configurable) so the file cannot grow without bound.
Writes are atomic (write temp, rename) so an interrupted job cannot leave a truncated file.

### 3. `analysis.json` → agent inputs

For each failing or newly-flaky test the orchestrator assembles a **context bundle**:

| Field                                        | Source         | Why the agent needs it                               |
| -------------------------------------------- | -------------- | ---------------------------------------------------- |
| Error message + stack                        | test report    | primary evidence                                     |
| Code snippet at failure                      | test report    | distinguishes assertion from infrastructure failure  |
| Flakiness score + status history             | flakemetry-lib | separates deterministic from intermittent            |
| `isNew`, `consecutiveFailures`               | flakemetry-lib | a brand-new always-failing test is a different story |
| Diff of files touched in this commit         | `simple-git`   | separates app regression from test drift             |
| Whether the diff touches the file under test | derived        | the single strongest heuristic signal                |
| Test source                                  | filesystem     | detects missing waits, shared state                  |

`agents/context.ts` assembles it, and three things about how are load-bearing.

**It is pure** — no filesystem, no git, no network; callers read paths and pass the contents in —
which is what makes it unit-testable without a repository and what makes the ablation study cheap:
removing a context field is removing an option, not rewiring a pipeline. Enforced by lint, and the
lint is itself tested by feeding it a violation.

**It splits the bundle by trust rather than by convenience.** Numbers this pipeline computed —
flakiness, streaks, retries, and whether the diff touched the code under test — are stated plainly,
because a contributor cannot forge them. Every string that came out of the repository goes through
`agents/sanitise.ts` and is fenced as data. The prompt says which half is which, so the model has
somewhere to stand when the prose and the numbers disagree.

**Whether the diff touches the code under test** is derived from the stack trace first — the
application frames the failure passed through — and from the `Board.spec.ts` → `Board.ts` naming
convention second. The convention is the fallback rather than the rule because it is a convention;
it earns its place by carrying the signal in the case the stack cannot, a locator timeout with no
application frame at all, which is exactly when the answer matters most. Path comparison is
suffix-on-a-segment-boundary: reporters emit absolute paths while diff headers are
repository-relative, so equality would make the strongest signal in the bundle silently always
false.

Per [ADR-0006](adr/0006-single-shot-agents-no-loop.md) there is no loop in which a model can go
and find what it was not given, so the ceiling on classifier accuracy is set here rather than in
the prompt.

### 4. Agents → `report.md`

Three single-shot LLM calls, described in [agent-design.md](agent-design.md). No loop, no
scratchpad, no tool use beyond the structured-output schema. The orchestrator handles fan-out,
concurrency limit, token budget, retries, and partial failure.

### 5. `report.md` → PR comment

A workflow step reads the file and calls `actions/github-script`. Comments are **upserted**: the
step looks for a previous comment carrying a hidden marker (`<!-- sentra:report -->`) and edits
it in place instead of appending a new one on every push.

## State between runs

| What                   | Where                                                             | Why                                                    |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| Test-run history       | `actions/cache` keyed on branch, restore-key falls back to `main` | Survives across runs; cache is keyed, unlike artifacts |
| Golden dataset         | Committed to the repo                                             | It is source, not state                                |
| Recorded LLM cassettes | Committed under `agents/replay/cassettes/`                        | Makes the demo reproducible                            |
| Eval baseline scores   | Committed to `eval/report.md`                                     | Regressions become visible in the diff                 |
| OTel spans             | Job artifact                                                      | Diagnostic only, disposable                            |

**Concurrency hazard:** two PR runs finishing at once both read the same history and both write.
The loser's update is lost. Mitigations, in order of preference: (a) only the `main` branch job
writes history, PR jobs read-only; (b) merge-on-write rather than overwrite; (c) accept it and
document it. Option (a) is the plan — see ADR-0004.

## Failure modes and degradation

The pipeline never fails the build because of its own problems. It degrades:

| Failure                | Behaviour                                                                  |
| ---------------------- | -------------------------------------------------------------------------- |
| No API key (fork PR)   | Baseline heuristic only, comment states it                                 |
| API error / rate limit | Retry with backoff; on exhaustion, that test is reported `unclassified`    |
| Token budget exceeded  | Stop fanning out, report what was classified, note the truncation          |
| No history file        | Treat every test as `isNew`, reduce confidence in intermittency judgements |
| Malformed test report  | Zod error, pipeline step fails loudly — this one _should_ be noisy         |
| Zero failures          | Skip the agent stage entirely, post nothing                                |

## What is deliberately not here

- **No agent loop.** Classification is a single decision with a fixed input. An agentic loop
  would add latency, cost, and non-determinism for no measured gain. If ablation shows a
  multi-step agent beats a single call, that becomes an ADR and a milestone — not a default.
- **No vector store.** History is a few hundred rows of structured data. It is a JSON file.
- **No fine-tuning.** The eval harness exists partly to prove whether prompting is sufficient.
- **No cross-repo service.** Generalising this to arbitrary repositories is a different project
  with a different set of problems (auth, multi-tenancy, data retention).
