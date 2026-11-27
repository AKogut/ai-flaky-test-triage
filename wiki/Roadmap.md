# Roadmap

> Machine-readable version with exit criteria:
> [`ROADMAP.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/ROADMAP.md) ·
> Live status: [Milestones](https://github.com/AKogut/ai-flaky-test-triage/milestones) ·
> Repository: [AKogut/ai-flaky-test-triage](https://github.com/AKogut/ai-flaky-test-triage)

## The ordering decision

The natural order is: build the app, write tests, make some flaky, then build the AI layer on their
output. It follows the data flow and feels right.

It is the wrong order for two reasons. The least differentiated part of the project — a small CRUD
app with drag-and-drop — is also the most time-consuming, and it sits in front of everything that
carries value. Worse, it defers the only question that can invalidate the whole thing: _can a model
classify these failures better than a simple heuristic?_ — today about ninety lines of code.
Learning the answer after a week of React work is the expensive way to learn it.

So the evaluation harness and a measurable classifier land first. Fixtures are hand-authored JSON
and need no application to exist. The app arrives at M4 and its job is then to _extend_ the dataset
with real captured runs rather than to bootstrap it.

[ADR-0003](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0003-dataset-first-milestone-ordering.md)

## Milestones

Each has one exit criterion. A milestone is not done because its issues are closed; it is done when
the criterion holds. M5 and M7 are the proof: every issue in both is closed, and neither is done.

|         | Theme                              | Status                                                  | Exit criterion                                                                                                                                        |
| ------- | ---------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0**  | Foundations & repository hygiene   | done                                                    | `npm ci && npm run lint && npm run typecheck` passes on a clean clone, enforced in CI                                                                 |
| **M1**  | Contracts, schemas & taxonomy      | done                                                    | Every pipeline artifact has a Zod schema, an inferred type, and a round-trip test                                                                     |
| **M2**  | Golden dataset, baseline & eval    | done                                                    | `npm run eval` scores the baseline on ≥30 labelled fixtures with intervals and confusion matrices — **no model involved**                             |
| **M3**  | Triage agent & replay mode         | in progress — the agent waits on an API key (#38)       | The agent beats the baseline by a margin surviving its interval — or the finding that it does not is in the README. `npm run demo` works with no key. |
| **M4**  | TaskFlow application               | done                                                    | `npm run dev` serves a task board; `SENTRA_CHAOS=<seed>` reproduces a specific race interleaving                                                      |
| **M5**  | Test suite & emergent flakiness    | in progress — needs more captured runs (#171)           | ≥10 `captured` fixtures from real CI runs; metrics broken down by provenance                                                                          |
| **M6**  | flakemetry-lib integration         | done                                                    | History survives across runs on `main`; a cache miss degrades gracefully; both tested                                                                 |
| **M7**  | Root-cause & fix-suggestion agents | in progress — replay cassettes wait on an API key       | `npm run agents:analyze` turns a fixture into a report, asserted by an integration test in replay mode                                                |
| **M8**  | End-to-end CI & PR comment         | in progress — the verification pull request (#75)       | A PR touching a flaky spec produces exactly one comment; pushing again updates it                                                                     |
| **M9**  | Observability, ablation & cost     | in progress — tracing landing (#76); ablation not built | `eval/ablation.md` reports every variant; at least one context field is justified by the numbers or removed because of them                           |
| **M10** | Documentation, wiki & v1.0         | planned                                                 | The Definition of Done holds on a clean clone; `v1.0.0` tagged with eval numbers in the release notes                                                 |

M3 and M7 are short of their criteria for the same reason: nothing here has an `ANTHROPIC_API_KEY`.
The agent, its prompt and the harness exist, and `npm run demo` works with no key — but scoring the
agent and recording the cassettes replay needs both cost money, and nothing has been spent. M5 is
short because the suite's few failing specs have not yet produced ten genuinely different captured
runs, and capturing the same failure twice would narrow intervals without adding information.

## The milestone that decides the project

**M3.** It is where the first honest comparison against the baseline gets published, and it is the
point of maximum temptation to tune until the number looks good. That comparison (#38) is deferred
until an API key exists; until then the only published numbers are the baseline's.

The commitment, made in advance and in writing, stands: if the baseline wins, the README says the
baseline wins. A project that publishes a negative result about its own centrepiece demonstrates something
considerably rarer than a working classifier.

## Deliberately out of scope for v1

- Multi-repository support or any hosted service — [ADR-0001](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0001-single-repo-no-persistent-services.md)
- Auto-fix, auto-merge, or any agent write access — [Limitations and Guardrails](Limitations-and-Guardrails)
- Fine-tuning — the eval harness exists partly to establish whether prompting suffices
- A live dashboard; a static published eval report is a post-1.0 candidate
- Test frameworks beyond Vitest and Playwright

## Open experiments

None has started: each needs the ablation harness (🚧 M9, #78) and live model calls. They may
close as _not adopted_ — the finding is the deliverable:

- [Does history context earn its place?](https://github.com/AKogut/ai-flaky-test-triage/issues/79)
- [Does a multi-step agent beat a single call on the hard quadrant?](https://github.com/AKogut/ai-flaky-test-triage/issues/80)
- [What does model capability tier actually buy?](https://github.com/AKogut/ai-flaky-test-triage/issues/81)
