# Changelog

Generated from [Conventional Commits](https://www.conventionalcommits.org/) on `main` by
`npm run changelog`. Everything between the markers below is regenerated — edit the commit
messages, not this file.

Release notes on GitHub carry this changelog **plus the headline numbers from `eval/report.md`**.
The version number describes the software; the accuracy figure describes how much to trust it, and
publishing one without the other would be half a release note. See
[`docs/branching-strategy.md`](docs/branching-strategy.md).

Tooling churn (`build`, `ci`, `chore`) is deliberately omitted. Those types are required by
commitlint because a well-formed history needs them, but they are not release notes.

<!-- changelog:start -->

## Unreleased

_No user-facing changes since v0.3.0._

## v0.3.0 — 2026-11-23

### Documentation

- **docs:** a 60-second tour, and the demo as a GIF ([#262](https://github.com/AKogut/ai-flaky-test-triage/pull/262))

## v0.2.0 — 2026-11-23

### Features

- **agents:** the first scored run uses claude-opus-5-5 ([#249](https://github.com/AKogut/ai-flaky-test-triage/pull/249))

### Fixes

- **agents:** a refusal on the PR-comment path really falls back ([#253](https://github.com/AKogut/ai-flaky-test-triage/pull/253))
- **agents:** the report says each finding once ([#255](https://github.com/AKogut/ai-flaky-test-triage/pull/255))
- **agents:** untrusted text is read in linear time, results unchanged ([#259](https://github.com/AKogut/ai-flaky-test-triage/pull/259))
- **tests:** a busy laptop no longer times out what CI passes ([#256](https://github.com/AKogut/ai-flaky-test-triage/pull/256))
- **tests:** the #49 budget is enforced where it was set, on CI ([#258](https://github.com/AKogut/ai-flaky-test-triage/pull/258))

### Documentation

- **docs:** the README screenshot shows the comment as it is posted now ([#257](https://github.com/AKogut/ai-flaky-test-triage/pull/257))
- **docs:** the README shows a comment the pipeline actually posted ([#250](https://github.com/AKogut/ai-flaky-test-triage/pull/250))

## v0.1.0 — 2026-11-23

### Features

- **agents:** a fix suggestion that cannot be applied ([#189](https://github.com/AKogut/ai-flaky-test-triage/pull/189))
- **agents:** a hypothesis, and two refusals that matter more ([#188](https://github.com/AKogut/ai-flaky-test-triage/pull/188))
- **agents:** add cassette record and replay for model calls ([#142](https://github.com/AKogut/ai-flaky-test-triage/pull/142))
- **agents:** add Classification, RootCause and FixSuggestion schemas ([#106](https://github.com/AKogut/ai-flaky-test-triage/pull/106))
- **agents:** add the model client every call goes through ([#140](https://github.com/AKogut/ai-flaky-test-triage/pull/140))
- **agents:** assemble the context bundle, and split it by trust ([#145](https://github.com/AKogut/ai-flaky-test-triage/pull/145))
- **agents:** every way the output got worse, said at the top ([#196](https://github.com/AKogut/ai-flaky-test-triage/pull/196))
- **agents:** fence, cap and scrub untrusted text before it reaches a prompt ([#143](https://github.com/AKogut/ai-flaky-test-triage/pull/143))
- **agents:** git access agents cannot write through ([#186](https://github.com/AKogut/ai-flaky-test-triage/pull/186))
- **agents:** give the classifier the sequence a state leak leaves behind ([#187](https://github.com/AKogut/ai-flaky-test-triage/pull/187))
- **agents:** npm run analyze runs both stages, as the README promised ([#236](https://github.com/AKogut/ai-flaky-test-triage/pull/236))
- **agents:** npm run demo, on a clean clone, with no key ([#149](https://github.com/AKogut/ai-flaky-test-triage/pull/149))
- **agents:** one file written, exit zero, and a report either way ([#192](https://github.com/AKogut/ai-flaky-test-triage/pull/192))
- **agents:** the order the budget is spent in ([#190](https://github.com/AKogut/ai-flaky-test-triage/pull/190))
- **agents:** the report, and the line that stops it being read as truth ([#191](https://github.com/AKogut/ai-flaky-test-triage/pull/191))
- **agents:** the triage agent, and the seam that scores it like the control ([#146](https://github.com/AKogut/ai-flaky-test-triage/pull/146))
- **app:** one dev command for the API and the client ([#161](https://github.com/AKogut/ai-flaky-test-triage/pull/161))
- **ci:** a fork pull request gets verdicts, not a page of gaps ([#199](https://github.com/AKogut/ai-flaky-test-triage/pull/199))
- **ci:** catch cassettes that answer questions nobody asks any more ([#151](https://github.com/AKogut/ai-flaky-test-triage/pull/151))
- **ci:** define the npm script contract ([#98](https://github.com/AKogut/ai-flaky-test-triage/pull/98))
- **client:** drag-to-reorder, and the race it is meant to have ([#159](https://github.com/AKogut/ai-flaky-test-triage/pull/159))
- **client:** filter by status, and the ambiguity it makes possible ([#158](https://github.com/AKogut/ai-flaky-test-triage/pull/158))
- **client:** the task lifecycle, with one optimistic path and no others ([#157](https://github.com/AKogut/ai-flaky-test-triage/pull/157))
- **client:** the task list, and a documented selector policy ([#155](https://github.com/AKogut/ai-flaky-test-triage/pull/155))
- **dataset:** add the golden-dataset fixture and label format ([#107](https://github.com/AKogut/ai-flaky-test-triage/pull/107))
- **dataset:** add the golden-dataset hygiene lint ([#115](https://github.com/AKogut/ai-flaky-test-triage/pull/115))
- **dataset:** author the 10 hard-quadrant fixtures ([#111](https://github.com/AKogut/ai-flaky-test-triage/pull/111))
- **dataset:** author the 15 baseline golden-dataset fixtures ([#109](https://github.com/AKogut/ai-flaky-test-triage/pull/109))
- **dataset:** author the 8 adversarial fixtures ([#114](https://github.com/AKogut/ai-flaky-test-triage/pull/114))
- **dataset:** fixtures captured from CI, and the gap stated in words ([#172](https://github.com/AKogut/ai-flaky-test-triage/pull/172))
- **eval:** add confusion matrices, quadrants and grouped breakdowns ([#131](https://github.com/AKogut/ai-flaky-test-triage/pull/131))
- **eval:** add TestRun domain types and Zod schemas ([#102](https://github.com/AKogut/ai-flaky-test-triage/pull/102))
- **eval:** add the non-LLM baseline classifier ([#110](https://github.com/AKogut/ai-flaky-test-triage/pull/110))
- **eval:** add the run-eval CLI and commit the first report ([#135](https://github.com/AKogut/ai-flaky-test-triage/pull/135))
- **eval:** ask whether the confidence number is worth anything ([#148](https://github.com/AKogut/ai-flaky-test-triage/pull/148))
- **eval:** gate merges on evaluation thresholds ([#138](https://github.com/AKogut/ai-flaky-test-triage/pull/138))
- **eval:** measure the variance instead of pretending it is not there ([#147](https://github.com/AKogut/ai-flaky-test-triage/pull/147))
- **eval:** normalise Playwright JSON reporter output ([#103](https://github.com/AKogut/ai-flaky-test-triage/pull/103))
- **eval:** normalise Vitest JSON reporter output ([#104](https://github.com/AKogut/ai-flaky-test-triage/pull/104))
- **eval:** score classifiers with joint accuracy and Wilson intervals ([#128](https://github.com/AKogut/ai-flaky-test-triage/pull/128))
- **eval:** split the dataset into development and held-out slices ([#137](https://github.com/AKogut/ai-flaky-test-triage/pull/137))
- **flakemetry:** a cache that failed is a warning, not a red pipeline ([#182](https://github.com/AKogut/ai-flaky-test-triage/pull/182))
- **flakemetry:** add FlakySignal and analysis.json schemas ([#105](https://github.com/AKogut/ai-flaky-test-triage/pull/105))
- **flakemetry:** one command from test reports to analysis.json ([#181](https://github.com/AKogut/ai-flaky-test-triage/pull/181))
- **flakemetry:** score how much a test alternates, not how often it fails ([#178](https://github.com/AKogut/ai-flaky-test-triage/pull/178))
- **flakemetry:** the file that carries determinism between two CI jobs ([#176](https://github.com/AKogut/ai-flaky-test-triage/pull/176))
- **otel:** a span per model call, written to otel-spans.json ([#235](https://github.com/AKogut/ai-flaky-test-triage/pull/235))
- **prompts:** give the rubric one copy and make published versions immutable ([#144](https://github.com/AKogut/ai-flaky-test-triage/pull/144))
- **release:** generate the changelog from Conventional Commits ([#100](https://github.com/AKogut/ai-flaky-test-triage/pull/100))
- **server:** reorder by target index, with the race written down ([#154](https://github.com/AKogut/ai-flaky-test-triage/pull/154))
- **server:** seeded latency injection, off unless asked for ([#160](https://github.com/AKogut/ai-flaky-test-triage/pull/160))
- **server:** TaskFlow's API — five routes, one table, no service layer ([#152](https://github.com/AKogut/ai-flaky-test-triage/pull/152))

### Fixes

- **agents:** cover the transport, and stop documenting a parameter that 400s ([#141](https://github.com/AKogut/ai-flaky-test-triage/pull/141))
- **agents:** read the diff in CI, so both classifiers see what changed ([#231](https://github.com/AKogut/ai-flaky-test-triage/pull/231))
- **agents:** the filesystem guardrail covers every agent that exists ([#234](https://github.com/AKogut/ai-flaky-test-triage/pull/234))
- **agents:** the footer said unscored while the baseline was scored ([#229](https://github.com/AKogut/ai-flaky-test-triage/pull/229))
- **agents:** the no-history notice reads as prose, not entity codes ([#237](https://github.com/AKogut/ai-flaky-test-triage/pull/237))
- **app:** npm run dev did not work, and 1378 tests did not notice ([#162](https://github.com/AKogut/ai-flaky-test-triage/pull/162))
- **app:** npm run dev never rendered the page, and the documented race never fired ([#174](https://github.com/AKogut/ai-flaky-test-triage/pull/174))
- **dataset:** four fixtures described a run no reporter can produce ([#179](https://github.com/AKogut/ai-flaky-test-triage/pull/179))
- **deps:** simple-git 4, for advisories 3.36.0 has no patch for ([#208](https://github.com/AKogut/ai-flaky-test-triage/pull/208))
- **docs:** make the repository's claims true again after M3 ([#150](https://github.com/AKogut/ai-flaky-test-triage/pull/150))
- **docs:** say which guardrails are enforced and which are still planned ([#156](https://github.com/AKogut/ai-flaky-test-triage/pull/156))
- **docs:** stop the wiki claiming unbuilt commands work ([#120](https://github.com/AKogut/ai-flaky-test-triage/pull/120))
- **eval:** stop the baseline reading documentation as product source ([#113](https://github.com/AKogut/ai-flaky-test-triage/pull/113))
- **eval:** test the guards nothing was watching, and set a coverage floor ([#139](https://github.com/AKogut/ai-flaky-test-triage/pull/139))
- **eval:** the report and the gate quote today's figures and issues ([#227](https://github.com/AKogut/ai-flaky-test-triage/pull/227))
- **release:** the first release tag no longer empties the changelog ([#246](https://github.com/AKogut/ai-flaky-test-triage/pull/246))
- **tests:** the nested vitest run answers to the hook timeout too ([#245](https://github.com/AKogut/ai-flaky-test-triage/pull/245))

### Documentation

- add architecture, taxonomy, evaluation methodology and ADRs ([cac77dc](https://github.com/AKogut/ai-flaky-test-triage/commit/cac77dcee2b2df2e4e6329e93df80dd2a066a5d7))
- add the social preview and its source ([#211](https://github.com/AKogut/ai-flaky-test-triage/pull/211))
- add wiki source pages and publish script ([98dccc8](https://github.com/AKogut/ai-flaky-test-triage/commit/98dccc82265c4dd5fbf128d6838126320082d63a))
- derive the README status banner from ROADMAP.md ([#101](https://github.com/AKogut/ai-flaky-test-triage/pull/101))
- **ci:** record Evaluation gate as a required check ([#136](https://github.com/AKogut/ai-flaky-test-triage/pull/136))
- **ci:** write down who can merge and gate CI for outside contributors ([#133](https://github.com/AKogut/ai-flaky-test-triage/pull/133))
- **docs:** correct what the wiki says about the flaky specs, before publishing it ([#175](https://github.com/AKogut/ai-flaky-test-triage/pull/175))
- **docs:** describe the system that ships, not the one planned ([#232](https://github.com/AKogut/ai-flaky-test-triage/pull/232))
- **docs:** M6 is done, and the criterion was read out of a job log ([#185](https://github.com/AKogut/ai-flaky-test-triage/pull/185))
- **docs:** M7's nine issues are closed and its criterion is not met ([#195](https://github.com/AKogut/ai-flaky-test-triage/pull/195))
- **docs:** the wiki catches up with what the code does ([#233](https://github.com/AKogut/ai-flaky-test-triage/pull/233))
- **otel:** the docs describe the spans that shipped ([#243](https://github.com/AKogut/ai-flaky-test-triage/pull/243))
- **release:** mark M4 and M5 done, and say where M5 fell short ([#173](https://github.com/AKogut/ai-flaky-test-triage/pull/173))

### Tests

- **agents:** the guardrail section, as tests that would fail ([#193](https://github.com/AKogut/ai-flaky-test-triage/pull/193))
- **agents:** the whole pipeline, end to end, with no network at all ([#194](https://github.com/AKogut/ai-flaky-test-triage/pull/194))
- **e2e:** a deadline that is a guess about a machine ([#170](https://github.com/AKogut/ai-flaky-test-triage/pull/170))
- **e2e:** a row nobody in the file created ([#169](https://github.com/AKogut/ai-flaky-test-triage/pull/169))
- **e2e:** a selector that names two things, and only sometimes ([#167](https://github.com/AKogut/ai-flaky-test-triage/pull/167))
- **e2e:** one TaskFlow per worker, and a report that is checked ([#164](https://github.com/AKogut/ai-flaky-test-triage/pull/164))
- **e2e:** the control group — five flows, written to be beyond reproach ([#165](https://github.com/AKogut/ai-flaky-test-triage/pull/165))
- **e2e:** the spec that is right and fails anyway ([#166](https://github.com/AKogut/ai-flaky-test-triage/pull/166))
- **eval:** pin the reporter contract to committed real output ([#108](https://github.com/AKogut/ai-flaky-test-triage/pull/108))
- **flakemetry:** assert the shape of the signal over twenty-five runs ([#184](https://github.com/AKogut/ai-flaky-test-triage/pull/184))
- **server:** a database per test, and a report the pipeline can read ([#163](https://github.com/AKogut/ai-flaky-test-triage/pull/163))

<!-- changelog:end -->

---

Pre-1.0, the public surface is the CLI script contract and the `analysis.json` and fixture schemas.
Pre-1.0 tags mark points worth pointing at; progress between them is tracked as milestones — see
[`ROADMAP.md`](ROADMAP.md).
