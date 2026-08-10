# Security policy

## Scope

This repository contains a CI-only analysis pipeline and a deliberately minimal demo application.
It hosts no service, stores no user data, and exposes no network endpoint outside a local dev
server. The security surface is correspondingly narrow, but not empty.

## Reporting

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/AKogut/ai-flaky-test-triage/security/advisories/new)
rather than a public issue. Expect an initial response within 7 days.

## What is in scope

- Anything allowing a pull request to obtain repository secrets or a write-scoped token.
- Prompt injection that escalates beyond a wrong label — i.e. causes the pipeline to _do_
  something, rather than _say_ something wrong.
- Paths by which an agent could write to the filesystem, push to git, or approve/merge a PR.
- Leakage of secrets into prompts, logs, spans, or the posted PR comment.
- Dependency vulnerabilities reachable from the pipeline's execution path.

## What is out of scope

- **The classifier being wrong.** Measured, published in `eval/report.md`, expected.
- **Prompt injection that only produces a misleading comment.** Documented as the accepted impact
  ceiling in [`docs/limitations-and-guardrails.md`](docs/limitations-and-guardrails.md). Nothing
  downstream executes agent output.
- **The TaskFlow demo app.** It exists to fail tests. It has no auth, no authorisation, and is not
  intended to be deployed. Findings against it are not vulnerabilities in this project.
- Vulnerabilities requiring push access to the repository.

## Design decisions that are security decisions

- **`pull_request_target` is not used.** It would run untrusted code with secrets and a
  write-scoped token. See [ADR-0007](docs/adr/0007-no-github-app-no-pull-request-target.md).
- **Fork PRs degrade rather than escalate.** No secrets means baseline-heuristic output, stated in
  the comment.
- **Least-privilege token.** `pull-requests: write`, `contents: read`. No `actions: write`, no
  `packages`, no org scope.
- **Agents have no tools.** Structured output only. The write capabilities they are promised not
  to have are capabilities they were never given.
- **Untrusted text is data, not instruction.** Test titles, error messages, source, and diff hunks
  are delimited, length-capped, and introduced as data; output is schema-constrained and escaped
  before rendering.

## Data egress

One genuine egress path: source snippets and diff hunks from the checkout are sent to the
Anthropic API during the agent stage. A best-effort secret-pattern scrub runs over that content
first, but it is not a guarantee. Anyone enabling the agent job on a private fork should
understand this before adding an API key.
