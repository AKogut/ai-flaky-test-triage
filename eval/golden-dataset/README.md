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

One value is provisional. `flakinessScore` is specified as an EWMA of pass/fail alternation and the
implementation lands with `flakemetry-lib` in M6 (#57); until then a captured fixture records the
plain alternation rate over its observed history — the share of adjacent runs that differ. It will
be recomputed when the real definition exists, in the same commit that introduces it.

## Target composition

Shares are specified in [`docs/eval-methodology.md`](../../docs/eval-methodology.md). The dataset is
deliberately weighted towards cases that defeat the obvious shortcuts, so a high headline number
cannot be produced purely by easy fixtures.
