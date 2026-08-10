# Roadmap

Eleven milestones. Ordering is **dataset-first** ([ADR-0003](docs/adr/0003-dataset-first-milestone-ordering.md)):
the evaluation harness and a measurable classifier land before the demo application, so the
project's central claim is tested before time goes into UI work.

Each milestone has an **exit criterion** — a single checkable statement. A milestone is not done
because its issues are closed; it is done when the criterion holds.

Live status: [Milestones](https://github.com/AKogut/ai-flaky-test-triage/milestones) ·
[Issues](https://github.com/AKogut/ai-flaky-test-triage/issues)

---

## M0 — Foundations & repository hygiene

Tooling that makes every later milestone cheaper: TypeScript project references, ESLint flat
config, Prettier, Husky, commitlint, the npm workspace layout, and the CI skeleton.

**Exit criterion:** `npm ci && npm run lint && npm run typecheck` passes on a clean clone, and CI
enforces it on every PR.

## M1 — Contracts, schemas & taxonomy

The type boundaries everything else is written against: `TestRun`, `TestResult`, `FlakySignal`,
`Classification`, and the fixture format. Zod schemas at every boundary so a reporter version bump
fails loudly in one file instead of silently three stages downstream.

**Exit criterion:** every artifact the pipeline reads or writes has a Zod schema, a TypeScript type
inferred from it, and a round-trip test.

## M2 — Golden dataset, baseline & eval harness

The measurement apparatus, built before the thing it measures. Hand-authored adversarial fixtures,
the non-LLM baseline heuristic, metrics with confidence intervals, confusion matrices, and the CI
gate.

**Exit criterion:** `npm run eval` scores the baseline heuristic on ≥30 labelled fixtures and
writes a report with per-axis accuracy, intervals, and both confusion matrices — with no model
involved.

## M3 — Triage agent & replay mode

The first model call. Structured output, the shared rubric, prompt versioning, cassette
record/replay, calibration measurement, and self-consistency sampling.

**Exit criterion:** the triage agent beats the baseline on joint accuracy by a margin that survives
its confidence interval — or the finding that it does not is documented in the README. Either way,
`npm run demo` runs the classifier end to end with no API key.

## M4 — TaskFlow application

The system under test: React + TypeScript client, Express + SQLite API, task CRUD, status filter,
drag-to-reorder, optimistic updates. Deliberately small. Includes a seedable nondeterminism layer
so flakiness can be _emergent_ rather than scripted.

**Exit criterion:** `npm run dev` serves a working task board, and `SENTRA_CHAOS=<seed>` reproduces
a specific interleaving of the optimistic-update race.

## M5 — Test suite & emergent flakiness

Vitest for the API and libraries, Playwright for UI flows, and a set of genuinely flaky specs whose
flakiness comes from real races rather than a `Math.random()` in the test. Captured runs feed the
golden dataset.

**Exit criterion:** ≥10 `captured` fixtures from real CI runs are in the dataset, and eval metrics
are reported broken down by provenance.

## M6 — flakemetry-lib integration

`analyze()` and the history file: EWMA flakiness scoring, streak tracking, atomic capped writes,
and the CI cache strategy with `main`-only writes.

**Exit criterion:** history survives across CI runs on `main`, a cache miss degrades gracefully
rather than crashing, and both behaviours have tests.

## M7 — Root-cause & fix-suggestion agents

The two downstream agents, the orchestrator, budget enforcement, concurrency limiting, partial
failure isolation, and the report writer.

**Exit criterion:** `npm run agents:analyze` turns a fixture `analysis.json` into a `report.md`
whose structure is asserted by an integration test running fully in replay mode.

## M8 — End-to-end CI & PR comment

Wiring the whole thing together in one workflow, plus the comment upsert, the fork degradation
path, and the truncation notice.

**Exit criterion:** a pull request that touches a flaky spec produces exactly one bot comment, and
pushing again updates that comment rather than adding another.

## M9 — Observability, ablation & cost

OpenTelemetry spans to a file exporter, per-run token and cost accounting, and the ablation study
that measures what each context field actually contributes.

**Exit criterion:** `eval/ablation.md` reports every variant from
[eval-methodology.md](docs/eval-methodology.md#ablation-study), and at least one context field is
either justified by the numbers or removed because of them.

## M10 — Documentation, wiki & v1.0

The wiki, the README screenshot of a real PR comment, the honest limitations write-up, and the
release.

**Exit criterion:** the Definition of Done in the README holds end to end on a clean clone, and
`v1.0.0` is tagged with `eval/report.md` headline numbers in the release notes.

---

## Explicitly out of scope for v1

- Multi-repository support, or any form of hosted service ([ADR-0001](docs/adr/0001-single-repo-no-persistent-services.md))
- Auto-fix, auto-merge, or any agent write access ([guardrails](docs/limitations-and-guardrails.md))
- Fine-tuning
- A live dashboard (a static `gh-pages` eval report is a post-1.0 candidate)
- Support for test frameworks beyond Vitest and Playwright
