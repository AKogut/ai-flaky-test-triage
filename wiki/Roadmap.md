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

Eleven milestones, M0 to M10, run from the foundations and the golden dataset, through the triage
agent, the application and its test suite, to the CI wiring, observability and the release. Each
has one exit criterion. A milestone is not done because its issues are closed; it is done when the
criterion holds. M7 is the proof: every issue in it is closed, and it is not done. M5 was the same
until its tenth fixture captured from CI landed.

Every milestone's theme, status and exit criterion, and what each one in progress is waiting on,
are in [`ROADMAP.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/ROADMAP.md); the
current one is in the status banner on [Home](Home). They are not copied here, because a second copy
of a status is the one that goes stale.

M3 and M7 are short of their criteria for the same reason: nothing here has an `ANTHROPIC_API_KEY`.
The agent, its prompt and the harness exist, and `npm run demo` works with no key — but scoring the
agent and recording the cassettes replay needs both cost money, and nothing has been spent.

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

None has started. Each runs on the ablation harness, `npm run eval:ablation` (#78), and each needs
live model calls. They may close as _not adopted_ — the finding is the deliverable:

- [Does history context earn its place?](https://github.com/AKogut/ai-flaky-test-triage/issues/79)
- [Does a multi-step agent beat a single call on the hard quadrant?](https://github.com/AKogut/ai-flaky-test-triage/issues/80)
- [What does model capability tier actually buy?](https://github.com/AKogut/ai-flaky-test-triage/issues/81)
