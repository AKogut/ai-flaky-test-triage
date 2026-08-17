# Golden dataset

Hand-labelled fixtures. Every metric this project publishes is computed against these files.

Each fixture is two documents:

| File                | Holds                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| `<name>.run.json`   | What a classifier sees. Contains nothing about the answer.                     |
| `<name>.labels.json` | Ground truth, the ordered rule that decided it, and the argument for the label. |

They are separate files, loaded by separate functions returning separate types, so feeding the
answer to a classifier requires deciding to do it rather than forgetting not to.

## Authoring

**Label first, then write the payload.** Writing the payload first invites shaping the evidence to
fit a label already in mind.

1. Apply the ordered rules in [`docs/taxonomy.md`](../../docs/taxonomy.md); the first that fires
   decides. Record which one in `ruleApplied`.
2. Write a `justification` that addresses the tempting alternative, not just the verdict. The
   80-character floor exists because a one-line justification almost always means the label was not
   really reasoned about.
3. Keep ground-truth vocabulary out of the payload — `scenario`, test titles, error text, filenames.
   The schema catches structural leakage; only the hygiene lint catches it in prose.
4. Mark genuinely arguable cases `lowConfidenceGroundTruth: true`. They are excluded from headline
   metrics and reported separately rather than quietly resolved in the project's favour.

Use the [dataset fixture issue template](https://github.com/AKogut/ai-flaky-test-triage/issues/new/choose).

## Capturing from a real run

```sh
# Everything that failed, from a directory of reports collected over several runs.
npm run capture -- --history <dir> --all

# One test, from a single report.
npm run capture -- --report results.json --test "part of the title"
```

It writes **payloads only**, and the four steps it prints afterwards are the work: replace the
scenario, trim the source, apply the ordered rules by hand, and regenerate. A tool that guessed a
label would turn the dataset into a record of what the pipeline already believes.

CI keeps every run's report as an artifact for fourteen days, so the input is a download:

```sh
gh run download <run-id> -n test-results -D runs/<n>
```

Name the directories so they sort in run order — the command reads the number in the filename — and
point `--history` at the collection. The signal comes out of what those runs actually did, and it
stops at the run being captured: a history that continued past the failure would describe a future
the classifier could not have seen.

## Captured fixtures

A fixture is `captured` when its `subject.result` came out of a real run rather than out of
somebody's imagination. Three rules apply to them, and each exists because of something that went
wrong the first time one was made.

**Paths are relative to the checkout, everywhere — including inside the error.** Playwright
relativises `file` and nothing else; the stack, the snippet and the message keep the absolute path
of the machine that ran the suite. That path reaches a prompt, then a public pull-request comment,
and it makes a fixture specific to whoever captured it. `normalisePlaywrightReport` strips it when
given a `repositoryRoot`, and `npm run test:e2e` gives it one.

**Test sources are captured without their comments, and the lines around an assertion carry none.**
A comment in a spec is the author's argument about the failure, and the author knew the answer.
Keeping them in `testSource` would hand a classifier the label in prose that no word list can catch
— and the same applies to `error.snippet`, which quotes the few lines around the failure. That one
cannot be stripped: in production the agent really does see whatever comments are there, and a
fixture cleaned of them would be easier than the input the pipeline gets. So the fix is at the
source. A deliberately flaky spec explains itself in its file header, which nothing captures, and
keeps the lines beside its assertions plain.

**A spec is named after the behaviour it covers, never after the defect it demonstrates.** The file
path is part of what a classifier sees. A spec called `reorder-race.spec.ts` gives the answer away,
and a model that gets it right from the filename has learned nothing that generalises.

**Every derived field is one production could have produced.** `flakinessScore` and
`consecutiveFailures` are computed from the fixture's own `statusHistory` by the same functions
`flakemetry-lib` uses, and `eval:lint` fails if a committed fixture disagrees with them.

That check exists because the alternative had already happened. Before the scoring function existed
(#58), synthetic fixtures carried hand-picked scores: two fixtures with the identical history
`PPPPPPPFFF` carried `0.03` and `0.29`, which no definition produces both of. A dataset scored by a
rule production does not use measures the fixtures rather than the classifier.

**And a run the reporters could have produced.** `eval:lint` also fails when a fixture's
`statusHistory` does not end with the run being triaged, or when it claims the run passed on a later
attempt while recording the run as failed.

The second of those had happened four times, all in the hard quadrant. `flakyWithinRun` is derived
from the final attempt having succeeded, so `failed` beside "passed on a later attempt: yes" is not
a rare combination but an impossible one — and the context bundle renders both facts a line apart,
so the classifier was being handed a contradiction on the cases the dataset is hardest on. Their
justifications had said "which is why the retry passed" all along; the status was what disagreed.

**A fixture whose run ended green is still a fixture.** A test that only got there on a retry is
selected for triage by its own clause in `selectForTriage`, and it is the clearest intermittency
evidence a single run can carry — the alternation happened where the pass/fail sequence cannot show
it.

## Target composition

Shares are specified in [`docs/eval-methodology.md`](../../docs/eval-methodology.md). The dataset is
deliberately weighted towards cases that defeat the obvious shortcuts, so a high headline number
cannot be produced purely by easy fixtures.
