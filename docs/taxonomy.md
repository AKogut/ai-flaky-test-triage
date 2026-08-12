# Classification taxonomy

## Why not a flat label list

The obvious design is one enum:

```
real_bug | flaky_infra | stale_test | race_condition
```

It does not survive contact with real failures. `race_condition` describes a _mechanism_;
`real_bug` describes _ownership_. A race in the product's optimistic-update path is both, so the
labeller has to pick arbitrarily. Two people labelling the same fixture disagree; the same person
disagrees with themselves a week later. Once ground truth is unreproducible, accuracy measured
against it is decoration.

## The rubric

The normative text below is generated from [`prompts/rubric.md`](../prompts/rubric.md) — the same
file the triage prompt embeds. There is one copy on purpose: a rubric the model applies and a
rubric the dataset was labelled by that have quietly drifted apart produce an accuracy figure that
measures agreement with a rule nobody is following, and it looks exactly like the figure that
meant something. `npm run prompts:sync` writes this block and a unit test fails when it is stale.

<!-- rubric:begin -->

<!-- Generated from prompts/rubric.md by `npm run prompts:sync`. Edit that file, not this block. -->

Every failure gets exactly one value on each axis.

### Axis 1 — `owner`: where the fix goes

| Value         | Meaning                                                               | Typical evidence                                                                                                                           |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `app_code`    | The product is wrong. The test correctly caught it.                   | Diff touches the implementation under test; assertion failure on a value, not a locator; error surfaces from application code in the stack |
| `test_code`   | The product is fine. The test is wrong, stale, or badly synchronised. | Locator/timeout error; test asserts immediately after an async action; diff touches only the spec; shared fixture mutated across tests     |
| `environment` | Neither. The run itself was broken.                                   | Port already in use; DNS/network error; missing binary; OOM; runner timeout with no assertion reached; browser launch failure              |

### Axis 2 — `determinism`: how it behaves on rerun

| Value           | Meaning                                     | Typical evidence                                                                                                                   |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `deterministic` | Fails every time under the same conditions. | `statusHistory` shows an unbroken failure streak; failed on all retry attempts; flakiness score near 0 with current status failing |
| `intermittent`  | Fails some of the time.                     | Alternating pass/fail history; passed on retry within the same run; high flakiness score                                           |

### Labelling rules

Applied in order; the first rule that fires decides.

1. **The run never reached the assertion** (browser crash, port bind failure, install error,
   OOM) → `environment`, regardless of anything else.
2. **The test source encodes an unsafe assumption** (asserts without waiting for an async
   effect, depends on another test's state, depends on list order that is not guaranteed) →
   `test_code`, even if the product also has a race. Rationale: the test is not a valid
   detector, so it cannot be evidence about the product.
3. **The failure reproduces against an unchanged product** (same commit, isolated run) →
   `test_code` if the test is at fault, `app_code` if the product is.
4. **Otherwise** → `app_code`.

For `determinism`: `deterministic` iff every attempt in the run failed **and** the recorded
history shows no pass in the last 5 runs of the same test at the same commit range. Anything
else is `intermittent`. Where history is absent (`isNew`), fall back to within-run retries only,
and mark the fixture `lowConfidenceGroundTruth: true` so it can be excluded from headline
metrics.

### Deciding the axes independently

The axes are orthogonal by construction, and treating them as one judgement is the most common
way to get both wrong. Knowing a failure is intermittent says nothing about whether the product
or the test is at fault: a product race and a missing `await` in the spec produce the same
alternating history. Decide `owner` from what the evidence implicates, decide `determinism` from
how the failure behaves across attempts and history, and do not let a conclusion on one axis
argue for a conclusion on the other.

<!-- rubric:end -->

## The resulting matrix

|                   | `deterministic`                                                                     | `intermittent`                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **`app_code`**    | **Regression.** Ship-blocking. The common, easy case.                               | **Product race.** The dangerous quadrant — looks like a flaky test, is actually a bug that will hit users. |
| **`test_code`**   | **Stale test.** Selector or assertion drifted from the app. Fix or delete the test. | **Unsynchronised test.** Missing wait, ordering assumption, shared state. Fix the test.                    |
| **`environment`** | **Broken setup.** Missing dependency, bad config, wrong runtime version. Fix CI.    | **Infra noise.** Runner blip, port collision, network flake. Rerun, then track frequency.                  |

## Why this is the useful split

The first axis answers the only question a developer actually has at 6pm on a Friday: **is this
mine?** The second answers **will rerunning help?** — the thing everyone actually does, and
usually shouldn't.

The two are independent: knowing a failure is intermittent tells you nothing about whether the
product or the test is at fault, and that ambiguity is precisely where triage effort is spent.
A flat label buries it. This matrix puts it on the front page.

## The quadrant that justifies the project

`app_code` + `intermittent` is the reason this exists. It is:

- indistinguishable from `test_code` + `intermittent` by any simple heuristic (both are "flaky"),
- the one quadrant where "rerun until green" causes actual harm,
- the case where the code diff and the test source together carry the signal, and reading both
  is exactly the tedious work people skip.

If the agent cannot beat the baseline heuristic here, it is not earning its cost — and the eval
harness reports this quadrant separately for that reason.

## Output schema

```ts
type Classification = {
  owner: 'app_code' | 'test_code' | 'environment'
  determinism: 'deterministic' | 'intermittent'
  confidence: number // 0..1, calibration measured — see eval-methodology.md
  reasoning: string // <= 400 chars, must cite specific evidence
  evidence: string[] // quoted fragments from the input the decision rests on
}
```

`evidence` is not decoration. Requiring the model to quote the input it relied on makes
hallucinated justifications visible in review and gives the eval harness something to check
beyond the label.

## Known hard cases

Each of these is represented in the golden dataset on purpose.

| Case                                                                                      | Correct label                | Why it is hard                                                               |
| ----------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| Optimistic UI update races the API response; test is correctly written and waits properly | `app_code` + `intermittent`  | Looks identical to a flaky test from the outside                             |
| Test passes locally, fails only on CI's slower runner, product is fine                    | `test_code` + `intermittent` | Tempting to blame `environment`; the test's timeout assumption is the defect |
| Selector matches two elements only when the list has ≥3 items                             | `test_code` + `intermittent` | Intermittency comes from data, not timing                                    |
| Real regression introduced in the same commit that also bumps a dependency                | `app_code` + `deterministic` | Diff noise invites an `environment` misclassification                        |
| Suite passes, one test times out because a prior test left a modal open                   | `test_code` + `intermittent` | Failure and cause are in different files                                     |
| Flaky test that has been flaky for 200 runs and today is failing for a _new_ reason       | `app_code` + `deterministic` | History actively misleads                                                    |

The last row is the one that punishes over-reliance on flakiness score — the metric a
history-only baseline is built on.
