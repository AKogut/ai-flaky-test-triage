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

## Target composition

Shares are specified in [`docs/eval-methodology.md`](../../docs/eval-methodology.md). The dataset is
deliberately weighted towards cases that defeat the obvious shortcuts, so a high headline number
cannot be produced purely by easy fixtures.
