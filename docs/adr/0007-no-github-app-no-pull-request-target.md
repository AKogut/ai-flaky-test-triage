# ADR-0007: No GitHub App, no `pull_request_target`

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** @AKogut
- **Related:** [`docs/limitations-and-guardrails.md`](../limitations-and-guardrails.md)

## Context

The pipeline needs to post one comment on a pull request. Two friction points push toward heavier
solutions:

1. A GitHub App gives a distinct bot identity and finer-grained permissions — at the cost of
   registration, a private key, an installation flow, and token minting.
2. Workflows triggered by `pull_request` from a **fork** receive no secrets, so
   `ANTHROPIC_API_KEY` is absent and the agent stage cannot run. The widely-copied workaround is
   `pull_request_target`, which runs the workflow in the base repository's context with secrets
   available.

That workaround is a well-documented privilege-escalation vector. Combined with checking out the
PR head — which any workflow that wants to analyse the change must do — it executes attacker-
controlled code with a write-scoped token and repository secrets in the environment.

## Decision

Comments are posted by an ordinary `pull_request` workflow step using `actions/github-script` and
the built-in `GITHUB_TOKEN`, scoped to `pull-requests: write, contents: read`.

`pull_request_target` is not used anywhere in this repository.

Fork PRs are handled by **degrading, not escalating**: with no API key, the pipeline runs the
baseline heuristic only, and the comment states plainly that AI classification was skipped because
fork pull requests do not receive secrets.

## Options considered

### Option A — GitHub App

- **Pros:** distinct bot identity; scoped installation permissions; works across repositories.
- **Cons:** registration, private key storage, installation token exchange — infrastructure this
  project explicitly avoids (ADR-0001); solves a multi-repository problem that does not exist here.

### Option B — `pull_request_target` + head checkout

- **Pros:** full pipeline on fork PRs.
- **Cons:** runs untrusted code with secrets and a write-scoped token. Not an acceptable trade for
  a nicer comment on a fork PR of a portfolio project.

### Option C — `pull_request` + `GITHUB_TOKEN`, degrade on forks (chosen)

- **Pros:** zero setup; least privilege by default; the degradation path is honest and visible;
  the security posture becomes a documented feature rather than an unexamined default.
- **Cons:** fork PRs get heuristic-only output; the comment is attributed to `github-actions[bot]`
  rather than a branded identity.

### Option D — Two-workflow pattern (`workflow_run` consuming an artifact)

- **Pros:** a recognised safe pattern for privileged work on fork PR output.
- **Cons:** two workflows, artifact plumbing, and a second class of failure to debug — real
  complexity to buy AI classification on fork PRs, which for this repository is close to zero
  value.

## Consequences

### Positive

- No credentials to register, store, or rotate beyond one API key on the repository.
- Least-privilege token by construction; the workflow cannot approve or merge its own PRs.
- The fork degradation path forces the baseline heuristic to be genuinely useful on its own — a
  good constraint, since the baseline is also the eval control.

### Negative / accepted costs

- Reduced output quality on fork PRs.
- Comments come from `github-actions[bot]`, which is less distinctive in a demo screenshot.

### What would make us revisit this

Meaningful outside contribution volume where heuristic-only feedback on fork PRs becomes a real
limitation. Option D would then be the route — never Option B.
