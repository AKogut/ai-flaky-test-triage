<!-- Title must be a valid Conventional Commit — it becomes the squash commit on main. -->

Closes #

## What changed

<!-- One paragraph. What is now true that was not true before. -->

## Why

<!-- The motivating problem, or a link to the issue/ADR that carries it. -->

## How it was verified

<!-- Not "tests pass" — what did you actually check, and how would a reviewer reproduce it? -->

```bash

```

## Eval impact

<!-- REQUIRED when this PR touches agents/, eval/, prompts/, or the golden dataset.
     Paste the before/after table from eval/report.md. Delete this section otherwise. -->

| Metric                                             | Before | After | Δ   |
| -------------------------------------------------- | ------ | ----- | --- |
| Joint accuracy (95% CI lower bound)                |        |       |     |
| `owner` accuracy                                   |        |       |     |
| `determinism` accuracy                             |        |       |     |
| Hard-quadrant recall (`app_code` + `intermittent`) |        |       |     |
| Self-consistency                                   |        |       |     |
| Cost per fixture                                   |        |       |     |
| vs. baseline heuristic                             |        |       |     |

<!-- Prompt version: -->
<!-- Dataset revision: -->

## Checklist

- [ ] Title is a valid Conventional Commit with a scope from `docs/branching-strategy.md`
- [ ] Linked to exactly one issue with `Closes #N`
- [ ] `npm run lint && npm run typecheck` clean
- [ ] Tests added or updated; failure modes covered, not just the happy path
- [ ] Docs / ADR updated if a contract, behaviour, or decision changed
- [ ] Under ~400 changed lines, or the reason it cannot be split is stated below

## Guardrail check

<!-- Required for any change under agents/. These are enforced properties, not aspirations. -->

- [ ] No agent gained filesystem-write capability
- [ ] No agent gained git-write capability
- [ ] Untrusted input (test titles, error messages, diffs) is still delimited and length-capped
- [ ] Agent output is still schema-validated and escaped before rendering
- [ ] Token budget still bounds the run

## Notes for the reviewer

<!-- What you are unsure about. Where you want the review to focus. What you deliberately left out. -->
