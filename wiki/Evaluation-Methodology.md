# Evaluation Methodology

> Normative version, with thresholds, bucket shares, and the full metric list:
> [`docs/eval-methodology.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/eval-methodology.md).

## The trap this is designed to avoid

The tempting setup is: write some deliberately flaky tests, hand-label them, run the classifier,
report accuracy. It would report something like 96%.

That number would be worthless. The fixtures were authored to be classifiable, by the same person
who wrote the rubric and the prompt. A test that fails because the author put an assertion
immediately after a drag event with no wait is identifiable from the stack trace alone — no
language model required.

Any AI project can produce a high number this way. Four mechanisms are what make these numbers mean
something.

## 1. A non-LLM baseline

A deliberately simple heuristic — roughly sixty lines — classifies the same fixtures:

```
no assertion reached (crash / bind / install)   → environment
the commit changes any non-test source file     → app_code
locator or timeout error, not a value           → test_code
otherwise                                       → app_code
```

The second rule says **any** changed non-test source path, not "the file under test". A heuristic
cannot map a test to the implementation it exercises, and the looser wording pointed in two
opposite directions at once.

Every agent number is reported next to it, and the **delta** is the headline, not the absolute.

Two outcomes, both fine. The agent wins → there is evidence the model earns its cost. The baseline
wins → that is a genuinely interesting result, it goes in the README, and the project demonstrates
something rarer than a working classifier.

The baseline has a second job: on fork pull requests there is no API key, so it is the only
classifier available. That forces it to be good enough for a human to read, which also makes it a
fair control rather than a straw man.

### What it scores today

Against the 33 committed fixtures, with 95% Wilson intervals:

| Metric                | Baseline              | Macro-F1 |
| --------------------- | --------------------- | -------- |
| **Joint** (both axes) | **36.4% [22.2–53.4]** | —        |
| `owner`               | 54.5% [38.0–70.2]     | 0.36     |
| `determinism`         | 78.8% [62.2–89.3]     | 0.77     |

Joint accuracy sits 18pp below the `owner` axis and 42pp below `determinism` — reporting either
axis alone would describe a classifier that half works.

`test_code` has an F1 of exactly **0**: the baseline never once identifies a test-code failure.
Accuracy hides that; macro-F1 is what makes it visible.

And a classifier that answers `app_code` unconditionally beats it on `owner` accuracy — 63.6%
against 54.5%, because 21 of 33 fixtures are `app_code`. That is the adversarial dataset doing its
job rather than a defect in the baseline: on macro-F1 the constant classifier scores 0.26 against
the baseline's 0.36. The intervals overlap heavily, so at n=33 neither result is evidence of a
difference — which is the argument for growing the dataset to 60.

Every number here is pinned in `eval/metrics.test.ts`, so a change to the rules or the dataset
fails the build with the old and new values side by side.

## 2. An adversarial dataset

Roughly 60 fixtures, weighted towards the cases that defeat obvious shortcuts:

| Bucket                                       | Share |
| -------------------------------------------- | ----- |
| Hard quadrant (`app_code` + `intermittent`)  | ~20%  |
| Misleading history                           | ~10%  |
| Environment dressed as regression            | ~10%  |
| Stale tests after refactors                  | ~15%  |
| Cross-file state leaks                       | ~10%  |
| Straightforward                              | ~25%  |
| Genuinely ambiguous (excluded from headline) | ~10%  |

Fixtures carry their **provenance**: `synthetic` (hand-authored), `captured` (from a real CI run,
labelled after the fact), `mutated` (a real run with an injected defect). Metrics are broken down by
provenance, so a classifier that only performs on invented failures is visible rather than
flattered.

### Evidence the buckets do what they claim

"Punishes diff-only reasoning" is a claim, not a fact, until something is measured against it.
Scoring the baseline per bucket is that measurement:

| Bucket                      |   n | Joint  | `owner` | `determinism` |
| --------------------------- | --: | ------ | ------- | ------------- |
| `straightforward`           |   8 | 100.0% | 100.0%  | 100.0%        |
| `hard-quadrant`             |  10 | 30.0%  | 60.0%   | 70.0%         |
| `stale-test`                |   7 | 0.0%   | 0.0%    | 100.0%        |
| `misleading-history`        |   4 | 0.0%   | 75.0%   | 0.0%          |
| `environment-as-regression` |   4 | 25.0%  | 25.0%   | 100.0%        |

Each adversarial bucket defeats the baseline **on the axis it was built to attack, and only that
axis**. `stale-test` takes owner to 0% and leaves determinism at 100%. `misleading-history` is the
mirror image — determinism to 0%, owner still at 75%.

That orthogonality is the point. Buckets that all failed together would mean the fixtures were
merely hard, or badly written. Failing on precisely the intended axis is what separates an
adversarial dataset from a difficult one.

`straightforward` at 100% is the control on the control: the baseline is a working classifier, so
the failures above are properties of the fixtures rather than of the code being measured.

### Development and held-out slices

Iterating prompts against every fixture fits them to it. `npm run eval` defaults to
`--slice=dev`; the held-out fixtures are scored separately by `--slice=holdout`.

The split is a **pure function of the fixture name** — the first 32 bits of its SHA-256 over 2³²,
held out below 20%. Adding, removing or renaming any other fixture cannot move it.

That property costs exact stratification, and the trade is deliberate. A split with guaranteed
per-bucket counts has to look at the other fixtures, so inserting one reshuffles the boundary and
silently moves an existing fixture across it — invalidating every held-out number published before
that moment, with nothing going red. Poor stratification is visible and self-correcting; a moving
split is neither.

| Bucket                      | Total | Dev | Held out |
| --------------------------- | ----: | --: | -------: |
| `environment-as-regression` |     4 |   3 |        1 |
| `hard-quadrant`             |    10 |   6 |        4 |
| `misleading-history`        |     4 |   3 |        1 |
| `stale-test`                |     7 |   5 |        2 |
| `straightforward`           |     8 |   5 |        3 |
| **Total**                   |    33 |  22 |   **11** |

11 of 33 is 33%, not 20% — ordinary binomial variance at this size, which narrows as the dataset
grows towards 60.

**The usage budget.** A held-out set consulted freely is a development set with extra steps.
`eval/holdout-log.json` records every evaluation and is committed, so the record cannot be quietly
reset. Past three evaluations in 30 days the harness warns. `--slice=all` counts as a
consultation — it reads the held-out fixtures just as surely as asking for them by name.

## 3. Reported uncertainty

Two independent sources of noise, both measured rather than ignored.

**Small-sample noise.** Accuracy on 60 fixtures has a 95% Wilson interval of about ±11pp at 90%
accuracy. On 15 fixtures it is ±20pp — wide enough that a real regression is invisible. Every
proportion ships with its interval, and the CI gate compares **lower bounds**, never point
estimates.

**Model non-determinism.** Temperature 0 is not determinism. Each fixture is classified five times,
and the harness reports mean accuracy, variance, and per-fixture label stability.

**Self-consistency is a first-class metric.** A classifier that is 85% accurate and 100% stable is
more useful than one that is 88% accurate and flips on a third of fixtures — because the second
cannot be trusted at the level of an individual pull-request comment, which is the only level at
which anyone actually reads it.

There is an obvious irony in a flaky-test triage tool whose own evaluation is mildly flaky. It is
documented rather than hidden.

## 4. Does confidence mean anything?

A model asked for a confidence number returns 0.85 for nearly everything. That number gates whether
the expensive root-cause agent runs, so if it carries no information the gate is decorative.

The harness bins predictions by stated confidence, measures observed accuracy per bin, and reports a
reliability curve plus Expected Calibration Error. Two consequences:

- If calibration is reasonable, the threshold is **read off the curve** at the point where observed
  accuracy crosses the target — not guessed.
- If ECE shows confidence is noise, the honest move is to drop the field and gate on something else.
  That result would be published, not worked around.

## What the report contains

`eval/report.md` is regenerated by `npm run eval` and committed, so a regression appears as a diff:

per-axis and **joint** accuracy with intervals · agent vs baseline deltas · per-class
precision/recall/F1 · two confusion matrices · per-quadrant accuracy with the hard quadrant called
out · breakdown by provenance · self-consistency · reliability curve and ECE · cost per fixture and
projected cost of a 50-failure run · and the prompt version, model ID, dataset revision and date
behind every number.

**Joint accuracy** — both axes correct on the same fixture — is the headline. It is always the
lowest number reported, and reporting the axes separately without it would be the most natural way
to accidentally flatter the classifier.

## The merge gate

`npm run eval -- --gate` runs on every pull request. It verifies the committed report and metrics
match a fresh run, then holds those numbers to the thresholds in `eval/gate.ts` — one file, each
value carrying the reason it has the value it does.

| Condition                                                           | Threshold      | Active |
| ------------------------------------------------------------------- | -------------- | ------ |
| Joint accuracy lower bound drops below the value recorded on `main` | −5pp           | yes    |
| Joint accuracy lower bound below absolute floor                     | 0.65           | M3     |
| Agent fails to beat the baseline on joint accuracy                  | any regression | M3     |
| Self-consistency below floor                                        | 0.80           | M3     |
| Hard-quadrant accuracy lower bound below floor                      | 0.50           | M3     |
| Cost per fixture rises sharply                                      | +50%           | M3     |

Five of the six are targets for the **agent**, not descriptions of the baseline — whose joint
accuracy lower bound is 0.197 against a floor of 0.65. Enabling them today would make `main`
permanently red on facts everybody already knows, and a permanently red gate is one people learn to
merge past. They are implemented, printed on every run with the current distance to the target, and
each names the condition that switches it on.

Comparisons use interval **lower bounds**, never point estimates: at this dataset size a point
estimate moves several percentage points between two classifiers that are indistinguishable, so
gating on it would fire on the dice.

Ratcheting means editing `gate.ts` in a reviewable commit. There is no runtime override — a gate
you can wave through at 3am is not a gate.

## The ablation study

`npm run eval:ablation` re-runs the dataset with parts of the context removed: no history, no diff,
no test source, error message only, baseline, multi-step agent variant, smaller model.

This is the part that turns "I built an AI classifier" into "I measured which parts of it work". It
is also how the context bundle gets pruned — a field that contributes nothing is cost and latency
with no return, and the only way to know which is to remove them one at a time.

Three of these run as tracked experiments:
[history](https://github.com/AKogut/ai-flaky-test-triage/issues/79) ·
[multi-step agent](https://github.com/AKogut/ai-flaky-test-triage/issues/80) ·
[model tier](https://github.com/AKogut/ai-flaky-test-triage/issues/81).

## Threats to validity

Stated plainly, because a methodology page claiming none is not credible.

- **Author bias.** The fixtures, the rubric, and the prompt share an author. Mitigated by captured
  fixtures from real runs and by labelling rules mechanical enough for someone else to reproduce.
- **Small n.** Sixty fixtures is not a benchmark. Hence the intervals.
- **Distribution shift.** TaskFlow's failure modes are not every codebase's. Nothing here claims to
  generalise beyond this repository.
- **Prompt overfitting.** Iterating against the same fixtures fits them. Mitigated by a held-out
  slice consulted rarely and reported separately.
- **Label leakage.** A lint step checks that no ground-truth term appears in a fixture payload,
  filename, or test title. It catches the careless cases; semantic leakage survives any word list.
