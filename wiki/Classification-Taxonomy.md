# Classification Taxonomy

> The normative version — including the ordered labelling rules used for the golden dataset — is
> [`docs/taxonomy.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/taxonomy.md).
> This page explains why the scheme looks the way it does.

## The obvious design, and why it fails

The natural first attempt is a single list:

```
real_bug | flaky_infra | stale_test | race_condition
```

It reads fine and it does not survive contact with real failures. `race_condition` names a
*mechanism*; `real_bug` names *ownership*. A race in a product's optimistic-update path is both, so
the person labelling has to choose arbitrarily — and chooses differently a week later.

That is not a cosmetic problem. Everything this project claims about itself rests on a hand-labelled
dataset. If two people, or one person on two days, produce different ground truth for the same
failure, then accuracy measured against that ground truth is decoration. The CI gate, the ablation
study, the calibration curve — all of them inherit the noise.

## Two axes instead

**`owner`** — where the fix goes: `app_code`, `test_code`, `environment`.

**`determinism`** — how it behaves on rerun: `deterministic`, `intermittent`.

Every failure gets exactly one value on each. The axes are independent: knowing something is
intermittent tells you nothing about whether the product or the test is at fault.

|                   | `deterministic` | `intermittent` |
|-------------------|---|---|
| **`app_code`**     | Regression | **Product race** |
| **`test_code`**    | Stale test | Unsynchronised test |
| **`environment`**  | Broken setup | Infra noise |

## Why these two questions

Because they are the two questions people actually ask, in this order:

1. **Is this mine?** — the `owner` axis. Determines who picks it up and where they look.
2. **Will rerunning help?** — the `determinism` axis. Determines what happens in the next thirty
   seconds, which in practice is "hit rerun" far more often than it should be.

A flat label answers neither cleanly. This matrix answers both and, crucially, keeps them separate
when they disagree — which is exactly the situation where triage is hard and where a tool can earn
its place.

## The quadrant the project exists for

`app_code` + `intermittent`. A genuine race in the product, caught by a correctly written test that
therefore fails only sometimes.

It matters because:

- It is **indistinguishable** from a flaky test by any simple signal. Both show alternating history,
  both pass on rerun, both look like noise.
- It is the one case where **rerun-until-green causes real harm**. The test was right. The bug
  ships.
- The evidence needed to tell it apart is spread across the diff, the test source, and the history —
  reading all three is precisely the tedious work people skip at 6pm.

The evaluation reports this quadrant's accuracy separately from the headline. If the agent cannot
beat a thirty-line heuristic here, it is not earning its cost, and the project would rather find
that out and say so.

## Cases chosen to be hard

Each of these is in the golden dataset on purpose, because each defeats one tempting shortcut:

| Case | Truth | What it defeats |
|---|---|---|
| Optimistic update races the API; test is correct and waits properly | `app_code` + `intermittent` | "Intermittent means flaky test" |
| Test passes locally, fails on a slower CI runner; product is fine | `test_code` + `intermittent` | "Slower runner means environment" |
| Selector matches two elements only when the list has ≥3 items | `test_code` + `intermittent` | "Intermittent means timing" |
| Real regression in a commit that also bumps a dependency | `app_code` + `deterministic` | Diff-noise reasoning |
| Test times out because a prior test left a modal open | `test_code` + `intermittent` | Single-test-in-isolation reasoning |
| Long-flaky test failing today for a **new** reason | `app_code` + `deterministic` | Flakiness-score reasoning |

The last one is the sharpest. It punishes exactly the feature a history-only baseline is built on,
which is what makes the baseline comparison meaningful rather than a straw man.

## Output shape

```ts
{
  owner: 'app_code' | 'test_code' | 'environment'
  determinism: 'deterministic' | 'intermittent'
  confidence: number
  reasoning: string
  evidence: string[]     // quoted fragments from the input
}
```

`evidence` is not decoration. Requiring the model to quote what it relied on makes fabricated
justifications visible in review, and gives the evaluation something to check beyond the label
itself.

Whether `confidence` means anything is treated as an open question rather than an assumption — see
[Evaluation Methodology](Evaluation-Methodology#does-confidence-mean-anything).

## Decision record

[ADR-0002](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/adr/0002-two-axis-classification-taxonomy.md),
including the alternatives considered and the cost accepted: joint accuracy — both axes correct on
the same fixture — is always lower than either axis alone, and it is the number reported as the
headline.
