# ADR-0002: Two-axis classification taxonomy

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** @AKogut
- **Related:** [`docs/taxonomy.md`](../taxonomy.md), [`docs/eval-methodology.md`](../eval-methodology.md)

## Context

The initial specification used a flat enum:

```
real_bug | flaky_infra | stale_test | race_condition
```

These values are not mutually exclusive. `race_condition` names a *mechanism*; `real_bug` names
*ownership*. A race in the product's optimistic-update path satisfies both, so the labeller
chooses arbitrarily — and chooses differently on a different day.

This is not a cosmetic problem. The entire evaluation strategy rests on a hand-labelled golden
dataset. If ground truth is not reproducible, accuracy measured against it is meaningless, and
every downstream number — the CI gate, the ablation study, the calibration curve — inherits the
noise.

## Decision

Classify on two orthogonal axes, each with exactly one value per failure:

- **`owner`**: `app_code` | `test_code` | `environment` — where the fix goes.
- **`determinism`**: `deterministic` | `intermittent` — how it behaves on rerun.

Ambiguity is resolved by an ordered rule list in [`taxonomy.md`](../taxonomy.md), shared verbatim
between the human labelling process and the agent prompt.

## Options considered

### Option A — Keep the flat enum, tighten definitions with a rubric

- **Pros:** simplest output schema; one number for accuracy.
- **Cons:** the overlap is structural, not definitional. No rubric makes "a product race" fit one
  bucket without discarding information a developer needs.

### Option B — Flat enum plus free-text tags

- **Pros:** flexible.
- **Cons:** free text is not evaluable. Precision and recall need a closed set.

### Option C — Two orthogonal axes (chosen)

- **Pros:** every failure has exactly one cell; the axes are independently measurable, so a
  classifier can be strong on one and weak on the other and that is visible; the first axis maps
  directly to the developer's actual question ("is this mine?"); it isolates
  `app_code + intermittent`, the quadrant that motivates the project.
- **Cons:** joint accuracy is lower than any single-axis figure and looks worse in a headline;
  slightly more complex schema and confusion-matrix reporting.

## Consequences

### Positive

- Ground truth is reproducible; the ordered rules make labelling near-mechanical.
- The eval harness reports per-axis and per-quadrant metrics, exposing failure structure that a
  flat label would average away.
- The baseline heuristic can be written per axis, making the comparison cleaner.

### Negative / accepted costs

- Two confusion matrices instead of one.
- The honest headline metric (joint accuracy) is the lowest number the project reports. This is
  accepted deliberately — the README explains why it is the right one.

### What would make us revisit this

Evidence from the confusion matrices that a third axis is being smuggled into one of the existing
ones — the most likely candidate being *severity* or *actionability*, currently intentionally
absent. A superseding ADR would add it as an axis rather than overloading `owner`.
