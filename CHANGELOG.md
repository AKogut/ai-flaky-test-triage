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

### Features

- **agents:** add Classification, RootCause and FixSuggestion schemas ([#106](https://github.com/AKogut/ai-flaky-test-triage/pull/106))
- **ci:** define the npm script contract ([#98](https://github.com/AKogut/ai-flaky-test-triage/pull/98))
- **dataset:** add the golden-dataset fixture and label format ([#107](https://github.com/AKogut/ai-flaky-test-triage/pull/107))
- **dataset:** add the golden-dataset hygiene lint ([#115](https://github.com/AKogut/ai-flaky-test-triage/pull/115))
- **dataset:** author the 10 hard-quadrant fixtures ([#111](https://github.com/AKogut/ai-flaky-test-triage/pull/111))
- **dataset:** author the 15 baseline golden-dataset fixtures ([#109](https://github.com/AKogut/ai-flaky-test-triage/pull/109))
- **dataset:** author the 8 adversarial fixtures ([#114](https://github.com/AKogut/ai-flaky-test-triage/pull/114))
- **eval:** add TestRun domain types and Zod schemas ([#102](https://github.com/AKogut/ai-flaky-test-triage/pull/102))
- **eval:** add the non-LLM baseline classifier ([#110](https://github.com/AKogut/ai-flaky-test-triage/pull/110))
- **eval:** normalise Playwright JSON reporter output ([#103](https://github.com/AKogut/ai-flaky-test-triage/pull/103))
- **eval:** normalise Vitest JSON reporter output ([#104](https://github.com/AKogut/ai-flaky-test-triage/pull/104))
- **flakemetry:** add FlakySignal and analysis.json schemas ([#105](https://github.com/AKogut/ai-flaky-test-triage/pull/105))
- **release:** generate the changelog from Conventional Commits ([#100](https://github.com/AKogut/ai-flaky-test-triage/pull/100))

### Fixes

- **docs:** stop the wiki claiming unbuilt commands work ([#120](https://github.com/AKogut/ai-flaky-test-triage/pull/120))
- **eval:** stop the baseline reading documentation as product source ([#113](https://github.com/AKogut/ai-flaky-test-triage/pull/113))

### Documentation

- add architecture, taxonomy, evaluation methodology and ADRs ([cac77dc](https://github.com/AKogut/ai-flaky-test-triage/commit/cac77dcee2b2df2e4e6329e93df80dd2a066a5d7))
- add wiki source pages and publish script ([98dccc8](https://github.com/AKogut/ai-flaky-test-triage/commit/98dccc82265c4dd5fbf128d6838126320082d63a))
- derive the README status banner from ROADMAP.md ([#101](https://github.com/AKogut/ai-flaky-test-triage/pull/101))

### Tests

- **eval:** pin the reporter contract to committed real output ([#108](https://github.com/AKogut/ai-flaky-test-triage/pull/108))

<!-- changelog:end -->

---

Pre-1.0, the public surface is the CLI script contract and the `analysis.json` and fixture schemas.
Progress before `v1.0.0` is tracked as milestones rather than releases — see
[`ROADMAP.md`](ROADMAP.md).
