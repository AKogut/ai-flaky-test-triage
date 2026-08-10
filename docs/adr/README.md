# Architecture Decision Records

Decisions that were not obvious, that cost something to reverse, or that a reader would otherwise
have to reconstruct from the code. Format: [MADR](https://adr.github.io/madr/).

ADRs are immutable once accepted. A changed decision means a new ADR that supersedes the old one
and links back to it.

| #                                                         | Title                                              | Status   |
| --------------------------------------------------------- | -------------------------------------------------- | -------- |
| [0001](0001-single-repo-no-persistent-services.md)        | Single repository, no persistent services          | Accepted |
| [0002](0002-two-axis-classification-taxonomy.md)          | Two-axis classification taxonomy                   | Accepted |
| [0003](0003-dataset-first-milestone-ordering.md)          | Dataset-first milestone ordering                   | Accepted |
| [0004](0004-history-persistence-via-ci-cache.md)          | History persistence via CI cache, main-only writes | Accepted |
| [0005](0005-replay-cassettes-for-credential-free-demo.md) | Replay cassettes for a credential-free demo        | Accepted |
| [0006](0006-single-shot-agents-no-loop.md)                | Single-shot agents, no agentic loop                | Accepted |
| [0007](0007-no-github-app-no-pull-request-target.md)      | No GitHub App, no `pull_request_target`            | Accepted |

## When an ADR is required

- Changing the agent architecture (call count, loop structure, tool surface)
- Changing the classification schema or the labelling rules
- Changing how state persists between runs
- Removing, weakening, or adding a guardrail
- Adopting or rejecting an experiment (`type: experiment` issues)

## Template

Copy [`0000-template.md`](0000-template.md).
