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

### What it scores today

Against the 36 committed fixtures, with 95% Wilson intervals:

| Metric                | Baseline              | Macro-F1 |
| --------------------- | --------------------- | -------- |
| **Joint** (both axes) | **33.3% [20.2–49.7]** | —        |
| `owner`               | 52.8% [37.0–68.0]     | 0.40     |
| `determinism`         | 77.8% [61.9–88.3]     | 0.77     |

Three things in that table are worth reading carefully, because they are the reason the metrics are
shaped this way.

**Joint accuracy is 20pp below the `owner` axis and 45pp below `determinism`.** Reporting either
axis alone would describe a classifier that half works; 33.3% is how often it produces an answer a
developer could act on without checking.

**`test_code` has an F1 of 0.125.** The baseline identifies one test-code failure out of ten —
support 10, six predictions, one correct — and that one is a captured fixture with no commit under
test, where there is no product diff for the ownership rule to fire on. It was exactly 0 until that
fixture arrived. Accuracy hides this completely; macro-F1 is what makes it visible, which is the
argument for reporting both.

**A classifier that answers `app_code` unconditionally beats it on `owner` accuracy**, 62.9%
against 52.8%, because 22 of 36 fixtures are `app_code`. That is not a defect in the baseline — it
is the adversarial dataset doing its job. The constant classifier's macro-F1 is 0.25 against the
baseline's 0.40, so the baseline is genuinely better; accuracy alone simply cannot say so. And the
two intervals overlap heavily, so at n=36 neither result is evidence of a difference at all. That
is the honest reading, and it is also the argument for growing the dataset to 60.

