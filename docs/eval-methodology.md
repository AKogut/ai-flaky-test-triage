# Evaluation methodology

## The problem with the naive version

The tempting setup is: write some deliberately flaky tests, hand-label them, run the agent, report
accuracy. It will report something like 96%, and the number will be meaningless — the fixtures
were authored to be classifiable, by the person who wrote the rubric, and a test that fails
because the author put an assertion immediately after a drag event with no wait is identifiable
from the stack trace alone. No language model is required.

Four mechanisms keep the numbers honest.

## 1. A non-LLM baseline

`eval/baseline.ts` implements a deliberately simple heuristic:

```
owner:
if the failure names an infrastructure error (bind / connect /  → environment
    missing module / browser launch / OOM), so no assertion ran
else if the commit changes any non-test source file             → app_code
else if the failure names a selector or a wait, not a value     → test_code
else                                                            → app_code

determinism:
if there was no pass on retry and the recent history shows an   → deterministic
    unbroken failure streak of two or more
else                                                            → intermittent
```

The second rule deserves a note, because an earlier wording of it — "the diff touches the file
under test" — is ambiguous in a way that changes the classifier. It could mean the _test_ file or
the _implementation_ the test exercises, and the two point in opposite directions: a diff touching
the spec suggests `test_code`, while a diff touching the implementation suggests `app_code`. A
heuristic cannot map a test to its implementation, so the rule is stated as written above: any
changed non-test path counts.

"Source file" means a path with a code extension, outside `.github/`, `docs/` and `wiki/`. An
earlier version counted every non-test path, so a documentation-only commit read as a product
change — the right answer for the wrong reason, fixed in #112.

The rule's remaining crudeness is left in deliberately. Every fixture in the `stale-test` bucket
has a genuine product diff, so the baseline calls all of them `app_code` and gets all of them
wrong. Narrowing that would mean tuning the control against the dataset it exists to control for,
and the distinction matters: excluding documentation makes the rule mean what this page says it
means, while excluding "diffs that only look product-ish" would mean fitting the control to the
answers.

Per-bucket outcomes are asserted by tests, so a future change to the rules surfaces as a failure
with a number in it rather than being absorbed silently.

Roughly sixty lines. Every agent number is reported **alongside** the baseline on the same
fixtures, and the headline metric is the _delta_, not the absolute.

This has two good outcomes and no bad one. If the agent wins, there is evidence the LLM earns its
cost. If the baseline wins, that is a genuinely interesting finding that goes in the README, and
the project demonstrates something rarer than a working classifier: a willingness to measure.

## 2. An adversarial dataset

`eval/golden-dataset/` targets **≥60 fixtures**, hand-labelled, with this composition:

| Bucket                                                        | Share | Purpose                                                                  |
| ------------------------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| Hard quadrant: `app_code` + `intermittent`                    | ~20%  | The case the project exists for                                          |
| Misleading history (long-flaky test failing for a new reason) | ~10%  | Punishes flakiness-score-only reasoning                                  |
| Environment failures dressed as regressions                   | ~10%  | Punishes diff-only reasoning                                             |
| Stale tests after refactors                                   | ~15%  | Common in practice, easy to over-call as `app_code`                      |
| Cross-file state leaks                                        | ~10%  | Cause and symptom in different files                                     |
| Straightforward cases                                         | ~25%  | Sanity floor; a classifier that fails these is broken                    |
| `lowConfidenceGroundTruth`                                    | ~10%  | Genuinely ambiguous; excluded from headline metrics, reported separately |

