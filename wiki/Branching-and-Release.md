# Branching and Release

> Normative version, including the full scope list and commit examples:
> [`docs/branching-strategy.md`](https://github.com/AKogut/ai-flaky-test-triage/blob/main/docs/branching-strategy.md).

## Model

Trunk-based. `main` is always releasable; everything else is a short-lived branch that exists for
hours or days. No `develop`, no release branches, no `staging` — GitFlow's ceremony buys nothing on
a project whose CI takes minutes.

## Branches

```
<type>/<issue-number>-<short-kebab-summary>

feat/42-triage-agent-schema
fix/57-history-atomic-write
exp/61-multistep-agent-ablation
```

Prefixes: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `exp`.

The issue number makes the branch self-linking in the UI and makes a stale branch traceable to
closed work six months later.

**Special branches.** `main` is protected — no direct pushes, no force-push, no deletion.
`flakemetry-history` is machine-written and excluded from CI; humans do not commit there.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint via a Husky
hook, so a malformed message fails locally rather than in review. Scopes are restricted to a list —
a free-form scope field degrades into noise within a month, and the changelog groups by scope.

**One rule that is specific to this project: prompt changes are never `chore`.** A prompt edit
changes behaviour and must be `feat` or `fix`, with the evaluation delta in the pull-request
description. Prompts are code.

## Pull requests

Required before merge:

1. Green CI — lint, typecheck, unit, e2e, contract
2. Green eval gate when the change touches `agents/`, `eval/`, or `prompts/`
3. A description that says **how the change was verified**, not that tests pass
4. The before/after eval table for any prompt or agent change
5. No unresolved threads

Target under ~400 changed lines. Draft pull requests are opened early on purpose: CI runs, the eval
delta becomes visible, and the work is still cheap to change.

**Squash merge only.** One issue → one branch → one commit on `main`. The branch's messy history
stays in the pull request where it is useful and out of `main` where it is not. The squash subject
must itself be a valid Conventional Commit, because release notes are generated from `main`.

## Reviews

A single maintainer, so `CODEOWNERS` is routing rather than a gate, and the self-review checklist in
the pull-request template is the real control. Reviews look, in order, at: does the eval move; is
the guardrail still enforced; is it covered by a test; is it the smallest change that works.

Changes under `agents/` additionally carry a guardrail checklist — no new write capability, untrusted
input still delimited and capped, output still schema-validated and escaped, budget still bounding
the run.

## Releases

SemVer tags cut from `main`. Pre-1.0 the public surface is the CLI script contract and the
`analysis.json` / fixture schemas; both are consumed by committed data, so changing them is
breaking.

Release notes carry the generated changelog **plus the current headline evaluation numbers**. That
is unusual and deliberate: the version number describes the software, the accuracy figure describes
how much to trust it, and publishing one without the other is half a release note.

`v1.0.0` means the Definition of Done in the README holds end to end on a clean clone. It does not
mean the project is finished.

## Issues

```
Backlog → Ready → In progress → In review → Done
```

Every issue carries one `type:`, one `area:`, one `priority:`, one `status:` label and a milestone.
Every pull request closes exactly one issue.

Experiments (`type: experiment`) may close as **not adopted** — the finding is the deliverable, and
if it changed a decision it also produces an ADR.

## Architecture decision records

Required for changes to the agent architecture, the classification schema, the persistence approach,
or any guardrail. MADR format, in
[`docs/adr/`](https://github.com/AKogut/ai-flaky-test-triage/tree/main/docs/adr).

ADRs are **immutable once accepted**. A changed decision is a new ADR that supersedes the old one
and links back — the reasoning that turned out to be wrong is the interesting part and is not
edited away.

See [Decision Records](Decision-Records).
