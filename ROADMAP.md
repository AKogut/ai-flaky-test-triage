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

**Status:** done

**Exit criterion:** `npm ci && npm run lint && npm run typecheck` passes on a clean clone, and CI
enforces it on every PR.

## M1 — Contracts, schemas & taxonomy

The type boundaries everything else is written against: `TestRun`, `TestResult`, `FlakySignal`,
`Classification`, and the fixture format. Zod schemas at every boundary so a reporter version bump
fails loudly in one file instead of silently three stages downstream.

**Status:** done

**Exit criterion:** every artifact the pipeline reads or writes has a Zod schema, a TypeScript type
inferred from it, and a round-trip test.

## M2 — Golden dataset, baseline & eval harness

The measurement apparatus, built before the thing it measures. Hand-authored adversarial fixtures,
the non-LLM baseline heuristic, metrics with confidence intervals, confusion matrices, and the CI
gate.

**Status:** done

**Exit criterion:** `npm run eval` scores the baseline heuristic on ≥30 labelled fixtures and
writes a report with per-axis accuracy, intervals, and both confusion matrices — with no model
involved.

## M3 — Triage agent & replay mode

The first model call. Structured output, the shared rubric, prompt versioning, cassette
record/replay, calibration measurement, and self-consistency sampling.

**Status:** in progress

**Exit criterion:** the triage agent beats the baseline on joint accuracy by a margin that survives
its confidence interval — or the finding that it does not is documented in the README. Either way,
`npm run demo` runs the classifier end to end with no API key.

## M4 — TaskFlow application

The system under test: React + TypeScript client, Express + SQLite API, task CRUD, status filter,
drag-to-reorder, optimistic updates. Deliberately small. Includes a seedable nondeterminism layer
so flakiness can be _emergent_ rather than scripted.

**Status:** done

**Exit criterion:** `npm run dev` serves a working task board, and `SENTRA_CHAOS=<seed>` reproduces
a specific interleaving of the optimistic-update race. Both hold. The reproduction needed a fix the
milestone did not anticipate: the chaos layer delayed the handler rather than the response, which
reordered the writes and made the server and the client agree on an order neither had been asked
for — a race, but not the documented one. See #52.

## M5 — Test suite & emergent flakiness

Vitest for the API and libraries, Playwright for UI flows, and a set of genuinely flaky specs whose
flakiness comes from real races rather than a `Math.random()` in the test. Captured runs feed the
golden dataset.

**Status:** in progress

**Exit criterion:** ≥10 `captured` fixtures from real CI runs are in the dataset, and eval metrics
are reported broken down by provenance.

**All eight issues are closed and the criterion is not met, so the milestone is not done.** The
second half holds — the report breaks metrics down by provenance and states the synthetic-versus-
captured gap in words. The first does not: there are six captured fixtures, five of them from
genuine CI runs.

The constraint is not tooling — `npm run capture` takes a directory of downloaded reports. It is
that the suite contains six specs that can fail and CI had run it nine times. Reaching ten meant
capturing the same test's failure on several commits, which would have narrowed every interval in
`eval/report.md` without adding a single new piece of information: the specific dishonesty the
methodology exists to prevent.

So the count was left short, #171 tracks it, and the status stays honest. This milestone was marked
done once and corrected during an audit — the rule is that a milestone is done when its criterion
holds, not when its issues close, and marking it done was exactly the drift the rule exists to
catch.

## M6 — flakemetry-lib integration

`analyze()` and the history file: EWMA flakiness scoring, streak tracking, atomic capped writes,
and the CI cache strategy with `main`-only writes.

**Status:** done

**Exit criterion:** history survives across CI runs on `main`, a cache miss degrades gracefully
rather than crashing, and both behaviours have tests.

**Met, and observed rather than argued.** ADR-0004 says GitHub's cache scoping across branches is
subtle enough to need checking by observation, so all three clauses were read out of job logs:

- A `main` run wrote `history-main-32115815984` with 1804 tests. The next `main` run restored it,
  analysed against it, and saved 2 runs' worth — history surviving between two jobs that share
  nothing else. ([run 32116732108](https://github.com/AKogut/ai-flaky-test-triage/actions/runs/32116732108))
- A fresh branch restored `main`'s history through the `history-main-` fallback and did **not**
  write. ([run 32116166714](https://github.com/AKogut/ai-flaky-test-triage/actions/runs/32116166714))
- Before any history existed, a run missed the cache, said so, and produced a full analysis with
  exit 0. ([run 32115147442](https://github.com/AKogut/ai-flaky-test-triage/actions/runs/32115147442))

The observation earned its place: the first log showed the branch key was `history-183/merge-`,
because `github.ref_name` is the merge ref on a pull request. Harmless while only `main` writes,
and a silent trap the moment that is revisited. Fixed in the workflow, the ADR and a test that
asserts one against the other.

## M7 — Root-cause & fix-suggestion agents

The two downstream agents, the orchestrator, budget enforcement, concurrency limiting, partial
failure isolation, and the report writer.

**Status:** in progress

**Exit criterion:** `npm run agents:analyze` turns a fixture `analysis.json` into a `report.md`
whose structure is asserted by an integration test running fully in replay mode.

**All nine issues are closed and the criterion is not met, so the milestone is not done.** The
command exists and does its job: on this repository's own CI it reads `analysis.json`, writes
`report.md`, and posts it as a pull-request comment — the first one the pipeline has ever produced.
An integration test drives it end to end over five scenarios in 216 ms with no network, no key and
no cost.

What is missing is the two words "replay mode". Replay serves recorded cassettes; recording them
needs live model calls; and nothing here has an `ANTHROPIC_API_KEY`. The integration test uses a
scripted transport instead, which buys everything replay would — determinism, zero cost, a run that
cannot touch the network — except real model responses.

Three issues carry the same shortfall and no other: #64 and #65 are complete but for their
cassettes, and #70 for replay. All three become one command each the moment a key exists, which is
also what #38 needs. Nothing has been spent.

## M8 — End-to-end CI & PR comment

Wiring the whole thing together in one workflow, plus the comment upsert, the fork degradation
path, and the truncation notice.

**Status:** planned

**Exit criterion:** a pull request that touches a flaky spec produces exactly one bot comment, and
pushing again updates that comment rather than adding another.

## M9 — Observability, ablation & cost

OpenTelemetry spans to a file exporter, per-run token and cost accounting, and the ablation study
that measures what each context field actually contributes.

**Status:** planned

**Exit criterion:** `eval/ablation.md` reports every variant from
[eval-methodology.md](docs/eval-methodology.md#ablation-study), and at least one context field is
either justified by the numbers or removed because of them.

## M10 — Documentation, wiki & v1.0

The wiki, the README screenshot of a real PR comment, the honest limitations write-up, and the
release.

**Status:** planned

**Exit criterion:** the Definition of Done in the README holds end to end on a clean clone, and
`v1.0.0` is tagged with `eval/report.md` headline numbers in the release notes.

---

## Explicitly out of scope for v1

- Multi-repository support, or any form of hosted service ([ADR-0001](docs/adr/0001-single-repo-no-persistent-services.md))
- Auto-fix, auto-merge, or any agent write access ([guardrails](docs/limitations-and-guardrails.md))
- Fine-tuning
- A live dashboard (a static `gh-pages` eval report is a post-1.0 candidate)
- Support for test frameworks beyond Vitest and Playwright