Each fixture is a `TestRun`-shaped JSON file plus a sibling `.labels.json` carrying ground truth,
a prose justification for the label, and the rules from
[taxonomy.md](taxonomy.md#labelling-rules-for-the-golden-dataset) that were applied.

**Provenance matters.** Fixtures come from three sources, tracked per fixture:
`synthetic` (hand-authored), `captured` (a real TaskFlow CI run, labelled after the fact), and
`mutated` (a captured run with an injected defect). Metrics are broken down by provenance —
if the agent only performs on synthetic fixtures, that is visible.

## 3. Reported uncertainty

Two independent sources of noise, both measured.

**Sampling noise from a small dataset.** Accuracy on 60 fixtures has a 95% Wilson interval of
roughly ±11pp at 90% accuracy. On 15 fixtures it is ±20pp — wide enough that a real regression is
invisible. Every reported metric carries its interval, and the dataset size is a tracked project
metric.

**Model non-determinism.** Temperature 0 is not determinism. Each fixture is classified `N=5`
times; the harness reports mean accuracy, per-fixture label stability (how often the same fixture
gets the same label), and the variance.

`self-consistency` is a first-class metric: a classifier that is 85% accurate and 100% stable is
more useful than one that is 88% accurate and flips on a third of fixtures, because the second one
cannot be trusted at the level of an individual PR comment.

The CI gate fires on the **lower bound** of the confidence interval, never the point estimate.

## 4. Confidence calibration

A model asked for a confidence number will return 0.85 for nearly everything. If that number gates
whether the root-cause agent runs, the gate is decorative.

The harness therefore bins predictions by stated confidence and measures observed accuracy per
bin, producing a reliability curve and an **Expected Calibration Error**. Two consequences:

1. The root-cause confidence threshold is read off the calibration curve — the point where
   observed accuracy actually crosses the target — rather than being guessed.
2. If ECE is bad enough that confidence carries no information, the honest move is to drop the
   field and gate on something else. That result would be published, not hidden.

## Metrics reported

`eval/report.md`, regenerated by `npm run eval`, contains:

- Overall accuracy per axis, with Wilson intervals, agent vs baseline
- **Joint accuracy** (both axes correct) — the number that matters, always lower than either axis
- Per-class precision / recall / F1
- Two confusion matrices (3×3 for `owner`, 2×2 for `determinism`)
- **Per-quadrant accuracy**, with `app_code + intermittent` called out
- Metrics broken down by fixture provenance
- Self-consistency rate across N samples
- Reliability curve + ECE
- Cost: tokens and dollars per fixture, and the projected cost of a 50-failure CI run
- Prompt version, model ID, dataset revision, and run date for every number

## CI gate

`npm run eval` runs on every PR that touches `agents/`, `eval/`, or `prompts/`. It fails when:

| Condition                                                             | Threshold      |
| --------------------------------------------------------------------- | -------------- |
| Joint accuracy lower bound drops below the recorded main-branch value | −5pp           |
| Joint accuracy lower bound below absolute floor                       | 0.65           |
| Agent fails to beat the baseline on joint accuracy                    | any regression |
| Self-consistency below floor                                          | 0.80           |
| Hard-quadrant recall below floor                                      | 0.50           |
| Cost per fixture rises sharply                                        | +50%           |

Thresholds start permissive and ratchet as the dataset grows. A gate that blocks on noise gets
disabled by whoever is on call, so the initial values are chosen to be survivable.

## Ablation study

`npm run eval:ablation` re-runs the dataset with parts of the context removed:

| Variant                  | Question it answers                              |
| ------------------------ | ------------------------------------------------ |
| Full context             | Reference                                        |
| No history               | How much does the flakiness signal contribute?   |
| No diff                  | How much does git context contribute?            |
| No test source           | Does reading the test matter?                    |
| Error message only       | How far does the trivial input get?              |
| Baseline heuristic       | Is the LLM needed at all?                        |
| Multi-step agent variant | Does a loop beat one call? (see agent-design.md) |
| Smaller model            | What does the capability tier buy?               |

Results go to `eval/ablation.md`. This is the section that turns "I built an AI classifier" into
"I measured which parts of it work" — and it is also how the context bundle gets pruned, since a
field that contributes nothing is cost with no return.

## Threats to validity

Stated plainly, because a methodology doc that claims none is not credible:

- **Author bias.** The person who wrote the fixtures also wrote the rubric and the prompt.
  Mitigation: `captured` fixtures from real runs, labelled before the agent sees them; the
  labelling rules are ordered and mechanical enough for a second person to reproduce.
- **Small n.** 60 fixtures is not a benchmark. Intervals are reported for exactly this reason.
- **Distribution shift.** TaskFlow's failure modes are not every codebase's failure modes. Nothing
  here claims to generalise beyond the repository it ships in.
- **Prompt overfitting.** Iterating prompts against the same 60 fixtures fits them. Mitigation: a
  held-out slice (~20%) that is not consulted during prompt development and is reported
  separately.
- **Label leakage.** Fixture filenames and annotations must not encode the answer. A lint step
  checks that no ground-truth term appears in the fixture payload.
