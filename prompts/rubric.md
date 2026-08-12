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
