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
npm run help            # every command, what it does, and whether it exists yet
```

What runs today:

```bash
npm run test:coverage   # the full suite, with the coverage floor enforced
npm run eval            # score the baseline against the golden dataset
npm run eval:lint       # dataset composition and label-leakage check
npm run lint && npm run typecheck
```

And the ones that need a browser or a running application:

```bash
npm run demo            # full pipeline, no API key — writes report.md
npm run dev             # start TaskFlow locally — API + client, Ctrl-C stops both
npm run test:e2e        # Playwright, one TaskFlow per worker — needs `npx playwright install chromium`
npm test                # unit and e2e together
```

Requires Node ≥ 22.13 — the floor ESLint 10 sets, not an arbitrary one. An `ANTHROPIC_API_KEY` is
only needed for live model calls; nothing that works today needs one.

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

## Who can merge, and what happens to an outside PR

Merging requires write access, of which there is exactly one holder. `main` rejects direct pushes,
requires a pull request, and requires five passing checks. An approving review from an account
without write access does not make a pull request mergeable — this is a GitHub setting, not a
house rule, so it cannot drift.

You can still open a pull request from a fork, and it is welcome. Two things to expect:

1. **CI waits for approval.** Workflows on fork pull requests need a maintainer to start them,
   every time. That is deliberately stricter than GitHub's default, which only asks for the first
   one and then lets subsequent runs through — including runs of a workflow file the same pull
   request changed.
2. **No secrets, by design.** Fork pull requests get no `ANTHROPIC_API_KEY`, so the agent stage is
   skipped and the pipeline runs the baseline heuristic instead. The comment says so rather than
   pretending. The reasoning, including why `pull_request_target` is not used, is in
   [ADR-0007](docs/adr/0007-no-github-app-no-pull-request-target.md).

Neither is a judgement about the contribution. Approving a workflow run means reading a diff before
it executes, which is the only point at which reading it helps.

## What a good PR looks like

- Under ~400 changed lines.
- The description says how the change was verified, not just that tests pass.
- New behaviour has a test that would fail without the change.
- If it touches `agents/`, `eval/`, `prompts/`, or `eval/golden-dataset/`, the eval table is
  filled in and the numbers moved in the direction the PR claims.
- Reviewer notes state what you are unsure about.

## Writing tests

The end-to-end suite is the control group for the whole project. Every number in `eval/report.md`
is measured against a dataset built from its runs, so a spec that is a little bit flaky does not
merely fail sometimes — it teaches the classifier that everything is a little bit flaky, and it
makes the deliberately flaky specs indistinguishable from the noise around them.

Four rules, enforced by `tests/unit/e2e-standards.test.ts` rather than left to memory:

- **Web-first assertions.** `expect(locator).toHaveCount(3)` retries until the condition holds.
  `expect(await locator.count()).toBe(3)` samples once and races the application. The two look
  almost identical in a diff.
- **Never wait on the clock.** No `waitForTimeout`, no `setTimeout`. A sleep is a guess about how
  fast a machine is, and CI is not that machine.
- **Locators, not element handles.** `page.$` and `waitForSelector` return an element taken at one
  moment; every assertion built on one races the next render.
- **No dependence on another test.** Each test opens the page itself and starts from the seeded
  database. `tests/e2e/fixtures.ts` makes that the default; opting out is one visible line and is
  reserved for the spec that exists to demonstrate a cross-test leak.

The deliberately flaky specs are held to the same four rules. Their flakiness has to come from the
application, or from a selector choice the header comment explains and defends — never from a sleep
somebody left in, which would make the ground-truth label a guess about the author's intent.

Fault injection belongs at the network boundary (`page.route`), not in the application. A forced
500 is deterministic; the request never reaches the server, so there is nothing to race.

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
npm run eval                     # development slice, baseline → eval/report.md
npm run eval -- --gate           # verify the committed report and apply the thresholds
npm run eval -- --slice=holdout  # the held-out slice — see the budget below
npm run eval:ablation            # 🚧 M9 · #74
```

`--classifier=agent` parses today and then declines: the agent lands in M3 (#35). The command
itself works, only that value does not, which is why it carries no marker above — a 🚧 on a line
beginning `npm run eval` would read as the whole command being unbuilt.

The default is the **development slice**, not the whole dataset. That is the discipline: anything
run habitually must not touch the held-out fixtures, or they stop being held out.

`eval/report.md` and `eval/metrics.json` are committed, so a regression shows up as a diff. `--gate`
is what keeps that true — it regenerates in memory and fails if the committed pair disagrees, then
applies the thresholds in `eval/gate.ts`. Run it before pushing; CI runs the same command.

**The held-out slice has a budget.** Every `--slice=holdout` or `--slice=all` run is appended to
`eval/holdout-log.json`, which is committed. Past three evaluations in 30 days the harness warns.
Iterate against `--slice=dev`; the held-out slice is for confirming a result, not finding one.

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