Every number above is pinned in `eval/metrics.test.ts`. A change to the rules or to the dataset
fails the suite with the old and new values side by side.

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
[taxonomy.md](taxonomy.md#labelling-rules) that were applied.

**Provenance matters.** Fixtures come from three sources, tracked per fixture:
`synthetic` (hand-authored), `captured` (a real TaskFlow CI run, labelled after the fact), and
`mutated` (a captured run with an injected defect). Metrics are broken down by provenance —
if the agent only performs on synthetic fixtures, that is visible.

### Evidence the buckets do what they claim

A bucket that says it "punishes diff-only reasoning" is a claim, not a fact, until something is
measured against it. Scoring the baseline per bucket is that measurement:

| Bucket                      |   n | Joint  | `owner` | `determinism` |
| --------------------------- | --: | ------ | ------- | ------------- |
| `straightforward`           |   8 | 100.0% | 100.0%  | 100.0%        |
| `hard-quadrant`             |  11 | 27.3%  | 54.5%   | 72.7%         |
| `stale-test`                |   8 | 0.0%   | 12.5%   | 87.5%         |
| `misleading-history`        |   4 | 0.0%   | 75.0%   | 0.0%          |
| `environment-as-regression` |   4 | 25.0%  | 25.0%   | 100.0%        |
| `cross-file-state-leak`     |   1 | 0.0%   | 0.0%    | 100.0%        |

Each adversarial bucket defeats the baseline **on the axis it was built to attack, and only that
axis**:

- `stale-test` targets diff-only reasoning about ownership. Owner drops to 12.5%; determinism
  stays at 87.5%. Both numbers used to be absolute — 0% and 100% — and the one fixture that moved
  them is worth naming: the captured fixture from #53 has no commit under test, so there is no
  product diff for the ownership rule to fire on, the baseline falls through to its locator rule
  and gets the owner right. It loses the point back on the other axis. The bucket's story is
  unchanged; the exception is what shows the story was about the diff all along.
- `misleading-history` targets flakiness-score-only reasoning about stability. Determinism drops
  to 0%; owner stays at a respectable 75%.
- `environment-as-regression` targets diff-only reasoning again, from the other direction, and
  takes owner to 25% while determinism is untouched.

That orthogonality is the part worth noticing. Buckets that all failed together would mean the
fixtures were simply hard, or simply badly written. Failing on precisely the intended axis is what
distinguishes an adversarial dataset from a difficult one.

`straightforward` at 100% is the control on the control: it says the baseline is a working
classifier rather than a broken one, so the failures above are properties of the fixtures rather
than of the code being measured.

The full confusion matrices and quadrant table are regenerated into `eval/report.md`; the numbers
here are pinned in `eval/confusion.test.ts`.

## 3. Reported uncertainty

Two independent sources of noise, both measured.

**Sampling noise from a small dataset.** Accuracy on 60 fixtures has a 95% Wilson interval of
roughly ±11pp at 90% accuracy. On 15 fixtures it is ±20pp — wide enough that a real regression is
invisible. Every reported metric carries its interval, and the dataset size is a tracked project
metric.

**Model non-determinism.** There is no temperature to pin — this model rejects `temperature`,
`top_p` and `top_k` outright — and pinning it never bought determinism anyway. Each fixture is
classified `N=5`
times; the harness reports mean accuracy, per-fixture label stability (how often the same fixture
gets the same label), and the variance.

`self-consistency` is a first-class metric: a classifier that is 85% accurate and 100% stable is
more useful than one that is 88% accurate and flips on a third of fixtures, because the second one
cannot be trusted at the level of an individual PR comment.

**Two accuracy numbers, both on the page.** The headline is scored on the **consensus** label —
the one a majority of samples gave — so that every count in the report keeps meaning one fixture:
support, confusion cells, quadrant recall, F1. Directly beneath it the report states the **mean
single-run accuracy and its spread**, because the shipped pipeline classifies once and that is the
number a pull-request comment actually gets. The gap between the two is the price of instability,
and it is stated rather than left for a reader to derive. Every fixture that gave more than one
answer is listed with the labels it gave.

Ties in the consensus break towards the first sample, not towards a fixed label. A fixed tiebreak
would make one class win every coin flip, which arrives in the confusion matrix looking like a real
bias in the classifier and comes from nowhere in it.

The spread is a **population** standard deviation. These N runs are every run that happened, and at
N=5 the Bessel correction would widen the reported figure by 12% for no reason a reader could act
on.

**Default N is five for the agent and one for the baseline** — the baseline is a pure function, so
five identical runs would cost time and report a self-consistency of 1 that says nothing. It is the
same in every mode, including replay. Making it mode-dependent would make the committed report
unreproducible: the gate regenerates from the defaults and would find a one-sample run disagreeing
with the five-sample file it is checking. Replaying five cassettes costs nothing but disk.

**The sample index is part of the cassette key.** Without it every sample of a fixture hashes to the
same cassette, replay hands back one answer five times, and the harness reports perfect stability
for a classifier nobody measured.

The CI gate fires on the **lower bound** of the confidence interval, never the point estimate.

## 4. Confidence calibration

A model asked for a confidence number will return 0.85 for nearly everything. If that number gates
whether the root-cause agent runs, the gate is decorative.

The harness therefore bins predictions by stated confidence and measures observed accuracy per
bin, producing a reliability curve and an **Expected Calibration Error**.

**ECE alone does not answer the question, and treating it as though it does is the usual mistake.**
Two properties are being asked about and they are independent:

- **Calibration** — when it says 0.8, is it right about 80% of the time? That is ECE, with the
  worst single bin reported beside it, because an average hides the case that matters: a classifier
  can post a respectable ECE while being wrong by 40 points in the one bin the threshold sits in.
- **Discrimination** — does a higher number mean a better prediction _at all_? Measured as AUROC
  over (confidence, correct), where 0.50 is a coin toss. A classifier that says 0.7 for every
  prediction and is right 70% of the time has a **perfect ECE and is useless**, because ranking is
  the only thing the threshold uses the number for.

So the verdict leads with discrimination, and a good ECE cannot rescue an AUROC of 0.5. The report
states the conclusion in words — usable, weakly informative, or not usable — before the tables, so
a reader does not have to decide what the numbers mean before knowing whether the column they are
built on carries information at all.

Points are one per **prediction**, not per fixture: with sampling every sample is a classification
the pipeline could have emitted, and each carries its own stated confidence. They are correlated,
which is why no confidence interval is attached to ECE and why the report calls the result a
direction rather than a measurement at this dataset size.

**The threshold is read off the data.** The sweep runs over the confidence values the classifier
actually produced — a threshold between two values it never emits behaves identically to one of
them and looks more considered than it is — and takes the **lowest** value clearing the target
accuracy over at least five predictions. Lower is better: the point is to run the root-cause agent
on everything it can be right about, and a higher bar buys accuracy by answering less often.

When no threshold qualifies, the report says which of the two problems it hit. "No threshold
reaches 70%" printed next to a row showing 100% is a message a reader stops trusting; short support
and low accuracy are different problems with different fixes — more fixtures, or a better
classifier.

If confidence carries no information, the honest move is to drop the field and gate on something
else. That result gets published, not worked around.

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

`npm run eval -- --gate` runs on every pull request. It does two things: verifies the committed
report and metrics match a fresh run, and holds those numbers to the thresholds below. The values
live in `eval/gate.ts`, one file, each with the reason it has the value it does.

| Condition                                                           | Threshold      | Active |
| ------------------------------------------------------------------- | -------------- | ------ |
| Joint accuracy lower bound drops below the value recorded on `main` | −5pp           | yes    |
| Joint accuracy lower bound below absolute floor                     | 0.65           | M3     |
| Agent fails to beat the baseline on joint accuracy                  | any regression | M3     |
| Self-consistency below floor                                        | 0.80           | M3     |
| Hard-quadrant accuracy lower bound below floor                      | 0.50           | M3     |
| Cost per fixture rises sharply                                      | +50%           | M3     |

**Comparisons use interval lower bounds, never point estimates.** At n=22 a point estimate moves
several percentage points between two classifiers that are indistinguishable, so gating on it
would fire on the dice. The lower bound fires when the evidence supports a regression.

**Five of the six are targets for the agent, not descriptions of the baseline.** The baseline's
joint accuracy lower bound is 0.197 against a floor of 0.65; its hard-quadrant lower bound is 0.097
against 0.50. Enabling those today would make `main` permanently red on facts everybody already
knows, and a permanently red gate is one people learn to merge past. They are implemented, printed
in every run with the current distance to the target, and each names the condition that switches it
on.

That leaves one active check, plus freshness. It is the one that matters today: nothing may make
the classifier measurably worse than what is recorded on `main`.

Thresholds start permissive and ratchet as the dataset grows. Ratcheting means editing `gate.ts` in
a reviewable commit — the gate has no runtime override, because a gate you can wave through at 3am
is not a gate.

### Why the job always runs

The gate is a required status check. A required check that skips leaves a pull request waiting
forever for a status that never arrives, so the job runs on every PR regardless of what changed.
Whether anything under `agents/`, `eval/` or `prompts/` changed is detected and exported as
`SENTRA_EVAL_SCOPE_CHANGED`; today the whole evaluation is free — no model, no network — so it runs
either way. From M3 that flag is what stops a documentation-only change from paying for a model
run.

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

## Development and held-out slices

Iterating prompts against every fixture fits them to it. After twenty revisions the number measures
how hard the author tried, not how well the classifier generalises. `npm run eval` therefore
defaults to `--slice=dev`, and the held-out fixtures are scored separately by
`--slice=holdout`.

**The split is a pure function of the fixture name** — the first 32 bits of its SHA-256 over 2³²,
held out below 20%. Nothing about the rest of the dataset enters into it, so adding, removing or
renaming any other fixture cannot move it.

That property is not negotiable, and it is worth being explicit about what it costs. A stratified
split with exact per-bucket counts has to look at the other fixtures in the bucket, and then
inserting one reshuffles the boundary and silently moves an existing fixture across it. Every
held-out number published before that moment would then have been computed on a different set,
with nothing going red. Poor stratification is visible and self-correcting; a moving split is
neither.

So the per-bucket balance is **best-effort and measured**, not guaranteed:

| Bucket                      | Total | Dev | Held out |
| --------------------------- | ----: | --: | -------: |
| `cross-file-state-leak`     |     1 |   1 |        0 |
| `environment-as-regression` |     4 |   3 |        1 |
| `hard-quadrant`             |    11 |   7 |        4 |
| `misleading-history`        |     4 |   3 |        1 |
| `stale-test`                |     8 |   5 |        3 |
| `straightforward`           |     8 |   5 |        3 |
| **Total**                   |    36 |  24 |   **12** |

12 of 36 is 33%, not 20%. That is ordinary binomial variance at this size — the expected count is
7.2 with a standard deviation of 2.4 — and it narrows as the dataset grows towards 60. A bucket of
four has a 41% chance of receiving no held-out fixture at all, and the newest bucket — one fixture,
from #54 — has none. The report states which buckets the held-out slice is silent about rather than
letting a reader assume the split guarantees coverage.

One methodological note, since this is a document about not fooling yourself. Two reasonable
constructions exist for turning a hash into a uniform value — dividing by 2³², and the slightly
biased `hash % 100` — and on these 36 fixtures they produce **different splits**, 12 held out
against 6. Choosing between them after seeing that would be picking a test set by how convenient it
looks. The unbiased one is used; the result is reported, not selected.

### The usage budget

A held-out set consulted freely is a development set with extra steps. `eval/holdout-log.json`
records every evaluation and is committed, so the record cannot be quietly reset by deleting a file
nobody reviews. Past **three evaluations in 30 days** the harness warns, in the terminal and in the
report itself.

`--slice=all` counts as a consultation. It reads the held-out fixtures just as surely as asking for
them by name, and a rule that only caught `--slice=holdout` would be bypassed by choosing the more
innocuous-sounding flag.

The log counts **runs, not insights**, and over-counts deliberately. Regenerating the held-out
report after a formatting change teaches nobody anything and in a strict sense should not spend
budget — but the tool cannot tell that from a real consultation, and any flag meaning "this one
does not count" is a flag for never counting. Erring towards over-counting costs an occasional
early warning; erring the other way costs the mechanism.

## Threats to validity

Stated plainly, because a methodology doc that claims none is not credible:

- **Author bias.** The person who wrote the fixtures also wrote the rubric and the prompt.
  Mitigation: `captured` fixtures from real runs, labelled before the agent sees them; the
  labelling rules are ordered and mechanical enough for a second person to reproduce.
- **Small n.** 60 fixtures is not a benchmark. Intervals are reported for exactly this reason.
- **Distribution shift.** TaskFlow's failure modes are not every codebase's failure modes. Nothing
  here claims to generalise beyond the repository it ships in.
- **Prompt overfitting.** Iterating prompts against the same 60 fixtures fits them. Mitigation: a
  held-out slice, scored separately and budgeted — see above. Partial, not complete: the budget
  limits how often the slice is consulted, not how much each consultation leaks.
- **Label leakage.** Fixture filenames and annotations must not encode the answer. A lint step
  checks that no ground-truth term appears in the fixture payload.
