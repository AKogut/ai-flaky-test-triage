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

- **ci:** define the npm script contract ([#98](https://github.com/AKogut/ai-flaky-test-triage/pull/98))

### Documentation

- add architecture, taxonomy, evaluation methodology and ADRs ([cac77dc](https://github.com/AKogut/ai-flaky-test-triage/commit/cac77dcee2b2df2e4e6329e93df80dd2a066a5d7))
- add wiki source pages and publish script ([98dccc8](https://github.com/AKogut/ai-flaky-test-triage/commit/98dccc82265c4dd5fbf128d6838126320082d63a))
<!-- changelog:end -->

---

Pre-1.0, the public surface is the CLI script contract and the `analysis.json` and fixture schemas.
Progress before `v1.0.0` is tracked as milestones rather than releases — see
[`ROADMAP.md`](ROADMAP.md).
