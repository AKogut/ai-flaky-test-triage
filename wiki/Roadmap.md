# Roadmap

> Machine-readable version with exit criteria:
> [`ROADMAP.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/ROADMAP.md) ·
> Live status: [Milestones](https://github.com/AKogut/ai-flaky-test-triage/milestones)

## The ordering decision

The natural order is: build the app, write tests, make some flaky, then build the AI layer on their
output. It follows the data flow and feels right.

It is the wrong order for two reasons. The least differentiated part of the project — a small CRUD
app with drag-and-drop — is also the most time-consuming, and it sits in front of everything that
carries value. Worse, it defers the only question that can invalidate the whole thing: *can a model
classify these failures better than a thirty-line heuristic?* Learning the answer after a week of
React work is the expensive way to learn it.

So the evaluation harness and a measurable classifier land first. Fixtures are hand-authored JSON
and need no application to exist. The app arrives at M4 and its job is then to *extend* the dataset
with real captured runs rather than to bootstrap it.

[ADR-0003](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0003-dataset-first-milestone-ordering.md)

## Milestones

Each has one exit criterion. A milestone is not done because its issues are closed; it is done when
the criterion holds.

| | Theme | Exit criterion |
|---|---|---|
| **M0** | Foundations & repository hygiene | `npm ci && npm run lint && npm run typecheck` passes on a clean clone, enforced in CI |
| **M1** | Contracts, schemas & taxonomy | Every pipeline artifact has a Zod schema, an inferred type, and a round-trip test |
| **M2** | Golden dataset, baseline & eval | `npm run eval` scores the baseline on ≥30 labelled fixtures with intervals and confusion matrices — **no model involved** |
| **M3** | Triage agent & replay mode | The agent beats the baseline by a margin surviving its interval — or the finding that it does not is in the README. `npm run demo` works with no key. |
| **M4** | TaskFlow application | `npm run dev` serves a task board; `SENTRA_CHAOS=<seed>` reproduces a specific race interleaving |
| **M5** | Test suite & emergent flakiness | ≥10 `captured` fixtures from real CI runs; metrics broken down by provenance |
| **M6** | flakemetry-lib integration | History survives across runs on `main`; a cache miss degrades gracefully; both tested |
| **M7** | Root-cause & fix-suggestion agents | `npm run agents:analyze` turns a fixture into a report, asserted by an integration test in replay mode |
| **M8** | End-to-end CI & PR comment | A PR touching a flaky spec produces exactly one comment; pushing again updates it |
| **M9** | Observability, ablation & cost | `eval/ablation.md` reports every variant; at least one context field is justified by the numbers or removed because of them |
| **M10** | Documentation, wiki & v1.0 | The Definition of Done holds on a clean clone; `v1.0.0` tagged with eval numbers in the release notes |

## The milestone that decides the project

**M3.** It is where the first honest comparison against the baseline gets published, and it is the
point of maximum temptation to tune until the number looks good.

The commitment, made in advance and in writing: if the baseline wins, the README says the baseline
wins. A project that publishes a negative result about its own centrepiece demonstrates something
considerably rarer than a working classifier.

## Deliberately out of scope for v1

- Multi-repository support or any hosted service — [ADR-0001](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0001-single-repo-no-persistent-services.md)
- Auto-fix, auto-merge, or any agent write access — [Limitations and Guardrails](Limitations-and-Guardrails)
- Fine-tuning — the eval harness exists partly to establish whether prompting suffices
- A live dashboard; a static published eval report is a post-1.0 candidate
- Test frameworks beyond Vitest and Playwright

## Open experiments

These may close as *not adopted* — the finding is the deliverable:

- [Does history context earn its place?](https://github.com/AKogut/ai-flaky-test-triage/issues/79)
- [Does a multi-step agent beat a single call on the hard quadrant?](https://github.com/AKogut/ai-flaky-test-triage/issues/80)
- [What does model capability tier actually buy?](https://github.com/AKogut/ai-flaky-test-triage/issues/81)
