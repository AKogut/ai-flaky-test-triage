# Contributing

> Full guide, including setup and the prompt-iteration rules:
> [`CONTRIBUTING.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/CONTRIBUTING.md).

## Ground rules

1. **Every change starts as an issue.** One issue → one branch → one squash commit.
2. **Prompts are code.** A prompt edit is `feat` or `fix`, never `chore`, and it needs an evaluation
   delta in the pull-request description.
3. **Numbers before opinions.** "This prompt feels better" is not a reason to merge. Run
   `npm run eval` and paste the table.
4. **Guardrails are structural.** A change that would give an agent write access needs an ADR before
   it needs code.

## Setup

```bash
git clone https://github.com/AKogut/ai-flaky-test-triage.git
cd ai-flaky-test-triage
npm install
npm run help            # every command, and whether it exists yet
npm run test:coverage   # the full suite, with the coverage floor enforced
npm run eval            # score the baseline against the golden dataset
npm run demo            # 🚧 M3 · #39 — full pipeline in replay mode
```

Node ≥ 22.13. A key is only required for live model calls, and nothing that works today needs one.

## Who can merge, and what happens to an outside pull request

Merging requires write access, of which there is exactly one holder. `main` rejects direct pushes,
requires a pull request, and requires five passing checks. An approving review from an account
without write access does not make a pull request mergeable — a GitHub setting rather than a house
rule, so it cannot drift.

Pull requests from a fork are welcome. Two things to expect:

1. **CI waits for approval.** Workflows on fork pull requests need a maintainer to start them,
   every time — deliberately stricter than GitHub's default, which asks only for the first and then
   lets later runs through, including runs of a workflow file the same pull request changed.
2. **No secrets, by design.** Fork pull requests receive no API key, so the agent stage is skipped
   and the baseline heuristic runs instead. The comment says so rather than pretending. See
   [Decision Records](Decision-Records) — ADR-0007.

Neither is a judgement about the contribution. Approving a run means reading the diff before it
executes, which is the only moment at which reading it helps.

## Picking something up

Issues are labelled by `type:`, `area:`, `priority:` and `status:`, and grouped into
[milestones](https://github.com/AKogut/ai-flaky-test-triage/milestones). Anything labelled
`status: ready` has acceptance criteria clear enough to start on without asking questions.

[`good first issue`](https://github.com/AKogut/ai-flaky-test-triage/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
marks self-contained work that needs little surrounding context.

## Working on prompts

The highest-leverage and easiest-to-fool area of the project.

- Prompts are versioned files. Once a version's numbers are recorded in `eval/report.md`, do not
  edit it in place — add a new version, or the link between a number and the thing that produced it
  is gone.
- Iterate against the **development slice**. The held-out slice is consulted once, at the end, and
  reported separately. Tuning against held-out data destroys the only honest number in the project.
- Report intervals, not point estimates. A 2pp move on 60 fixtures is noise.
- The rubric in the prompt and the labelling rules in `docs/taxonomy.md` come from one source. If a
  change makes them disagree, that is a bug, not an improvement.

## Working on the golden dataset

Use the **Golden dataset fixture** issue template, and **label before writing the fixture**.

- Apply the ordered rules in
  [`docs/taxonomy.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/taxonomy.md) and
  record which rule decided it, plus why the tempting alternative is wrong.
- Never let the agent's output influence a label. If its answer changed your mind, the rules were
  ambiguous — fix the rules in a separate pull request first.
- Ground-truth terms must not leak into payloads, filenames, or test titles. A lint step checks the
  obvious cases.
- Genuinely arguable cases are welcome. Mark them `lowConfidenceGroundTruth` and they are excluded
  from headline metrics and reported separately.

Contributing a fixture is often more valuable than contributing code, because it makes a whole class
of failure measurable rather than anecdotal.

## Reporting a misclassification

The classifier is wrong a measured percentage of the time, and that is published. A single wrong
classification is expected behaviour, not a bug.

It becomes worth reporting when it represents a **pattern** the dataset does not cover — and the
right response is usually a fixture rather than a bug report, because a fixture makes the fix
measurable.

## What a good pull request looks like

- Under ~400 changed lines
- Says how the change was verified, not that tests pass
- New behaviour has a test that would fail without the change
- Evaluation table filled in for anything touching `agents/`, `eval/`, `prompts/`, or the dataset
- Reviewer notes stating what you are unsure about

## Conduct

[Code of Conduct](https://github.com/AKogut/ai-flaky-test-triage/blob/main/CODE_OF_CONDUCT.md).
Short version: be decent, critique ideas rather than people, and settle disagreements about the
classifier with numbers — which is what the harness is for.
