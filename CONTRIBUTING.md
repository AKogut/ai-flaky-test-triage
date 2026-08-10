# Contributing

Thanks for looking. This is primarily a single-maintainer project, but it is structured so that
someone else could pick up any issue and know exactly what "done" means.

## Ground rules

1. **Every change starts as an issue.** One issue → one branch → one squash commit on `main`.
2. **Prompts are code.** A prompt edit is `feat` or `fix`, never `chore`, and it requires an eval
   delta in the PR description.
3. **Numbers before opinions.** "This prompt feels better" is not a reason to merge. Run
   `npm run eval` and paste the table.
4. **Guardrails are structural.** If a change would give an agent write access to anything, it
   needs an ADR before it needs code.

## Setup

```bash
git clone https://github.com/AKogut/ai-flaky-test-triage.git
cd ai-flaky-test-triage
npm install
npm run demo            # full pipeline in replay mode — no API key needed
```

Requires Node ≥ 22.13 — the floor ESLint 10 sets, not an arbitrary one. An `ANTHROPIC_API_KEY` is
only needed for live model calls; everything else,
including the whole test suite, runs in replay mode.

```bash
cp .env.example .env    # optional, for live runs
```

## Workflow

```bash
git switch -c feat/42-triage-agent-schema
# ... work ...
npm run lint && npm run typecheck && npm run test:unit
git commit -m "feat(triage): add two-axis output schema"
git push -u origin feat/42-triage-agent-schema
gh pr create --fill
```

Branch naming, commit format, and the merge strategy are specified in
[`docs/branching-strategy.md`](docs/branching-strategy.md). `commitlint` enforces the commit
format via a Husky hook, so a malformed message fails locally rather than in review.

Open the PR as a **draft** early. CI runs, the eval delta appears, and the work is still cheap to
change.

## What a good PR looks like

- Under ~400 changed lines.
- The description says how the change was verified, not just that tests pass.
- New behaviour has a test that would fail without the change.
- If it touches `agents/`, `eval/`, `prompts/`, or `eval/golden-dataset/`, the eval table is
  filled in and the numbers moved in the direction the PR claims.
- Reviewer notes state what you are unsure about.

## Working on prompts

The highest-leverage and easiest-to-fool area of the project.

- Prompts are versioned files (`prompts/triage.v3.md`). Do not edit a version in place once its
  numbers are recorded in `eval/report.md` — add a new version.
- Iterate against the **development slice** of the dataset. The held-out slice is consulted once,
  at the end, and reported separately. Tuning against held-out data silently destroys the only
  honest number in the project.
- Report the confidence interval, not the point estimate. A 2pp move on 60 fixtures is noise.
- The classification rubric in the prompt is loaded from the same source as the labelling rules in
  `docs/taxonomy.md`. If your change makes them disagree, that is a bug, not a prompt improvement.

## Working on the golden dataset

- Use the **Golden dataset fixture** issue template. Label before writing the fixture.
- Apply the ordered rules in [`docs/taxonomy.md`](docs/taxonomy.md) and record which rule decided
  the label, plus why the tempting alternative is wrong.
- Never let the agent's output influence a label. If the agent's answer changed your mind, the
  labelling rules were ambiguous — fix the rules in a separate PR first.
- Ground-truth terms must not leak into the fixture payload, filename, or test titles. A lint step
  checks this, but it only catches the obvious cases.
- Genuinely arguable cases are welcome — mark them `lowConfidenceGroundTruth: true` and they are
  excluded from headline metrics and reported separately.

## Running the evaluation

```bash
npm run eval                      # full dataset, N=5 samples per fixture
npm run eval -- --slice=dev       # development slice only
npm run eval -- --n=1 --replay    # fast, free, deterministic — for wiring changes
npm run eval:ablation             # context ablation study
```

Results land in `eval/report.md` and `eval/ablation.md`. Both are committed, so a regression shows
up as a diff.

## Reporting a misclassification

The classifier is wrong a measured percentage of the time, and that is documented in
`eval/report.md`. A single wrong classification is expected behaviour, not a bug.

It becomes worth filing when the case represents a **pattern** the dataset does not cover. The
right response is usually a fixture, not a bug report — use the dataset template, and the fix will
be measurable.

## Code of conduct

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Short version: be decent.

## Licence

Contributions are licensed under [MIT](LICENSE).
